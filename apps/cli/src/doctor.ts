import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { open, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  CorruptDaemonLockError,
  ensureInstallLayout,
  isLoopbackHost,
  isProcessAlive,
  readControlToken,
  readDaemonLockRecord,
  type DaemonLockRecord,
} from "@blackbox/daemon";

import type { ResolvedStartConfiguration } from "./configuration.js";
import { BLACK_BOX_VERSION } from "./version.js";

export type DoctorCheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  readonly id: string;
  readonly status: DoctorCheckStatus;
  readonly message: string;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly ok: boolean;
}

function mode(value: number): string {
  return (value & 0o777).toString(8).padStart(3, "0");
}

async function storageCheck(
  configuration: ResolvedStartConfiguration,
): Promise<DoctorCheck> {
  const { paths } = configuration;
  const probePath = join(
    paths.dataDirectory,
    `.doctor-${process.pid}-${Date.now()}.tmp`,
  );
  try {
    await ensureInstallLayout(paths);
    const handle = await open(probePath, "wx", 0o600);
    try {
      await handle.writeFile("blackbox-doctor\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const homeMode = mode((await stat(paths.homeDirectory)).mode);
    const dataMode = mode((await stat(paths.dataDirectory)).mode);
    if (homeMode !== "700" || dataMode !== "700") {
      return {
        id: "storage",
        status: "fail",
        message: `storage modes are home=${homeMode}, data=${dataMode}; expected 700`,
      };
    }
    return {
      id: "storage",
      status: "pass",
      message: `${paths.dataDirectory} is writable with private permissions`,
    };
  } catch (error: unknown) {
    return {
      id: "storage",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await rm(probePath, { force: true }).catch(() => undefined);
  }
}

async function tokenCheck(
  configuration: ResolvedStartConfiguration,
): Promise<DoctorCheck> {
  try {
    await readControlToken(configuration.paths.tokenPath);
    const tokenMode = mode((await stat(configuration.paths.tokenPath)).mode);
    return tokenMode === "600"
      ? {
          id: "control-token",
          status: "pass",
          message: "control token exists with mode 600",
        }
      : {
          id: "control-token",
          status: "fail",
          message: `control token mode is ${tokenMode}; expected 600`,
        };
  } catch (error: unknown) {
    const missing =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT";
    return {
      id: "control-token",
      status: missing ? "warn" : "fail",
      message: missing
        ? "not initialized; run blackbox init"
        : error instanceof Error
          ? error.message
          : String(error),
    };
  }
}

async function lockInspection(
  configuration: ResolvedStartConfiguration,
): Promise<{ check: DoctorCheck; record?: DaemonLockRecord }> {
  try {
    const record = await readDaemonLockRecord(configuration.paths.lockPath);
    if (record === undefined) {
      return {
        check: { id: "daemon-lock", status: "pass", message: "no daemon lock" },
      };
    }
    if (!isProcessAlive(record.pid)) {
      return {
        check: {
          id: "daemon-lock",
          status: "warn",
          message: `stale lock for dead PID ${record.pid}; start will recover it`,
        },
        record,
      };
    }
    return {
      check: {
        id: "daemon-lock",
        status: "pass",
        message: `active ${record.state} daemon at PID ${record.pid}`,
      },
      record,
    };
  } catch (error: unknown) {
    return {
      check: {
        id: "daemon-lock",
        status: error instanceof CorruptDaemonLockError ? "warn" : "fail",
        message:
          error instanceof Error
            ? error.message
            : `lock error: ${String(error)}`,
      },
    };
  }
}

function recordOwnsPort(
  record: DaemonLockRecord | undefined,
  origin: string | undefined,
  host: string,
  port: number,
): boolean {
  if (
    record === undefined ||
    origin === undefined ||
    !isProcessAlive(record.pid)
  ) {
    return false;
  }
  try {
    const parsed = new URL(origin);
    const originPort = Number(
      parsed.port || (parsed.protocol === "https:" ? 443 : 80),
    );
    return (
      originPort === port &&
      (parsed.hostname === host ||
        (isLoopbackHost(parsed.hostname) && isLoopbackHost(host)))
    );
  } catch {
    return false;
  }
}

async function portCheck(
  id: "proxy-port" | "control-port",
  host: string,
  port: number,
  owned: boolean,
): Promise<DoctorCheck> {
  if (owned) {
    return {
      id,
      status: "pass",
      message: `${host}:${port} is owned by the running Black Box daemon`,
    };
  }
  if (port === 0) {
    return {
      id,
      status: "pass",
      message: "configured for an automatically selected port",
    };
  }
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
    return { id, status: "pass", message: `${host}:${port} is available` };
  } catch (error: unknown) {
    return {
      id,
      status: "fail",
      message:
        error instanceof Error
          ? `${host}:${port} is unavailable: ${error.message}`
          : `${host}:${port} is unavailable`,
    };
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

async function upstreamCheck(upstream: URL): Promise<DoctorCheck> {
  const transport = upstream.protocol === "https:" ? httpsRequest : httpRequest;
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const request = transport(
        upstream,
        {
          method: "HEAD",
          headers: { "user-agent": `blackbox-doctor/${BLACK_BOX_VERSION}` },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.setTimeout(3_000, () => {
        request.destroy(new Error("upstream probe timed out"));
      });
      request.on("error", reject);
      request.end();
    });
    return {
      id: "upstream",
      status: "pass",
      message: `${upstream.origin} responded with HTTP ${status}`,
    };
  } catch (error: unknown) {
    return {
      id: "upstream",
      status: "fail",
      message:
        error instanceof Error
          ? `${upstream.origin} is unreachable: ${error.message}`
          : `${upstream.origin} is unreachable`,
    };
  }
}

function captureLimitCheck(
  configuration: ResolvedStartConfiguration,
): DoctorCheck {
  const proxy = configuration.proxy;
  const fullExchangeBytes =
    proxy.maxRequestBodyBytes + proxy.maxResponseBodyBytes;
  const constrained = proxy.captureQueueMaxBytes < fullExchangeBytes;
  return {
    id: "capture-limits",
    status: constrained ? "warn" : "pass",
    message:
      `queue=${proxy.captureQueueMaxBytes}B request=${proxy.maxRequestBodyBytes}B ` +
      `response=${proxy.maxResponseBodyBytes}B manifest=${proxy.maxChunkManifestEntries} entries ` +
      `store=${configuration.maximumStoredBytes === undefined ? "unbounded" : `${configuration.maximumStoredBytes}B`}` +
      (constrained ? "; a full-size exchange may be marked incomplete" : ""),
  };
}

export async function runDoctor(
  configuration: ResolvedStartConfiguration,
  websocketRequired: boolean,
): Promise<DoctorReport> {
  const lock = await lockInspection(configuration);
  const checks: DoctorCheck[] = [
    await storageCheck(configuration),
    await tokenCheck(configuration),
    lock.check,
  ];
  checks.push(
    await portCheck(
      "proxy-port",
      configuration.proxy.listenHost,
      configuration.proxy.listenPort,
      recordOwnsPort(
        lock.record,
        lock.record?.proxyOrigin,
        configuration.proxy.listenHost,
        configuration.proxy.listenPort,
      ),
    ),
    await portCheck(
      "control-port",
      configuration.controlHost,
      configuration.controlPort,
      recordOwnsPort(
        lock.record,
        lock.record?.controlOrigin,
        configuration.controlHost,
        configuration.controlPort,
      ),
    ),
    await upstreamCheck(configuration.proxy.upstream),
    captureLimitCheck(configuration),
    {
      id: "websocket-transport",
      status: websocketRequired ? "fail" : "warn",
      message:
        "WebSocket/Realtime proxying is unsupported; HTTP JSON and SSE are supported",
    },
  );
  return { checks, ok: !checks.some((check) => check.status === "fail") };
}
