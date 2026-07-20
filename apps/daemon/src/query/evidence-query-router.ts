import type { IncomingMessage, ServerResponse } from "node:http";

import {
  EvidenceSourceSchema,
  LiveEventResumeQuerySchema,
  QueryErrorSchema,
  type EvidenceSource,
} from "@blackbox/protocol";
import { z } from "zod";

import type { DaemonStatus } from "../lifecycle/status.js";
import {
  EvidencePayloadTooLargeError,
  EvidenceQueryNotFoundError,
  type EvidenceQueryService,
} from "./evidence-query-service.js";
import { sendInertPayload, sendJson } from "./http-response.js";
import {
  LiveEventStreamer,
  LiveEventStreamCapacityError,
  type LiveEventStreamConfiguration,
} from "./live-event-stream.js";

const MaximumPayloadBytesSchema = z
  .number()
  .int()
  .positive()
  .max(1024 * 1024 * 1024);

export interface EvidenceQueryRouterOptions {
  readonly query: EvidenceQueryService;
  readonly status: () => DaemonStatus | Promise<DaemonStatus>;
  readonly maximumPayloadBytes?: number;
  readonly liveStream?: LiveEventStreamConfiguration;
}

class InvalidQueryRequestError extends Error {}

function decoded(segment: string): string {
  try {
    const value = decodeURIComponent(segment);
    if (value.length === 0) {
      throw new Error("empty path segment");
    }
    return value;
  } catch (error: unknown) {
    throw new InvalidQueryRequestError("Invalid encoded path.", {
      cause: error,
    });
  }
}

function assertAllowedParameters(url: URL, allowed: ReadonlySet<string>): void {
  for (const name of url.searchParams.keys()) {
    if (!allowed.has(name)) {
      throw new InvalidQueryRequestError(`Unknown query parameter ${name}.`);
    }
  }
}

function optionalParameter(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) {
    throw new InvalidQueryRequestError(
      `Query parameter ${name} may only appear once.`,
    );
  }
  const value = values[0];
  return value === undefined || value.length === 0 ? undefined : value;
}

function optionalInteger(url: URL, name: string): number | undefined {
  const value = optionalParameter(url, name);
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/u.test(value)) {
    throw new InvalidQueryRequestError(
      `Query parameter ${name} must be an integer.`,
    );
  }
  return Number(value);
}

function optionalBoolean(url: URL, name: string): boolean | undefined {
  const value = optionalParameter(url, name);
  if (value === undefined) {
    return undefined;
  }
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  throw new InvalidQueryRequestError(
    `Query parameter ${name} must be true or false.`,
  );
}

function optionalEvidenceSource(url: URL): EvidenceSource | undefined {
  const value = optionalParameter(url, "source");
  return value === undefined ? undefined : EvidenceSourceSchema.parse(value);
}

function lastEventSequence(request: IncomingMessage): number | undefined {
  const header = request.headers["last-event-id"];
  if (header === undefined) {
    return undefined;
  }
  if (Array.isArray(header) || !/^\d+$/u.test(header)) {
    throw new InvalidQueryRequestError("Last-Event-ID must be an integer.");
  }
  return Number(header);
}

function requireGet(
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  request.resume();
  if (request.method === "GET") {
    return true;
  }
  sendJson(
    response,
    405,
    QueryErrorSchema.parse({ error: "method_not_allowed" }),
    { allow: "GET" },
  );
  return false;
}

export class EvidenceQueryRouter {
  private readonly maximumPayloadBytes: number;
  private readonly liveEvents: LiveEventStreamer;

