import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  CorruptDaemonLockError,
  DaemonLock,
  ensureControlToken,
  ensureInstallLayout,
  isProcessAlive,
  readDaemonLockRecord,
  sessionScopedProxyBaseUrl,
  type DaemonLockRecord,
  type DaemonPaths,
  type DaemonStatus,
} from "@blackbox/daemon";
import { openBlackBoxStorage } from "@blackbox/storage";

import {
  CliUsageError,
  integerFlag,
  parseCliArguments,
  pathsFromFlags,
  resolveStartConfiguration,
  stringFlag,
  type ParsedCliArguments,
  type ResolvedStartConfiguration,
} from "./configuration.js";
import {
  requestDaemonShutdown,
  requestDaemonStatus,
} from "./control-client.js";
import { launchDaemonProcess, type DaemonLauncher } from "./daemon-launcher.js";
import { runDoctor, type DoctorReport } from "./doctor.js";
import {
  DEFAULT_PROCESS_RUN_CONFIGURATION,
  RunEventJournal,
} from "./run/run-event-journal.js";
import { WorkspaceObserver } from "./run/workspace-observer.js";

const HELP = `Black Box — the flight recorder for AI coding agents

Usage:
  blackbox init [--home PATH]
  blackbox start [--upstream URL] [--proxy-port PORT] [--control-port PORT]
  blackbox stop [--timeout-ms MS]
  blackbox status [--json]
  blackbox doctor [--upstream URL] [--websocket] [--json]
  blackbox sessions [--limit N] [--json]
  blackbox inspect <session-id> [--limit N] [--type EVENT_TYPE] [--json]
  blackbox run [--cwd PATH] -- <command...>

Common options:
  --home PATH                     Override the private Black Box data directory
  --help, -h                      Show this help

Start and doctor options:
  --upstream URL                  Provider origin (or BLACKBOX_UPSTREAM_URL)
  --proxy-host HOST               Proxy listener (default 127.0.0.1)
  --proxy-port PORT               Proxy port (default 4141; 0 selects one)
  --control-host HOST             Control listener (loopback only)
  --control-port PORT             Control port (default 4142; 0 selects one)
  --allow-non-loopback            Explicitly permit a non-loopback proxy
  --capture-queue-max-bytes N     Global in-memory capture bound
  --max-request-body-bytes N      Per-request capture bound
  --max-response-body-bytes N     Per-response capture bound
  --max-chunk-manifest-entries N  Per-exchange provenance entry bound
  --upstream-timeout-ms MS        Optional provider timeout

Inspection options:
  --limit N                       Bound sessions/events returned (default 100)
  --type EVENT_TYPE               Filter inspect output by canonical event type
  --cursor CURSOR                 Continue inspect from a prior JSON page
  --include-internal              Include isolated analysis sessions in listings

Run options:
  --cwd PATH                      Child working directory (default current directory)
  --max-output-frame-bytes N      Maximum stored stdout/stderr frame (default 262144)
  --max-untracked-file-bytes N    Maximum stored content per changed file (default 1048576)
`;

export interface CliOutput {
  write(value: string | Uint8Array): unknown;
}

export interface CliRuntime {
  readonly stdout: CliOutput;
  readonly stderr: CliOutput;
  readonly environment: NodeJS.ProcessEnv;
  readonly launchDaemon: DaemonLauncher;
  readonly now: () => Date;
}

const DEFAULT_RUNTIME: CliRuntime = {
  stdout: process.stdout,
  stderr: process.stderr,
  environment: process.env,
  launchDaemon: launchDaemonProcess,
  now: () => new Date(),
};

function timeoutFromArguments(
  parsed: ParsedCliArguments,
  fallback: number,
): number {
  return integerFlag(parsed.flags, "timeout-ms", fallback, 100, 120_000);
}

