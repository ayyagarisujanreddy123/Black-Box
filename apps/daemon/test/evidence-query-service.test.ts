import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BlackBoxEventSchema,
  RawExchangeSchema,
  SessionSchema,
  type BlackBoxEvent,
  type Session,
} from "@blackbox/protocol";
import { openBlackBoxStorage, type BlackBoxStorage } from "@blackbox/storage";
import { afterEach, describe, expect, it } from "vitest";

import {
  EvidenceQueryNotFoundError,
  EvidenceQueryService,
} from "../src/index.js";

const roots: string[] = [];
const storages: BlackBoxStorage[] = [];
const TIMES = [
  "2026-07-16T12:00:00.000Z",
  "2026-07-16T12:00:01.000Z",
  "2026-07-16T12:00:02.000Z",
] as const;

async function testStorage(): Promise<BlackBoxStorage> {
  const root = await mkdtemp(join(tmpdir(), "blackbox-query-service-test-"));
  roots.push(root);
  const storage = await openBlackBoxStorage({
    databasePath: join(root, "blackbox.sqlite"),
    dataDirectory: join(root, "data"),
    recoverIncompleteExchanges: false,
  });
  storages.push(storage);
  return storage;
}

function session(
  id: string,
  startedAt: string,
  internalAnalysis = false,
): Session {
  return SessionSchema.parse({
    schemaVersion: 1,
    id,
    startedAt,
    status: "active",
    captureLevel: "api",
    models: [],
    tags: internalAnalysis ? ["internal-analysis"] : [],
    counts: {
      events: 0,
      errors: 0,
      inputTokens: null,
      outputTokens: null,
    },
    metadata: { internalAnalysis },
  });
}

function event(
  id: string,
  sequence: number,
  occurredAt: string,
  source: "proxy" | "filesystem",
  text: string,
): BlackBoxEvent {
  return BlackBoxEventSchema.parse({
    schemaVersion: 1,
    id,
    sessionId: "session-newest",
    sequence,
    occurredAt,
    observedAt: occurredAt,
    source,
    type: source === "proxy" ? "message.assistant" : "file.modify",
    evidence: "observed",
    summary: { text },
    redaction: { applied: false, ruleIds: [] },
  });
}