  constructor(private readonly options: EvidenceQueryRouterOptions) {
    this.maximumPayloadBytes = MaximumPayloadBytesSchema.parse(
      options.maximumPayloadBytes ?? 64 * 1024 * 1024,
    );
    this.liveEvents = new LiveEventStreamer(
      options.query,
      options.liveStream ?? {},
    );
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const encodedSegments = url.pathname.split("/").filter(Boolean);
    if (encodedSegments[0] !== "v1") {
      return false;
    }
    const route = encodedSegments[1];
    if (
      route === undefined ||
      !new Set(["health", "sessions", "events", "payloads"]).has(route)
    ) {
      return false;
    }
    if (!requireGet(request, response)) {
      return true;
    }

    try {
      if (route === "health" && encodedSegments.length === 2) {
        assertAllowedParameters(url, new Set());
        sendJson(response, 200, await this.options.status());
        return true;
      }
      if (route === "sessions" && encodedSegments.length === 2) {
        assertAllowedParameters(
          url,
          new Set(["limit", "cursor", "include_internal"]),
        );
        const limit = optionalInteger(url, "limit");
        const cursor = optionalParameter(url, "cursor");
        const includeInternal = optionalBoolean(url, "include_internal");
        sendJson(
          response,
          200,
          this.options.query.listSessions({
            ...(limit === undefined ? {} : { limit }),
            ...(cursor === undefined ? {} : { cursor }),
            ...(includeInternal === undefined ? {} : { includeInternal }),
          }),
        );
        return true;
      }
      if (route === "sessions" && encodedSegments.length >= 3) {
        const sessionId = decoded(encodedSegments[2] as string);
        if (encodedSegments.length === 3) {
          assertAllowedParameters(url, new Set());
          sendJson(response, 200, this.options.query.getSession(sessionId));
          return true;
        }
        const childRoute = encodedSegments[3];
        if (encodedSegments.length !== 4) {
          return false;
        }
        if (childRoute === "events") {
          assertAllowedParameters(
            url,
            new Set([
              "limit",
              "cursor",
              "type",
              "source",
              "occurred_after",
              "occurred_before",
            ]),
          );
          const limit = optionalInteger(url, "limit");
          const cursor = optionalParameter(url, "cursor");
          const type = optionalParameter(url, "type");
          const source = optionalEvidenceSource(url);
          const occurredAfter = optionalParameter(url, "occurred_after");
          const occurredBefore = optionalParameter(url, "occurred_before");
          sendJson(
            response,
            200,
            this.options.query.listEvents(sessionId, {
              ...(limit === undefined ? {} : { limit }),
              ...(cursor === undefined ? {} : { cursor }),
              ...(type === undefined ? {} : { type }),
              ...(source === undefined ? {} : { source }),
              ...(occurredAfter === undefined ? {} : { occurredAfter }),
              ...(occurredBefore === undefined ? {} : { occurredBefore }),
            }),
          );
          return true;
        }
        if (childRoute === "files") {
          assertAllowedParameters(url, new Set(["limit", "cursor"]));
          const limit = optionalInteger(url, "limit");
          const cursor = optionalParameter(url, "cursor");
          sendJson(
            response,
            200,
            this.options.query.listFileChanges(sessionId, {
              ...(limit === undefined ? {} : { limit }),
              ...(cursor === undefined ? {} : { cursor }),
            }),
          );
          return true;
        }
        if (childRoute === "search") {
          assertAllowedParameters(url, new Set(["q", "limit"]));
          const limit = optionalInteger(url, "limit");
          sendJson(
            response,
            200,
            this.options.query.searchEvents(sessionId, {
              query: optionalParameter(url, "q") ?? "",
              ...(limit === undefined ? {} : { limit }),
            }),
          );
          return true;
        }
        if (childRoute === "live") {
          assertAllowedParameters(url, new Set(["after"]));
          const querySequence = optionalInteger(url, "after");
          const headerSequence = lastEventSequence(request);
          if (
            querySequence !== undefined &&
            headerSequence !== undefined &&
            querySequence !== headerSequence
          ) {
            throw new InvalidQueryRequestError(
              "The recovery cursors do not match.",
            );
          }
          const recovery = LiveEventResumeQuerySchema.parse({
            afterSequence: querySequence ?? headerSequence ?? 0,
          });
          await this.liveEvents.stream(
            request,
            response,
            sessionId,
            recovery.afterSequence,
          );
          return true;
        }
        return false;
      }
      if (route === "events" && encodedSegments.length >= 3) {
        const eventId = decoded(encodedSegments[2] as string);
        if (encodedSegments.length === 3) {
          assertAllowedParameters(url, new Set());
          sendJson(response, 200, this.options.query.getEvent(eventId));
          return true;
        }
        if (encodedSegments.length === 4 && encodedSegments[3] === "context") {
          assertAllowedParameters(url, new Set());
          sendJson(response, 200, await this.options.query.getContext(eventId));
          return true;
        }
        if (encodedSegments.length === 4 && encodedSegments[3] === "blame") {
          assertAllowedParameters(url, new Set());
          sendJson(response, 200, await this.options.query.getBlame(eventId));
          return true;
        }
        return false;
      }
      if (route === "payloads" && encodedSegments.length === 3) {
        assertAllowedParameters(url, new Set());
        const payload = await this.options.query.getPayload(
          decoded(encodedSegments[2] as string),
          this.maximumPayloadBytes,
        );
        sendInertPayload(response, payload.reference, payload.bytes);
        return true;
      }
      return false;
    } catch (error: unknown) {
      if (
        error instanceof InvalidQueryRequestError ||
        error instanceof RangeError ||
        error instanceof z.ZodError
      ) {
        sendJson(
          response,
          400,
          QueryErrorSchema.parse({
            error: "bad_request",
            message: "Invalid query path or parameters.",
          }),
        );
        return true;
      }
      if (error instanceof EvidenceQueryNotFoundError) {
        sendJson(response, 404, QueryErrorSchema.parse({ error: "not_found" }));
        return true;
      }
      if (error instanceof EvidencePayloadTooLargeError) {
        sendJson(
          response,
          413,
          QueryErrorSchema.parse({
            error: "payload_unavailable",
            message: error.message,
          }),
        );
        return true;
      }
      if (error instanceof LiveEventStreamCapacityError) {
        sendJson(
          response,
          503,
          QueryErrorSchema.parse({ error: "stream_capacity_exceeded" }),
          { "retry-after": "1" },
        );
        return true;
      }
      if (response.headersSent) {
        response.destroy();
        return true;
      }
      sendJson(
        response,
        500,
        QueryErrorSchema.parse({ error: "internal_query_error" }),
      );
      return true;
    }
  }
}