async function initialize(paths: DaemonPaths): Promise<void> {
  await ensureInstallLayout(paths);
  await ensureControlToken(paths.homeDirectory, paths.tokenPath);
  const storage = await openBlackBoxStorage({
    databasePath: paths.databasePath,
    dataDirectory: paths.dataDirectory,
    recoverIncompleteExchanges: false,
  });
  try {
    const integrity = storage.integrityCheck();
    if (integrity !== "ok") {
      throw new Error(`SQLite integrity check returned '${integrity}'.`);
    }
  } finally {
    storage.close();
  }
}

function writeStatus(
  output: CliOutput,
  status: DaemonStatus,
  json: boolean,
  prefix = "Black Box daemon",
): void {
  if (json) {
    output.write(`${JSON.stringify(status)}\n`);
    return;
  }
  output.write(`${prefix}: ${status.state} (PID ${status.pid})\n`);
  output.write(`Proxy: ${status.proxyOrigin} (${status.proxy.status})\n`);
  output.write(`OPENAI_BASE_URL=${status.proxyOrigin}/v1\n`);
}

async function waitForReady(
  paths: DaemonPaths,
  timeoutMilliseconds: number,
): Promise<DaemonStatus> {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError: unknown;
  while (Date.now() < deadline) {
    let record: DaemonLockRecord | undefined;
    try {
      record = await readDaemonLockRecord(paths.lockPath);
    } catch (error: unknown) {
      lastError = error;
    }
    if (record !== undefined) {
      if (!isProcessAlive(record.pid)) {
        throw new Error(
          `Daemon process ${record.pid} exited before becoming ready. See ${paths.logPath}.`,
        );
      }
      if (record.state === "ready" && record.controlOrigin !== undefined) {
        try {
          return await requestDaemonStatus(
            record,
            paths,
            Math.min(2_000, Math.max(100, deadline - Date.now())),
          );
        } catch (error: unknown) {
          lastError = error;
        }
      }
    }
    await delay(50);
  }
  throw new Error(
    `Daemon did not become ready within ${timeoutMilliseconds} ms. See ${paths.logPath}.`,
    lastError === undefined ? undefined : { cause: lastError },
  );
}

async function recoverAbandonedLock(paths: DaemonPaths): Promise<void> {
  const recovery = await DaemonLock.acquire({ path: paths.lockPath });
  await recovery.release();
}

async function waitForStopped(
  paths: DaemonPaths,
  target: DaemonLockRecord,
  timeoutMilliseconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    let current: DaemonLockRecord | undefined;
    try {
      current = await readDaemonLockRecord(paths.lockPath);
    } catch (error: unknown) {
      if (!(error instanceof CorruptDaemonLockError)) {
        throw error;
      }
    }
    if (current === undefined || current.instanceId !== target.instanceId) {
      return;
    }
    if (!isProcessAlive(current.pid)) {
      await recoverAbandonedLock(paths);
      return;
    }
    await delay(50);
  }
  throw new Error(
    `Daemon did not stop within ${timeoutMilliseconds} ms (PID ${target.pid}).`,
  );
}

async function readActiveLock(
  paths: DaemonPaths,
): Promise<DaemonLockRecord | undefined> {
  const record = await readDaemonLockRecord(paths.lockPath);
  return record !== undefined && isProcessAlive(record.pid)
    ? record
    : undefined;
}

