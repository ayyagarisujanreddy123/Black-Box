import { createHash } from "node:crypto";

import {
  BlackBoxEventSchema,
  ProcessExitedSummarySchema,
  ProcessFailureSummarySchema,
  ProcessObservationIdentitySchema,
  ProcessOutputSummarySchema,
  ProcessStartedSummarySchema,
  SessionSchema,
  type BlackBoxEvent,
  type ProcessObservationIdentity,
  type ProcessOutputStream,
} from "@blackbox/protocol";
import type { BlackBoxStorage } from "@blackbox/storage";

const NO_REDACTION = { applied: false, ruleIds: [] } as const;

export const DEFAULT_PROCESS_RUN_CONFIGURATION = {
  schemaVersion: 1,
  maxOutputFrameBytes: 256 * 1024,
  maxUntrackedFileBytes: 1024 * 1024,
  watcherDebounceMilliseconds: 100,
  excludedPathSegments: [
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    ".cache",
  ],
} as const;

export interface ProcessExitObservation {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly endedAt: string;
}

export interface ProcessSpawnFailure {
  readonly message: string;
  readonly code?: string;
  readonly failedAt: string;
}

function eventId(sessionId: string, sequence: number): string {
  const candidate = `event-${sessionId}-${sequence}`;
  if (candidate.length <= 512) {
    return candidate;
  }
  return `event-${createHash("sha256").update(sessionId).digest("hex")}-${sequence}`;
}

function frameEncoding(bytes: Uint8Array): "utf-8" | "binary" {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "utf-8";
  } catch {
    return "binary";
  }
}

export class RunEventJournal {
  readonly identity: ProcessObservationIdentity;
  private readonly frameIndexes: Record<ProcessOutputStream, number> = {
    stdout: 0,
    stderr: 0,
  };
  private pending: Promise<void> = Promise.resolve();
  private pid?: number;
  private terminal = false;

  constructor(
    private readonly storage: BlackBoxStorage,
    input: ProcessObservationIdentity,
  ) {
    this.identity = ProcessObservationIdentitySchema.parse(input);
    this.storage.transaction(() => {
      this.storage.sessions.create(
        SessionSchema.parse({
          schemaVersion: 1,
          id: this.identity.sessionId,
          startedAt: this.identity.startedAt,
          status: "active",
          captureLevel: "wrapped-process",
          command: {
            executable: this.identity.executable,
            arguments: this.identity.arguments,
            cwd: this.identity.cwd,
          },
          models: [],
          tags: [],
          counts: {
            events: 0,
            errors: 0,
            inputTokens: null,
            outputTokens: null,
          },
          metadata: {
            internalAnalysis: false,
            sessionization: { source: "explicit-wrapper" },
            processCaptureConfiguration: this.identity.configuration,
          },
        }),
      );
      this.insertEvent(
        "session.started",
        { captureLevel: "wrapped-process" },
        this.identity.startedAt,
      );
    });
  }

  recordStarted(pid: number, observedAt: string): Promise<void> {
    if (this.pid !== undefined || this.terminal) {
      throw new Error("Process start may only be recorded once.");
    }
    const summary = ProcessStartedSummarySchema.parse({
      pid,
      parentPid: process.pid,
      executable: this.identity.executable,
      arguments: this.identity.arguments,
      cwd: this.identity.cwd,
    });
    this.pid = summary.pid;
    return this.enqueue(() => {
      this.insertEvent("process.started", summary, observedAt);
    });
  }

  appendOutput(
    stream: ProcessOutputStream,
    bytes: Uint8Array,
    observedAt: string,
  ): Promise<void> {
    if (this.pid === undefined || this.terminal) {
      throw new Error("Process output requires a running process.");
    }
    const captured = Buffer.from(bytes);
    if (captured.length === 0) {
      return this.pending;
    }
    const pid = this.pid;
    return this.enqueue(async () => {
      const maximum = this.identity.configuration.maxOutputFrameBytes;
      for (let offset = 0; offset < captured.length; offset += maximum) {
        const frame = captured.subarray(
          offset,
          Math.min(captured.length, offset + maximum),
        );
        const payloadRef = await this.storage.blobs.put(frame, {
          mediaType:
            frameEncoding(frame) === "utf-8"
              ? "text/plain; charset=utf-8"
              : "application/octet-stream",
        });
        const summary = ProcessOutputSummarySchema.parse({
          pid,
          stream,
          frameIndex: ++this.frameIndexes[stream],
          byteLength: frame.length,
          encoding: frameEncoding(frame),
          truncated: false,
        });
        this.insertEvent(`process.${stream}`, summary, observedAt, payloadRef);
      }
    });
  }

  finish(observation: ProcessExitObservation): Promise<void> {
    if (this.pid === undefined || this.terminal) {
      throw new Error("A running process may only finish once.");
    }
    this.terminal = true;
    const pid = this.pid;
    const summary = ProcessExitedSummarySchema.parse({
      pid,
      exitCode: observation.exitCode,
      signal: observation.signal,
      success: observation.exitCode === 0 && observation.signal === null,
    });
    return this.enqueue(() => {
      this.storage.transaction(() => {
        this.insertEvent("process.exited", summary, observation.endedAt);
        this.insertEvent(
          "session.ended",
          { exitCode: summary.exitCode, signal: summary.signal },
          observation.endedAt,
        );
        this.updateSession("completed", observation.endedAt);
      });
    });
  }

  fail(failure: ProcessSpawnFailure): Promise<void> {
    if (this.pid !== undefined || this.terminal) {
      throw new Error("Only an unstarted process can record a spawn failure.");
    }
    this.terminal = true;
    const summary = ProcessFailureSummarySchema.parse({
      executable: this.identity.executable,
      ...(failure.code === undefined ? {} : { code: failure.code }),
      message: failure.message.slice(0, 4096),
    });
    return this.enqueue(() => {
      this.storage.transaction(() => {
        this.insertEvent("process.error", summary, failure.failedAt);
        this.insertEvent("session.crashed", summary, failure.failedAt);
        this.updateSession("crashed", failure.failedAt);
      });
    });
  }

  flush(): Promise<void> {
    return this.pending;
  }

  private enqueue(operation: () => void | Promise<void>): Promise<void> {
    this.pending = this.pending.then(operation);
    return this.pending;
  }

  private insertEvent(
    type: string,
    summary: BlackBoxEvent["summary"],
    observedAt: string,
    payloadRef?: BlackBoxEvent["payloadRef"],
  ): BlackBoxEvent {
    const sequence = this.storage.sequences.reserve(this.identity.sessionId)[0];
    if (sequence === undefined) {
      throw new Error(
        `Failed to allocate process event sequence for ${this.identity.sessionId}.`,
      );
    }
    return this.storage.events.insert(
      BlackBoxEventSchema.parse({
        schemaVersion: 1,
        id: eventId(this.identity.sessionId, sequence),
        sessionId: this.identity.sessionId,
        sequence,
        occurredAt: observedAt,
        observedAt,
        source: "process",
        type,
        evidence: "observed",
        ...(payloadRef === undefined ? {} : { payloadRef }),
        summary,
        redaction: NO_REDACTION,
      }),
    );
  }

  private updateSession(
    status: "completed" | "crashed",
    endedAt: string,
  ): void {
    const session = this.storage.sessions.getRequired(this.identity.sessionId);
    this.storage.sessions.replace(
      SessionSchema.parse({ ...session, status, endedAt }),
      endedAt,
    );
  }
}
