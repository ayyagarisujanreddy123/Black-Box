import { randomUUID } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { Transform } from "node:stream";

import {
  RawExchangeSchema,
  SessionSchema,
  type RawExchangeOutcome,
  type SafeHeaders,
} from "@blackbox/protocol";
import { ChunkManifestBuilder, type BlackBoxStorage } from "@blackbox/storage";

import { BoundedByteCapture, CaptureMemoryBudget } from "./capture.js";
import {
  resolveProxyConfiguration,
  type ProxyConfiguration,
  type ProxyConfigurationInput,
} from "./config.js";
import { headersForForwarding, headersForPersistence } from "./headers.js";

const INTERNAL_SESSION_HEADER = "x-blackbox-session";

export interface RecorderProxyOptions extends ProxyConfigurationInput {
  readonly storage: BlackBoxStorage;
  readonly now?: () => Date;
  readonly sensitiveHeaderNames?: readonly string[];
}

export interface ProxyAddress {
  readonly host: string;
  readonly port: number;
  readonly origin: string;
}

export interface ProxyHealth {
  readonly status: "healthy" | "degraded";
  readonly activeRequests: number;
  readonly requestsStarted: number;
  readonly requestsCompleted: number;
  readonly captureFailures: number;
  readonly droppedCaptureBytes: number;
  readonly droppedManifestEntries: number;
  readonly clientDisconnects: number;
  readonly upstreamFailures: number;
  readonly lastError?: string;
}

interface MutableProxyHealth {
  activeRequests: number;
  requestsStarted: number;
  requestsCompleted: number;
  captureFailures: number;
  droppedCaptureBytes: number;
  droppedManifestEntries: number;
  clientDisconnects: number;
  upstreamFailures: number;
  lastError?: string;
}

interface RequestTarget {
  readonly path: string;
  readonly query: Record<string, string[]>;
  readonly upstreamUrl: URL;
}

interface EvidenceState {
  readonly id: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly startedAt: string;
  readonly requestHeaders: SafeHeaders;
  readonly requestCapture: BoundedByteCapture;
  readonly responseCapture: BoundedByteCapture;
  readonly manifest: ChunkManifestBuilder;
  requestEnded: boolean;
  responseEnded: boolean;
  firstByteAt?: string;
  responseStatus?: number;
  responseHeaders?: SafeHeaders;
  rawStarted: boolean;
}

function protocolForPath(path: string) {
  if (path === "/v1/responses") {
    return "openai.responses" as const;
  }
  if (path === "/v1/chat/completions") {
    return "openai.chat-completions" as const;
  }
  return "unknown-openai-compatible" as const;
}

function parseRequestTarget(
  requestUrl: string | undefined,
  upstream: URL,
): RequestTarget {
  const rawTarget =
    requestUrl === undefined || requestUrl === "*" ? "/" : requestUrl;
  const parsed = new URL(rawTarget, "http://blackbox.invalid");
  const query: Record<string, string[]> = {};
  for (const [name, value] of parsed.searchParams) {
    (query[name] ??= []).push(value);
  }
  return {
    path: parsed.pathname,
    query,
    upstreamUrl: new URL(`${parsed.pathname}${parsed.search}`, upstream),
  };
}

