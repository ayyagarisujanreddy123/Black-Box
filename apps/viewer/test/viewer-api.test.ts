import { BlackBoxEventSchema, LiveEventReadySchema } from "@blackbox/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  ViewerApiClient,
  parseServerEvents,
  type ParsedServerEvent,
} from "../src/api.js";

function event(sequence: number) {
  return BlackBoxEventSchema.parse({
    schemaVersion: 1,
    id: `event-viewer-${sequence}`,
    sessionId: "session-viewer",
    sequence,
    occurredAt: "2026-07-16T12:00:00.000Z",
    observedAt: "2026-07-16T12:00:00.000Z",
    source: "proxy",
    type: "message.assistant",
    evidence: "observed",
    summary: { text: "safe event" },
    redaction: { applied: false, ruleIds: [] },
  });
}

function chunks(parts: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(encoder.encode(part));
      }
      controller.close();
    },
  });
}

describe("viewer API transport", () => {
  it("parses SSE records across CRLF and transport boundaries", async () => {
    const ready = LiveEventReadySchema.parse({
      schemaVersion: 1,
      sessionId: "session-viewer",
      afterSequence: 1,
    });
    const second = event(2);
    const frames: ParsedServerEvent[] = [];
    for await (const frame of parseServerEvents(
      chunks([
        "retry: 1000\r\nevent: blackbox.ready\r",
        `\ndata: ${JSON.stringify(ready)}\r\n\r`,
        `\nid: 2\nevent: blackbox.event\ndata: ${JSON.stringify(second)}\n`,
        "\n: keepalive\r\n\r\n",
      ]),
    )) {
      frames.push(frame);
    }

    expect(frames).toEqual([
      {
        event: "blackbox.ready",
        data: JSON.stringify(ready),
      },
      {
        event: "blackbox.event",
        id: "2",
        data: JSON.stringify(second),
      },
    ]);
  });

  it("keeps the bearer token in headers rather than query strings", async () => {
    const observations: Array<{ url: string; headers: Headers }> = [];
    const fetcher: typeof fetch = (input, init) => {
      observations.push({
        url: String(input),
        headers: new Headers(init?.headers),
      });
      return Promise.resolve(
        new Response(JSON.stringify({ schemaVersion: 1, sessions: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    const token = "c".repeat(43);
    const api = new ViewerApiClient("http://127.0.0.1:4142", token, fetcher);

    await expect(api.listSessions({ limit: 25 })).resolves.toMatchObject({
      sessions: [],
    });
    expect(observations[0]?.url).toBe(
      "http://127.0.0.1:4142/v1/sessions?limit=25",
    );
    expect(observations[0]?.url).not.toContain(token);
    expect(observations[0]?.headers.get("authorization")).toBe(
      `Bearer ${token}`,
    );
  });

  it("binds the browser fetch receiver", async () => {
    const original = globalThis.fetch;
    const token = "e".repeat(43);
    vi.stubGlobal("fetch", function (this: unknown) {
      expect(this).toBe(globalThis);
      return Promise.resolve(
        new Response(JSON.stringify({ schemaVersion: 1, sessions: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    } as typeof fetch);
    try {
      const api = new ViewerApiClient("http://127.0.0.1:4142", token);
      await expect(api.listSessions()).resolves.toMatchObject({ sessions: [] });
    } finally {
      vi.stubGlobal("fetch", original);
    }
  });
});