async function commandInit(
  parsed: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<number> {
  const paths = pathsFromFlags(parsed.flags);
  await initialize(paths);
  runtime.stdout.write(`Initialized Black Box at ${paths.homeDirectory}\n`);
  return 0;
}

async function commandStart(
  parsed: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<number> {
  const configuration = resolveStartConfiguration(
    parsed.flags,
    runtime.environment,
  );
  const { status, alreadyRunning } = await ensureDaemonReady(
    configuration,
    runtime,
  );
  writeStatus(
    runtime.stdout,
    status,
    false,
    alreadyRunning
      ? "Black Box daemon already running"
      : "Black Box daemon started",
  );
  return 0;
}

async function ensureDaemonReady(
  configuration: ResolvedStartConfiguration,
  runtime: CliRuntime,
): Promise<{
  readonly status: DaemonStatus;
  readonly alreadyRunning: boolean;
}> {
  let active: DaemonLockRecord | undefined;
  try {
    active = await readActiveLock(configuration.paths);
  } catch (error: unknown) {
    if (!(error instanceof CorruptDaemonLockError)) {
      throw error;
    }
  }

  if (active !== undefined) {
    if (active.state === "stopping") {
      throw new Error(`Daemon PID ${active.pid} is still stopping.`);
    }
    const status = await waitForReady(
      configuration.paths,
      configuration.readinessTimeoutMilliseconds,
    );
    return { status, alreadyRunning: true };
  }

  await initialize(configuration.paths);
  await runtime.launchDaemon(configuration);
  const status = await waitForReady(
    configuration.paths,
    configuration.readinessTimeoutMilliseconds,
  );
  return { status, alreadyRunning: false };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function childExitStatus(
  exitCode: number | null,
  signal: string | null,
): number {
  if (exitCode !== null) {
    return exitCode;
  }
  if (signal === null) {
    return 1;
  }
  const signalNumber = (osConstants.signals as Record<string, number>)[signal];
  return 128 + (signalNumber ?? 0);
}

async function commandRun(
  parsed: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<number> {
  const executable = parsed.positionals[0];
  if (executable === undefined) {
    throw new CliUsageError("run requires '--' followed by a command.");
  }
  const configuration = resolveStartConfiguration(
    parsed.flags,
    runtime.environment,
  );
  const { status } = await ensureDaemonReady(configuration, runtime);
  const cwd = resolve(stringFlag(parsed.flags, "cwd") ?? process.cwd());
  const sessionId = `session-run-${randomUUID()}`;
  const startedAt = runtime.now().toISOString();
  const storage = await openBlackBoxStorage({
    databasePath: configuration.paths.databasePath,
    dataDirectory: configuration.paths.dataDirectory,
    recoverIncompleteExchanges: false,
  });
  const journal = new RunEventJournal(storage, {
    schemaVersion: 1,
    sessionId,
    executable,
    arguments: parsed.positionals.slice(1),
    cwd,
    startedAt,
    configuration: {
      ...DEFAULT_PROCESS_RUN_CONFIGURATION,
      excludedPathSegments: [
        ...DEFAULT_PROCESS_RUN_CONFIGURATION.excludedPathSegments,
      ],
      maxOutputFrameBytes: integerFlag(
        parsed.flags,
        "max-output-frame-bytes",
        DEFAULT_PROCESS_RUN_CONFIGURATION.maxOutputFrameBytes,
        1,
        1024 * 1024,
      ),
      maxUntrackedFileBytes: integerFlag(
        parsed.flags,
        "max-untracked-file-bytes",
        DEFAULT_PROCESS_RUN_CONFIGURATION.maxUntrackedFileBytes,
        0,
        1024 * 1024 * 1024,
      ),
    },
  });
  let recordingFailure: unknown;
  let workspaceObserver: WorkspaceObserver | undefined;
  const observe = (operation: Promise<void>) => {
    void operation.catch((error: unknown) => {
      recordingFailure ??= error;
    });
  };

  try {
    workspaceObserver = await WorkspaceObserver.start({
      cwd,
      dataDirectory: configuration.paths.homeDirectory,
      configuration: journal.identity.configuration,
      now: runtime.now,
    });
    await journal.recordWorkspaceSnapshot(workspaceObserver.baseline);
  } catch (error: unknown) {
    recordingFailure ??= error;
    await journal
      .recordWorkspaceError("baseline", error, runtime.now().toISOString())
      .catch((journalError: unknown) => {
        recordingFailure ??= journalError;
      });
    workspaceObserver = undefined;
  }

  try {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, parsed.positionals.slice(1), {
        cwd,
        env: {
          ...runtime.environment,
          OPENAI_BASE_URL: sessionScopedProxyBaseUrl(
            status.proxyOrigin,
            sessionId,
          ),
          BLACKBOX_PROXY_ORIGIN: status.proxyOrigin,
          BLACKBOX_SESSION_ID: sessionId,
          BLACKBOX_CAPTURE_LEVEL: "wrapped-process",
        },
        shell: false,
        stdio: ["inherit", "pipe", "pipe"],
      });
    } catch (error: unknown) {
      const spawnCode = errorCode(error);
      await journal
        .fail({
          message: errorMessage(error),
          ...(spawnCode === undefined ? {} : { code: spawnCode }),
          failedAt: runtime.now().toISOString(),
        })
        .catch(() => undefined);
      runtime.stderr.write(
        `blackbox: failed to spawn ${executable}: ${errorMessage(error)}\n`,
      );
      return 127;
    }

    const outcome = new Promise<
      | { readonly kind: "spawn-error"; readonly error: unknown }
      | {
          readonly kind: "closed";
          readonly exitCode: number | null;
          readonly signal: string | null;
        }
    >((resolveOutcome) => {
      child.once("error", (error) => {
        if (child.pid === undefined) {
          resolveOutcome({ kind: "spawn-error", error });
        } else {
          recordingFailure ??= error;
        }
      });
      child.once("close", (exitCode, signal) => {
        resolveOutcome({ kind: "closed", exitCode, signal });
      });
    });

    if (child.pid !== undefined) {
      observe(journal.recordStarted(child.pid, runtime.now().toISOString()));
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      const bytes = Buffer.from(chunk);
      runtime.stdout.write(bytes);
      try {
        observe(
          journal.appendOutput("stdout", bytes, runtime.now().toISOString()),
        );
      } catch (error: unknown) {
        recordingFailure ??= error;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const bytes = Buffer.from(chunk);
      runtime.stderr.write(bytes);
      try {
        observe(
          journal.appendOutput("stderr", bytes, runtime.now().toISOString()),
        );
      } catch (error: unknown) {
        recordingFailure ??= error;
      }
    });

    const result = await outcome;
    if (result.kind === "spawn-error") {
      const spawnCode = errorCode(result.error);
      await journal
        .fail({
          message: errorMessage(result.error),
          ...(spawnCode === undefined ? {} : { code: spawnCode }),
          failedAt: runtime.now().toISOString(),
        })
        .catch((error: unknown) => {
          recordingFailure ??= error;
        });
      runtime.stderr.write(
        `blackbox: failed to spawn ${executable}: ${errorMessage(result.error)}\n`,
      );
      return 127;
    }

    if (workspaceObserver !== undefined) {
      try {
        const workspace = await workspaceObserver.complete();
        for (const change of workspace.changes) {
          await journal.recordFileChange(change);
        }
        await journal.recordWorkspaceSnapshot(workspace.snapshot);
      } catch (error: unknown) {
        recordingFailure ??= error;
        await journal
          .recordWorkspaceError("final", error, runtime.now().toISOString())
          .catch((journalError: unknown) => {
            recordingFailure ??= journalError;
          });
      }
    }

    await journal
      .finish({
        exitCode: result.exitCode,
        signal: result.signal,
        endedAt: runtime.now().toISOString(),
      })
      .catch((error: unknown) => {
        recordingFailure ??= error;
      });
    if (recordingFailure !== undefined) {
      runtime.stderr.write(
        `blackbox: process evidence is incomplete: ${errorMessage(recordingFailure)}\n`,
      );
    }
    return childExitStatus(result.exitCode, result.signal);
  } finally {
    storage.close();
  }
}

async function commandStatus(
  parsed: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<number> {
  const paths = pathsFromFlags(parsed.flags);
  const json = parsed.flags.has("json");
  const record = await readDaemonLockRecord(paths.lockPath);
  if (record === undefined) {
    if (json) {
      runtime.stdout.write('{"state":"stopped"}\n');
    } else {
      runtime.stdout.write("Black Box daemon: stopped\n");
    }
    return 1;
  }
  if (!isProcessAlive(record.pid)) {
    if (json) {
      runtime.stdout.write(
        `${JSON.stringify({ state: "stale", pid: record.pid })}\n`,
      );
    } else {
      runtime.stdout.write(
        `Black Box daemon: stale lock (PID ${record.pid})\n`,
      );
    }
    return 1;
  }
  if (record.state !== "ready" || record.controlOrigin === undefined) {
    const value = { state: record.state, pid: record.pid };
    runtime.stdout.write(
      json
        ? `${JSON.stringify(value)}\n`
        : `Black Box daemon: ${record.state} (PID ${record.pid})\n`,
    );
    return 0;
  }
  const status = await requestDaemonStatus(
    record,
    paths,
    timeoutFromArguments(parsed, 2_000),
  );
  writeStatus(runtime.stdout, status, json);
  return status.proxy.status === "healthy" ? 0 : 1;
}

async function commandStop(
  parsed: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<number> {
  const paths = pathsFromFlags(parsed.flags);
  const json = parsed.flags.has("json");
  const timeoutMilliseconds = timeoutFromArguments(parsed, 10_000);
  let record: DaemonLockRecord | undefined;
  try {
    record = await readDaemonLockRecord(paths.lockPath);
  } catch (error: unknown) {
    if (!(error instanceof CorruptDaemonLockError)) {
      throw error;
    }
    await recoverAbandonedLock(paths);
    runtime.stdout.write(
      json
        ? '{"state":"stopped","recovered":"corrupt-lock"}\n'
        : "Black Box daemon was not running; removed corrupt lock.\n",
    );
    return 0;
  }
  if (record === undefined) {
    runtime.stdout.write(
      json ? '{"state":"stopped"}\n' : "Black Box daemon is already stopped.\n",
    );
    return 0;
  }
  if (!isProcessAlive(record.pid)) {
    await recoverAbandonedLock(paths);
    runtime.stdout.write(
      json
        ? `${JSON.stringify({ state: "stopped", recoveredPid: record.pid })}\n`
        : `Removed stale daemon lock for PID ${record.pid}.\n`,
    );
    return 0;
  }
  if (record.state === "stopping") {
    await waitForStopped(paths, record, timeoutMilliseconds);
    runtime.stdout.write(
      json ? '{"state":"stopped"}\n' : "Black Box daemon stopped.\n",
    );
    return 0;
  }
  if (record.state !== "ready" || record.controlOrigin === undefined) {
    await waitForReady(paths, timeoutMilliseconds);
  }
  const readyRecord = await readDaemonLockRecord(paths.lockPath);
  if (readyRecord === undefined) {
    runtime.stdout.write(
      json ? '{"state":"stopped"}\n' : "Black Box daemon stopped.\n",
    );
    return 0;
  }
  await requestDaemonShutdown(
    readyRecord,
    paths,
    Math.min(2_000, timeoutMilliseconds),
  );
  await waitForStopped(paths, readyRecord, timeoutMilliseconds);
  runtime.stdout.write(
    json ? '{"state":"stopped"}\n' : "Black Box daemon stopped.\n",
  );
  return 0;
}

function writeDoctorReport(
  output: CliOutput,
  report: DoctorReport,
  json: boolean,
): void {
  if (json) {
    output.write(`${JSON.stringify(report)}\n`);
    return;
  }
  for (const check of report.checks) {
    output.write(
      `[${check.status.toUpperCase()}] ${check.id}: ${check.message}\n`,
    );
  }
}

async function commandDoctor(
  parsed: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<number> {
  const configuration = resolveStartConfiguration(
    parsed.flags,
    runtime.environment,
  );
  const report = await runDoctor(configuration, parsed.flags.has("websocket"));
  writeDoctorReport(runtime.stdout, report, parsed.flags.has("json"));
  return report.ok ? 0 : 1;
}

async function openInspectionStorage(paths: DaemonPaths) {
  try {
    await access(paths.databasePath);
  } catch (error: unknown) {
    throw new Error(
      `Black Box is not initialized at ${paths.homeDirectory}. Run 'blackbox init' first.`,
      { cause: error },
    );
  }
  return openBlackBoxStorage({
    databasePath: paths.databasePath,
    dataDirectory: paths.dataDirectory,
    recoverIncompleteExchanges: false,
  });
}

async function commandSessions(
  parsed: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<number> {
  const paths = pathsFromFlags(parsed.flags);
  const storage = await openInspectionStorage(paths);
  try {
    const limit = integerFlag(parsed.flags, "limit", 100, 1, 1000);
    const sessions = storage.sessions
      .list(1000)
      .filter(
        (session) =>
          parsed.flags.has("include-internal") ||
          session.metadata.internalAnalysis !== true,
      )
      .slice(0, limit);
    if (parsed.flags.has("json")) {
      runtime.stdout.write(`${JSON.stringify(sessions)}\n`);
      return 0;
    }
    if (sessions.length === 0) {
      runtime.stdout.write("No recorded sessions.\n");
      return 0;
    }
    for (const session of sessions) {
      runtime.stdout.write(
        `${session.id}\t${session.status}\t${session.startedAt}\t${session.counts.events} events\n`,
      );
    }
    return 0;
  } finally {
    storage.close();
  }
}

async function commandInspect(
  parsed: ParsedCliArguments,
  runtime: CliRuntime,
): Promise<number> {
  const sessionId = parsed.positionals[0];
  if (sessionId === undefined) {
    throw new CliUsageError("inspect requires exactly one session ID.");
  }
  const paths = pathsFromFlags(parsed.flags);
  const storage = await openInspectionStorage(paths);
  try {
    const session = storage.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`Session ${sessionId} does not exist.`);
    }
    const type = stringFlag(parsed.flags, "type");
    const cursor = stringFlag(parsed.flags, "cursor");
    const page = storage.events.list(sessionId, {
      limit: integerFlag(parsed.flags, "limit", 100, 1, 1000),
      ...(type === undefined ? {} : { type }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (parsed.flags.has("json")) {
      runtime.stdout.write(
        `${JSON.stringify({
          session,
          events: page.events,
          ...(page.nextCursor === undefined
            ? {}
            : { nextCursor: page.nextCursor }),
        })}\n`,
      );
      return 0;
    }
    runtime.stdout.write(
      `Session ${session.id}: ${session.status}, ${session.counts.events} canonical events\n`,
    );
    for (const event of page.events) {
      runtime.stdout.write(`${JSON.stringify(event)}\n`);
    }
    if (page.nextCursor !== undefined) {
      runtime.stdout.write(
        `More events remain; continue with --cursor ${page.nextCursor}.\n`,
      );
    }
    return 0;
  } finally {
    storage.close();
  }
}

export async function runCli(
  arguments_: readonly string[],
  runtimeOverrides: Partial<CliRuntime> = {},
): Promise<number> {
  const runtime: CliRuntime = { ...DEFAULT_RUNTIME, ...runtimeOverrides };
  try {
    const parsed = parseCliArguments(arguments_);
    if (parsed.help || parsed.command === undefined) {
      runtime.stdout.write(HELP);
      return 0;
    }
    switch (parsed.command) {
      case "init":
        return await commandInit(parsed, runtime);
      case "start":
        return await commandStart(parsed, runtime);
      case "stop":
        return await commandStop(parsed, runtime);
      case "status":
        return await commandStatus(parsed, runtime);
      case "doctor":
        return await commandDoctor(parsed, runtime);
      case "sessions":
        return await commandSessions(parsed, runtime);
      case "inspect":
        return await commandInspect(parsed, runtime);
      case "run":
        return await commandRun(parsed, runtime);
    }
  } catch (error: unknown) {
    const usage = error instanceof CliUsageError;
    const message = error instanceof Error ? error.message : String(error);
    runtime.stderr.write(`blackbox: ${message}\n`);
    if (usage) {
      runtime.stderr.write("Run 'blackbox --help' for usage.\n");
    }
    return usage ? 2 : 1;
  }
}

export * from "./configuration.js";
export * from "./control-client.js";
export * from "./daemon-launcher.js";
export * from "./doctor.js";
export * from "./run/run-event-journal.js";
export * from "./run/workspace-observer.js";
