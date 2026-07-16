import { describe, expect, it } from "vitest";

import {
  EventListQuerySchema,
  QueryErrorSchema,
  SessionListQuerySchema,
  SessionPageSchema,
} from "../src/index.js";

const TIME = "2026-07-16T12:00:00.000Z";

describe("local evidence query contracts", () => {
  it("applies bounded query defaults", () => {
    expect(SessionListQuerySchema.parse({})).toEqual({
      limit: 100,
      includeInternal: false,
    });
    expect(EventListQuerySchema.parse({})).toEqual({ limit: 100 });
    expect(() => SessionListQuerySchema.parse({ limit: 1001 })).toThrow();
  });

  it("rejects a reversed event time window", () => {
    expect(
      EventListQuerySchema.safeParse({
        occurredAfter: "2026-07-16T12:00:01.000Z",
        occurredBefore: TIME,
      }).success,
    ).toBe(false);
  });

  it("uses current session records in cursor pages", () => {
    const page = SessionPageSchema.parse({
      schemaVersion: 1,
      sessions: [
        {
          schemaVersion: 1,
          id: "session-query",
          startedAt: TIME,
          status: "active",
          captureLevel: "api",
          models: [],
          tags: [],
          counts: {
            events: 0,
            errors: 0,
            inputTokens: null,
            outputTokens: null,
          },
          metadata: {},
        },
      ],
      nextCursor: "opaque-cursor",
    });
    expect(page.sessions[0]?.id).toBe("session-query");
  });

  it("keeps public error responses narrowly typed", () => {
    expect(
      QueryErrorSchema.parse({
        error: "bad_request",
        message: "Invalid cursor.",
      }),
    ).toEqual({ error: "bad_request", message: "Invalid cursor." });
    expect(
      QueryErrorSchema.safeParse({ error: "bad_request", details: {} }).success,
    ).toBe(false);
  });
});