function headerValue(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export class RecorderProxy {
  readonly configuration: ProxyConfiguration;
  private readonly server: Server;
  private readonly budget: CaptureMemoryBudget;
  private readonly pendingJournals = new Set<Promise<void>>();
  private readonly defaultSessionId = `session-proxy-${randomUUID()}`;
  private readonly healthState: MutableProxyHealth = {
    activeRequests: 0,
    requestsStarted: 0,
    requestsCompleted: 0,
    captureFailures: 0,
    droppedCaptureBytes: 0,
    droppedManifestEntries: 0,
    clientDisconnects: 0,
    upstreamFailures: 0,
  };
  private addressValue?: ProxyAddress;

  constructor(private readonly options: RecorderProxyOptions) {
    this.configuration = resolveProxyConfiguration(options);
    this.budget = new CaptureMemoryBudget(
      this.configuration.captureQueueMaxBytes,
    );
    this.server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.server.on("upgrade", (_request, socket) => {
      socket.end(
        "HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
    });
    this.server.on("clientError", (_error, socket) => {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    });
  }

  async start(): Promise<ProxyAddress> {
    if (this.addressValue !== undefined) {
      return this.addressValue;
    }

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(
        this.configuration.listenPort,
        this.configuration.listenHost,
      );
    });

    const address = this.server.address() as AddressInfo;
    const displayHost =
      address.family === "IPv6" ? `[${address.address}]` : address.address;
    this.addressValue = {
      host: address.address,
      port: address.port,
      origin: `http://${displayHost}:${address.port}`,
    };
    return this.addressValue;
  }

  address(): ProxyAddress | undefined {
    return this.addressValue;
  }

  health(): ProxyHealth {
    return {
      status:
        this.healthState.captureFailures > 0 ||
        this.healthState.droppedCaptureBytes > 0 ||
        this.healthState.droppedManifestEntries > 0
          ? "degraded"
          : "healthy",
      activeRequests: this.healthState.activeRequests,
      requestsStarted: this.healthState.requestsStarted,
      requestsCompleted: this.healthState.requestsCompleted,
      captureFailures: this.healthState.captureFailures,
      droppedCaptureBytes: this.healthState.droppedCaptureBytes,
      droppedManifestEntries: this.healthState.droppedManifestEntries,
      clientDisconnects: this.healthState.clientDisconnects,
      upstreamFailures: this.healthState.upstreamFailures,
      ...(this.healthState.lastError === undefined
        ? {}
        : { lastError: this.healthState.lastError }),
    };
  }

  async flush(): Promise<void> {
    await Promise.all([...this.pendingJournals]);
  }

  async close(graceMilliseconds = 5_000): Promise<void> {
    if (this.server.listening) {
      const closePromise = new Promise<void>((resolve, reject) => {
        this.server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
      const timer = setTimeout(() => {
        this.server.closeAllConnections();
      }, graceMilliseconds);
      timer.unref();
      try {
        await closePromise;
      } finally {
        clearTimeout(timer);
      }
    }
    delete this.addressValue;
    await this.flush();
  }

  private nowIso(): string {
    return (this.options.now ?? (() => new Date()))().toISOString();
  }

  private ensureSession(request: IncomingMessage): string {
    const sessionId =
      headerValue(request.headers, INTERNAL_SESSION_HEADER) ??
      this.defaultSessionId;
    if (this.options.storage.sessions.get(sessionId) === undefined) {
      this.options.storage.sessions.create(
        SessionSchema.parse({
          schemaVersion: 1,
          id: sessionId,
          startedAt: this.nowIso(),
          status: "active",
          captureLevel: "api",
          models: [],
          upstreamOrigin: this.configuration.upstream.origin,
          tags: [],
          counts: {
            events: 0,
            errors: 0,
            inputTokens: null,
            outputTokens: null,
          },
          metadata: {
            sessionization:
              headerValue(request.headers, INTERNAL_SESSION_HEADER) ===
              undefined
                ? "proxy-default"
                : "explicit-header",
          },
        }),
      );
    }
    return sessionId;
  }

  private createEvidenceState(
    request: IncomingMessage,
    target: RequestTarget,
  ): EvidenceState {
    const sessionId = this.ensureSession(request);
    const sequence = this.options.storage.sequences.reserve(sessionId)[0];
    if (sequence === undefined) {
      throw new Error(`Failed to allocate sequence for ${sessionId}.`);
    }
    const id = `exchange-${randomUUID()}`;
    const startedAt = this.nowIso();
    const state: EvidenceState = {
      id,
      sessionId,
      sequence,
      startedAt,
      requestHeaders: headersForPersistence(
        request.headers,
        this.options.sensitiveHeaderNames,
      ),
      requestCapture: new BoundedByteCapture(
        this.configuration.maxRequestBodyBytes,
        this.budget,
      ),
      responseCapture: new BoundedByteCapture(
        this.configuration.maxResponseBodyBytes,
        this.budget,
      ),
      manifest: new ChunkManifestBuilder(
        id,
        process.hrtime.bigint(),
        this.configuration.maxChunkManifestEntries,
      ),
      requestEnded: false,
      responseEnded: false,
      rawStarted: false,
    };
    this.options.storage.rawExchanges.begin(
      RawExchangeSchema.parse({
        schemaVersion: 1,
        id,
        sessionId,
        sequence,
        protocol: protocolForPath(target.path),
        method: request.method ?? "GET",
        path: target.path,
        query: target.query,
        requestHeaders: state.requestHeaders,
        startedAt,
        outcome: "capture-incomplete",
        parseStatus: "pending",
        capture: {
          requestComplete: false,
          responseComplete: false,
          droppedRequestBytes: 0,
          droppedResponseBytes: 0,
        },
      }),
    );
    state.rawStarted = true;
    return state;
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    this.healthState.activeRequests += 1;
    this.healthState.requestsStarted += 1;
    const target = parseRequestTarget(request.url, this.configuration.upstream);
    let state: EvidenceState;
    try {
      state = this.createEvidenceState(request, target);
    } catch (error: unknown) {
      this.recordCaptureFailure(error);
      const fallbackId = `exchange-unrecorded-${randomUUID()}`;
      state = {
        id: fallbackId,
        sessionId: this.defaultSessionId,
        sequence: 1,
        startedAt: this.nowIso(),
        requestHeaders: {},
        requestCapture: new BoundedByteCapture(
          this.configuration.maxRequestBodyBytes,
          this.budget,
        ),
        responseCapture: new BoundedByteCapture(
          this.configuration.maxResponseBodyBytes,
          this.budget,
        ),
        manifest: new ChunkManifestBuilder(
          fallbackId,
          process.hrtime.bigint(),
          this.configuration.maxChunkManifestEntries,
        ),
        requestEnded: false,
        responseEnded: false,
        rawStarted: false,
      };
    }

    let terminal = false;
    let upstreamResponse: IncomingMessage | undefined;

    const finish = (transportOutcome: RawExchangeOutcome) => {
      if (terminal) {
        return;
      }
      terminal = true;
      this.healthState.activeRequests -= 1;
      this.healthState.requestsCompleted += 1;
      if (transportOutcome === "client-disconnected") {
        this.healthState.clientDisconnects += 1;
      } else if (
        transportOutcome === "upstream-disconnected" ||
        transportOutcome === "upstream-error" ||
        transportOutcome === "timeout"
      ) {
        this.healthState.upstreamFailures += 1;
      }
      const journal = this.persistEvidence(state, transportOutcome).finally(
        () => {
          this.pendingJournals.delete(journal);
        },
      );
      this.pendingJournals.add(journal);
    };

    const requestTee = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        state.requestCapture.append(chunk);
        state.manifest.append("request", chunk);
        callback(null, chunk);
      },
    });
    requestTee.on("error", (error) => {
      upstreamRequest?.destroy(error);
    });
    request.on("end", () => {
      state.requestEnded = true;
    });
    request.on("aborted", () => {
      finish("client-disconnected");
      upstreamRequest?.destroy();
      upstreamResponse?.destroy();
    });
    response.on("close", () => {
      if (!response.writableEnded) {
        finish("client-disconnected");
        upstreamRequest?.destroy();
        upstreamResponse?.destroy();
      }
    });

    const forwardedHeaders = headersForForwarding(request.headers, {
      dropHost: true,
      dropNames: [INTERNAL_SESSION_HEADER],
    });
    const transport =
      target.upstreamUrl.protocol === "https:" ? httpsRequest : httpRequest;
    let upstreamTimedOut = false;
    const upstreamRequest = transport(
      target.upstreamUrl,
      { method: request.method, headers: forwardedHeaders },
      (receivedResponse) => {
        upstreamResponse = receivedResponse;
        state.firstByteAt = this.nowIso();
        state.responseStatus = receivedResponse.statusCode ?? 502;
        state.responseHeaders = headersForPersistence(
          receivedResponse.headers,
          this.options.sensitiveHeaderNames,
        );
        const responseHeaders = headersForForwarding(receivedResponse.headers);
        response.writeHead(
          receivedResponse.statusCode ?? 502,
          receivedResponse.statusMessage,
          responseHeaders,
        );
        const responseTee = new Transform({
          transform: (chunk: Buffer, _encoding, callback) => {
            state.responseCapture.append(chunk);
            state.manifest.append("response", chunk);
            callback(null, chunk);
          },
        });
        responseTee.on("error", (error) => {
          receivedResponse.destroy(error);
        });
        receivedResponse.on("end", () => {
          state.responseEnded = true;
        });
        receivedResponse.on("aborted", () => {
          finish("upstream-disconnected");
          response.destroy();
        });
        receivedResponse.on("error", () => {
          finish("upstream-disconnected");
          response.destroy();
        });
        response.on("finish", () => {
          finish("completed");
        });
        receivedResponse.pipe(responseTee).pipe(response);
      },
    );
    if (this.configuration.upstreamTimeoutMs !== undefined) {
      upstreamRequest.setTimeout(this.configuration.upstreamTimeoutMs, () => {
        upstreamTimedOut = true;
        upstreamRequest.destroy(new Error("Black Box upstream timeout"));
      });
    }
    upstreamRequest.on("error", (error) => {
      if (!terminal) {
        if (!response.headersSent) {
          const body = Buffer.from(
            JSON.stringify({ error: { type: "blackbox_upstream_error" } }),
          );
          state.responseStatus = 502;
          state.responseHeaders = { "content-type": ["application/json"] };
          response.writeHead(502, {
            "content-type": "application/json",
            "content-length": body.length,
          });
          response.end(body);
        } else {
          response.destroy(error);
        }
        finish(upstreamTimedOut ? "timeout" : "upstream-error");
      }
    });
    request.pipe(requestTee).pipe(upstreamRequest);
  }

  private async persistEvidence(
    state: EvidenceState,
    transportOutcome: RawExchangeOutcome,
  ): Promise<void> {
    try {
      if (!state.rawStarted) {
        return;
      }

      let requestBodyRef;
      let responseBodyRef;
      let streamManifestRef;
      let persistenceFailed = false;
      try {
        requestBodyRef = await this.options.storage.blobs.put(
          state.requestCapture.bytes(),
          {
            mediaType: "application/octet-stream",
            truncated: state.requestCapture.droppedBytes > 0,
          },
        );
      } catch (error: unknown) {
        persistenceFailed = true;
        this.recordCaptureFailure(error);
      }
      if (state.firstByteAt !== undefined) {
        try {
          responseBodyRef = await this.options.storage.blobs.put(
            state.responseCapture.bytes(),
            {
              mediaType: "application/octet-stream",
              truncated: state.responseCapture.droppedBytes > 0,
            },
          );
        } catch (error: unknown) {
          persistenceFailed = true;
          this.recordCaptureFailure(error);
        }
      }
      try {
        streamManifestRef = await state.manifest.persist(
          this.options.storage.blobs,
          transportOutcome === "completed",
        );
      } catch (error: unknown) {
        persistenceFailed = true;
        this.recordCaptureFailure(error);
      }

      const droppedRequestBytes =
        state.requestCapture.droppedBytes +
        (requestBodyRef === undefined ? state.requestCapture.retainedBytes : 0);
      const droppedResponseBytes =
        state.responseCapture.droppedBytes +
        (state.firstByteAt !== undefined && responseBodyRef === undefined
          ? state.responseCapture.retainedBytes
          : 0);
      const captureIncomplete =
        persistenceFailed ||
        state.manifest.truncated ||
        droppedRequestBytes > 0 ||
        droppedResponseBytes > 0;
      this.healthState.droppedCaptureBytes +=
        state.requestCapture.droppedBytes + state.responseCapture.droppedBytes;
      this.healthState.droppedManifestEntries +=
        state.manifest.droppedEntryCount;

      const startedExchange = this.options.storage.rawExchanges.getRequired(
        state.id,
      );
      this.options.storage.rawExchanges.finalize(
        RawExchangeSchema.parse({
          schemaVersion: 1,
          id: state.id,
          sessionId: state.sessionId,
          sequence: state.sequence,
          protocol: startedExchange.protocol,
          method: startedExchange.method,
          path: startedExchange.path,
          query: startedExchange.query,
          requestHeaders: state.requestHeaders,
          ...(requestBodyRef === undefined ? {} : { requestBodyRef }),
          ...(state.responseStatus === undefined
            ? {}
            : { responseStatus: state.responseStatus }),
          ...(state.responseHeaders === undefined
            ? {}
            : { responseHeaders: state.responseHeaders }),
          ...(responseBodyRef === undefined ? {} : { responseBodyRef }),
          ...(streamManifestRef === undefined ? {} : { streamManifestRef }),
          startedAt: state.startedAt,
          ...(state.firstByteAt === undefined
            ? {}
            : { firstByteAt: state.firstByteAt }),
          endedAt: this.nowIso(),
          outcome: captureIncomplete ? "capture-incomplete" : transportOutcome,
          parseStatus:
            captureIncomplete || transportOutcome !== "completed"
              ? "skipped"
              : "pending",
          capture: {
            requestComplete: state.requestEnded && droppedRequestBytes === 0,
            responseComplete: state.responseEnded && droppedResponseBytes === 0,
            droppedRequestBytes,
            droppedResponseBytes,
          },
        }),
      );
    } catch (error: unknown) {
      this.recordCaptureFailure(error);
    } finally {
      state.requestCapture.release();
      state.responseCapture.release();
    }
  }

  private recordCaptureFailure(error: unknown): void {
    this.healthState.captureFailures += 1;
    this.healthState.lastError =
      error instanceof Error ? error.message : String(error);
  }
}
