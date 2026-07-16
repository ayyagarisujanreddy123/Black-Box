import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openBlackBoxStorage, type BlackBoxStorage } from "@blackbox/storage";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PROCESS_RUN_CONFIGURATION,
  RunEventJournal,
} from "../src/index.js";

const STARTED_AT = "2026-07-16T12:00:00.000Z";
const ENDED_AT = "2026-07-16T12:00:01.000Z";
const roots: string[] = [];
const storages: BlackBoxStorage[] = [];

async function testStorage(): Promise<BlackBoxStorage> {
  const root = await mkdtemp(join(tmpdir(), "blackbox-run-journal-test-"));
  roots.push(root);
  const storage = await openBlackBoxStorage({
    databasePath: join(root, "blackbox.sqlite"),
    dataDirectory: join(root, "data"),
    recoverIncompleteExchanges: false,
  });
  storages.push(storage);
  return storage;
}

afterEach(async () => {
  for (const storage of storages.splice(0)) {
    storage.close();
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("durable process event journal", () => {
  it("serializes bounded output frames and completes a wrapped session", async () => {
    const storage = await testStorage();
    const journal = new RunEventJournal(storage, {
      schemaVersion: 1,
      sessionId: "session-run-journal",
      executable: process.execPath,
      arguments: ["fixture.js"],
      cwd: process.cwd(),
      startedAt: STARTED_AT,
      configuration: {
        ...DEFAULT_PROCESS_RUN_CONFIGURATION,
        maxOutputFrameBytes: 4,
      },
    });

    void journal.recordStarted(1234, STARTED_AT);
    void journal.appendOutput("stdout", Buffer.from("hello world"), STARTED_AT);
    void journal.appendOutput("stderr", Buffer.from([0xff, 0x00]), STARTED_AT);
    await journal.finish({ exitCode: 7, signal: null, endedAt: ENDED_AT });

    const events = storage.events.list("session-run-journal").events;
    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "process.started",
      "process.stdout",
      "process.stdout",
      "process.stdout",
      "process.stderr",
      "process.exited",
      "session.ended",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(events[6]?.summary).toEqual({
      pid: 1234,
      exitCode: 7,
      signal: null,
      success: false,
    });

    const stdoutFrames = events.filter(
      (event) => event.type === "process.stdout",
    );
    const stdoutBytes = await Promise.all(
      stdoutFrames.map((event) =>
        storage.blobs.get(event.payloadRef?.id as string),
      ),
    );
    expect(
      Buffer.concat(stdoutBytes.map((bytes) => Buffer.from(bytes))),
    ).toEqual(Buffer.from("hello world"));
    expect(
      stdoutFrames.every(
        (event) => (event.payloadRef?.byteLength ?? Infinity) <= 4,
      ),
    ).toBe(true);
    expect(events[5]?.summary).toMatchObject({
      stream: "stderr",
      encoding: "binary",
    });

    expect(storage.sessions.getRequired("session-run-journal")).toMatchObject({
      status: "completed",
      endedAt: ENDED_AT,
      captureLevel: "wrapped-process",
      command: {
        executable: process.execPath,
        arguments: ["fixture.js"],
        cwd: process.cwd(),
      },
      counts: { events: 8, errors: 0 },
    });
  });

  it("records spawn failure and a crashed terminal session atomically", async () => {
    const storage = await testStorage();
    const journal = new RunEventJournal(storage, {
      schemaVersion: 1,
      sessionId: "session-run-failure",
      executable: "missing-command",
      arguments: [],
      cwd: process.cwd(),
      startedAt: STARTED_AT,
      configuration: DEFAULT_PROCESS_RUN_CONFIGURATION,
    });

    await journal.fail({
      code: "ENOENT",
      message: "Command was not found.",
      failedAt: ENDED_AT,
    });

    expect(
      storage.events
        .list("session-run-failure")
        .events.map((event) => event.type),
    ).toEqual(["session.started", "process.error", "session.crashed"]);
    expect(storage.sessions.getRequired("session-run-failure")).toMatchObject({
      status: "crashed",
      endedAt: ENDED_AT,
      counts: { events: 3, errors: 2 },
    });
  });
});
