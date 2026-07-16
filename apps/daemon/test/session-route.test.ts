import { describe, expect, it } from "vitest";

import {
  parseSessionScopedPath,
  sessionScopedProxyBaseUrl,
} from "../src/index.js";

describe("session-scoped proxy routes", () => {
  it("round-trips a session identity without exposing it as a provider path", () => {
    const base = new URL(
      sessionScopedProxyBaseUrl(
        "http://127.0.0.1:4141",
        "session-wrapper-fixture",
      ),
    );

    expect(parseSessionScopedPath(`${base.pathname}/responses`)).toEqual({
      sessionId: "session-wrapper-fixture",
      path: "/v1/responses",
    });
  });

  it("rejects malformed tokens and non-v1 provider paths", () => {
    expect(
      parseSessionScopedPath("/.blackbox/session/not+base64/v1/responses"),
    ).toBeUndefined();
    expect(
      parseSessionScopedPath("/.blackbox/session/c2Vzc2lvbi0x/private"),
    ).toBeUndefined();
  });
});