afterEach(async () => {
  for (const storage of storages.splice(0)) {
    storage.close();
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("evidence query service", () => {
  it("paginates visible sessions with opaque stable cursors", async () => {
    const storage = await testStorage();
    storage.sessions.create(session("session-oldest", TIMES[0]));
    storage.sessions.create(session("session-internal", TIMES[1], true));
    storage.sessions.create(session("session-newest", TIMES[2]));
    const service = new EvidenceQueryService(storage);

    const first = service.listSessions({ limit: 1 });
    expect(first.sessions.map((value) => value.id)).toEqual(["session-newest"]);
    expect(first.nextCursor).toBeDefined();
    const second = service.listSessions({
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.sessions.map((value) => value.id)).toEqual([
      "session-oldest",
    ]);
    expect(second.nextCursor).toBeUndefined();
    expect(
      service
        .listSessions({ limit: 10, includeInternal: true })
        .sessions.map((value) => value.id),
    ).toEqual(["session-newest", "session-internal", "session-oldest"]);
    expect(() => service.listSessions({ cursor: "not-a-cursor" })).toThrow(
      "Invalid session cursor",
    );
  });

  it("filters event pages and searches within one required session", async () => {
    const storage = await testStorage();
    storage.sessions.create(session("session-newest", TIMES[0]));
    storage.events.insert(
      event("event-proxy", 1, TIMES[0], "proxy", "ordinary response"),
    );
    storage.events.insert(
      event("event-file", 2, TIMES[1], "filesystem", "needle README"),
    );
    storage.events.insert(
      event("event-late", 3, TIMES[2], "proxy", "needle later response"),
    );
    storage.rawExchanges.insertComplete(
      RawExchangeSchema.parse({
        schemaVersion: 1,
        id: "exchange-query",
        sessionId: "session-newest",
        sequence: 4,
        protocol: "openai.responses",
        method: "POST",
        path: "/v1/responses",
        query: {},
        requestHeaders: { "content-type": ["application/json"] },
        responseStatus: 200,
        responseHeaders: { "content-type": ["application/json"] },
        startedAt: TIMES[1],
        endedAt: TIMES[2],
        outcome: "completed",
        parseStatus: "pending",
        capture: {
          requestComplete: true,
          responseComplete: true,
          droppedRequestBytes: 0,
          droppedResponseBytes: 0,
        },
      }),
    );
    storage.events.insertNormalization({
      exchangeId: "exchange-query",
      parserVersion: "query-test-v1",
      events: [event("event-origin", 4, TIMES[2], "proxy", "origin evidence")],
    });
    const service = new EvidenceQueryService(storage);

    expect(
      service
        .listEvents("session-newest", {
          source: "proxy",
          occurredAfter: TIMES[1],
        })
        .events.map((value) => value.id),
    ).toEqual(["event-late", "event-origin"]);
    const first = service.listEvents("session-newest", { limit: 1 });
    const second = service.listEvents("session-newest", {
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(first.events[0]?.id).toBe("event-proxy");
    expect(second.events[0]?.id).toBe("event-file");
    expect(
      service
        .searchEvents("session-newest", { query: "needle" })
        .events.map((value) => value.id),
    ).toEqual(["event-file", "event-late"]);
    expect(
      service
        .searchEvents("session-newest", { query: 'needle "response"' })
        .events.map((value) => value.id),
    ).toEqual(["event-late"]);
    expect(service.getEvent("event-file")).toMatchObject({
      event: { id: "event-file" },
    });
    expect(service.getEvent("event-file").fileChange).toBeUndefined();
    expect(service.listFileChanges("session-newest").changes).toMatchObject([
      { event: { id: "event-file" }, change: null },
    ]);
    expect(service.getEvent("event-origin")).toMatchObject({
      normalizationVersion: "query-test-v1",
      rawExchange: {
        id: "exchange-query",
        responseHeaders: { "content-type": ["application/json"] },
      },
    });
    expect(() => service.getSession("session-missing")).toThrow(
      EvidenceQueryNotFoundError,
    );
  });

  it("reconstructs exact client-visible context from stored raw evidence", async () => {
    const storage = await testStorage();
    storage.sessions.create(session("session-newest", TIMES[0]));
    const requestBody = Buffer.from(
      JSON.stringify({
        model: "gpt-5.2",
        messages: [
          { role: "system", content: "Stay inside the repository." },
          { role: "user", content: "Inspect README.md." },
        ],
        temperature: 0,
      }),
      "utf8",
    );
    const requestBodyRef = await storage.blobs.put(requestBody, {
      mediaType: "application/json",
    });
    storage.rawExchanges.insertComplete(
      RawExchangeSchema.parse({
        schemaVersion: 1,
        id: "exchange-context",
        sessionId: "session-newest",
        sequence: 1,
        protocol: "openai.chat-completions",
        method: "POST",
        path: "/v1/chat/completions",
        query: {},
        requestHeaders: { "content-type": ["application/json"] },
        requestBodyRef,
        responseStatus: 200,
        responseHeaders: { "content-type": ["application/json"] },
        startedAt: TIMES[0],
        endedAt: TIMES[1],
        outcome: "completed",
        parseStatus: "pending",
        capture: {
          requestComplete: true,
          responseComplete: true,
          droppedRequestBytes: 0,
          droppedResponseBytes: 0,
        },
      }),
    );
    storage.events.insertNormalization({
      exchangeId: "exchange-context",
      parserVersion: "context-test-v1",
      events: [
        BlackBoxEventSchema.parse({
          schemaVersion: 1,
          id: "event-context-request",
          sessionId: "session-newest",
          sequence: 1,
          occurredAt: TIMES[0],
          observedAt: TIMES[0],
          source: "proxy",
          type: "model.request",
          evidence: "observed",
          summary: { endpoint: "/v1/chat/completions" },
          redaction: { applied: false, ruleIds: [] },
        }),
        BlackBoxEventSchema.parse({
          schemaVersion: 1,
          id: "event-context-usage",
          sessionId: "session-newest",
          sequence: 2,
          occurredAt: TIMES[1],
          observedAt: TIMES[1],
          source: "proxy",
          type: "model.usage",
          evidence: "observed",
          summary: { inputTokens: 23, outputTokens: 4, totalTokens: 27 },
          redaction: { applied: false, ruleIds: [] },
        }),
      ],
    });

    const result = await new EvidenceQueryService(storage).getContext(
      "event-context-request",
    );

    expect(result).toMatchObject({
      requestEventId: "event-context-request",
      completeness: "exact-client-request",
      reportedInputTokens: 23,
      items: [
        { kind: "message", role: "system" },
        { kind: "message", role: "user" },
        { kind: "settings" },
      ],
    });
    expect(result.items[0]?.provenance).toMatchObject({
      eventId: "event-context-request",
      exchangeId: "exchange-context",
      payloadRef: { id: requestBodyRef.id },
    });
  });
});
