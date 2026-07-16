import { TextEncoder } from "node:util";

import { describe, expect, it } from "vitest";

import {
  IncrementalSseDecoder,
  NormalizationExchangeSchema,
  SseLimitError,
  decodeSseChunks,
  materializeCanonicalEvents,
  type NormalizationExchange,
} from "../src/index.js";

const encoder = new TextEncoder();

function exchange(
  overrides: Partial<NormalizationExchange> = {},
): NormalizationExchange {
  return NormalizationExchangeSchema.parse({
    schemaVersion: 1,
    id: "fixture-exchange",
    sessionId: "session-normalizer",
    rawSequence: 1,
    protocol: "openai.responses",
    method: "POST",
    path: "/v1/responses",
    query: {},
    requestHeaders: { "content-type": "application/json" },
    requestBody: encoder.encode('{"input":"hello"}'),
    responseStatus: 200,
    responseHeaders: { "content-type": "text/event-stream" },
    responseBody: encoder.encode("data: {}\n\n"),
    startedAt: "2026-07-16T12:00:00.000Z",
    firstByteAt: "2026-07-16T12:00:00.010Z",
    endedAt: "2026-07-16T12:00:00.020Z",
    outcome: "completed",
    capture: {
      requestComplete: true,
      responseComplete: true,
      droppedRequestBytes: 0,
      droppedResponseBytes: 0,
    },
    ...overrides,
  });
}

describe("incremental SSE framing", () => {
  it("is invariant to every transport split, including inside UTF-8", () => {
    const bytes = encoder.encode(
      "\uFEFF: keepalive\r\n" +
        "event: message\r\n" +
        "id: evt-1\r\n" +
        "data: first\r\n" +
        "data: emoji 😀\r\n\r\n" +
        "retry: 250\n" +
        "future-field: retained\n" +
        "data: second\n\n",
    );
    const expected = decodeSseChunks([bytes]);

    expect(expected).toEqual({
      frames: [
        {
          index: 1,
          event: "message",
          id: "evt-1",
          data: "first\nemoji 😀",
          comments: ["keepalive"],
          unknownFields: [],
          raw: ": keepalive\nevent: message\nid: evt-1\ndata: first\ndata: emoji 😀\n\n",
        },
        {
          index: 2,
          data: "second",
          retry: 250,
          comments: [],
          unknownFields: [{ name: "future-field", value: "retained" }],
          raw: "retry: 250\nfuture-field: retained\ndata: second\n\n",
        },
      ],
    });

    for (let split = 1; split < bytes.length; split += 1) {
      expect(
        decodeSseChunks([bytes.subarray(0, split), bytes.subarray(split)]),
      ).toEqual(expected);
    }
    expect(
      decodeSseChunks(Array.from(bytes, (byte) => Uint8Array.of(byte))),
    ).toEqual(expected);
  });

  it("reports but does not dispatch an unterminated trailing frame", () => {
    const decoded = decodeSseChunks([
      encoder.encode('data: complete\n\ndata: {"partial":'),
    ]);

    expect(decoded.frames).toHaveLength(1);
    expect(decoded.incomplete).toEqual({
      index: 2,
      raw: 'data: {"partial":',
    });
  });

  it("rejects malformed UTF-8 and explicit resource-limit violations", () => {
    const malformed = new IncrementalSseDecoder();
    expect(() => malformed.push(Uint8Array.of(0xff))).toThrow(TypeError);

    const bounded = new IncrementalSseDecoder({
      maximumBufferedCharacters: 8,
      maximumFrameCharacters: 8,
      maximumFrames: 1,
    });
    expect(() => bounded.push(encoder.encode("data: too-long"))).toThrow(
      SseLimitError,
    );
  });

  it("cannot be appended to or finished twice", () => {
    const decoder = new IncrementalSseDecoder();
    decoder.push(encoder.encode("data: ok\n\n"));
    decoder.finish();

    expect(() => decoder.finish()).toThrow("only be called once");
    expect(() => decoder.push(Uint8Array.of())).toThrow(
      "after the SSE decoder is finished",
    );
  });
});

describe("canonical event materialization", () => {
  it("assigns deterministic IDs, sequences, timestamps, and ancestry", () => {
    const events = materializeCanonicalEvents(
      exchange({ id: "fixture-id", sessionId: "session-fixture" }),
      [
        { type: "model.request", summary: { model: "gpt-fixture" } },
        {
          type: "message.assistant",
          summary: { text: "hello" },
          evidence: "derived",
          parentDraftIndex: 0,
        },
      ],
      { firstSequence: 41 },
    );

    expect(events).toEqual([
      {
        schemaVersion: 1,
        id: "event-fixture-id-1",
        sessionId: "session-fixture",
        sequence: 41,
        occurredAt: "2026-07-16T12:00:00.000Z",
        observedAt: "2026-07-16T12:00:00.020Z",
        source: "proxy",
        type: "model.request",
        evidence: "observed",
        summary: { model: "gpt-fixture" },
        redaction: { applied: false, ruleIds: [] },
      },
      {
        schemaVersion: 1,
        id: "event-fixture-id-2",
        sessionId: "session-fixture",
        parentId: "event-fixture-id-1",
        sequence: 42,
        occurredAt: "2026-07-16T12:00:00.000Z",
        observedAt: "2026-07-16T12:00:00.020Z",
        source: "proxy",
        type: "message.assistant",
        evidence: "derived",
        summary: { text: "hello" },
        redaction: { applied: false, ruleIds: [] },
      },
    ]);
  });

  it("hashes overlong exchange IDs and rejects forward parent references", () => {
    const events = materializeCanonicalEvents(
      exchange({ id: "x".repeat(512) }),
      [{ type: "unknown", summary: {} }],
    );
    expect(events[0]?.id).toMatch(/^event-[a-f\d]{64}-1$/u);

    expect(() =>
      materializeCanonicalEvents(exchange(), [
        { type: "invalid-parent", summary: {}, parentDraftIndex: 0 },
      ]),
    ).toThrow(RangeError);
  });
});
