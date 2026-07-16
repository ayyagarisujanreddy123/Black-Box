import { describe, expect, it } from "vitest";

import { Sessionizer } from "../src/index.js";

function deterministicSessionizer(idleWindowMilliseconds = 100): Sessionizer {
  let ordinal = 0;
  return new Sessionizer({
    idleWindowMilliseconds,
    createSessionId: (source) => `session-${source}-${++ordinal}`,
  });
}

describe("sessionization precedence", () => {
  it("isolates analysis before applying explicit, adapter, or ancestry signals", () => {
    const sessionizer = deterministicSessionizer();
    sessionizer.registerResponse("resp_parent", "session-parent");

    const decision = sessionizer.resolve({
      analysisSessionId: "analysis-run-1",
      analysisTargetSessionId: "session-investigated",
      explicitSessionId: "session-explicit",
      adapterSessionId: "agent-session",
      ancestorResponseIds: ["resp_parent"],
      clientFingerprint: "client",
      manualSessionId: "session-manual",
    });

    expect(decision).toEqual({
      sessionId: "session-analysis-1",
      source: "analysis",
      internalAnalysis: true,
      analysisTargetSessionId: "session-investigated",
    });
  });

  it("prefers explicit, then adapter, then known ancestry", () => {
    const sessionizer = deterministicSessionizer();
    sessionizer.registerResponse("resp_parent", "session-parent");

    expect(
      sessionizer.resolve({
        explicitSessionId: "session-explicit",
        adapterSessionId: "agent-session",
        ancestorResponseIds: ["resp_parent"],
        clientFingerprint: "client",
      }),
    ).toMatchObject({ sessionId: "session-explicit", source: "explicit" });
    expect(
      sessionizer.resolve({
        adapterSessionId: "agent-session",
        ancestorResponseIds: ["resp_parent"],
        clientFingerprint: "client",
      }),
    ).toMatchObject({ sessionId: "session-adapter-1", source: "adapter" });
    expect(
      sessionizer.resolve({
        ancestorResponseIds: ["missing", "resp_parent"],
        clientFingerprint: "client",
      }),
    ).toMatchObject({
      sessionId: "session-parent",
      source: "ancestry",
      matchedAncestorResponseId: "resp_parent",
    });
  });

  it("groups a client inside the idle window and starts a new heuristic session after it", () => {
    const sessionizer = deterministicSessionizer(100);
    const first = sessionizer.resolve(
      { clientFingerprint: "client", manualSessionId: "session-manual" },
      1_000,
    );
    const continued = sessionizer.resolve(
      { clientFingerprint: "client", manualSessionId: "session-manual" },
      1_100,
    );
    const next = sessionizer.resolve(
      { clientFingerprint: "client", manualSessionId: "session-manual" },
      1_201,
    );

    expect(first).toMatchObject({
      sessionId: "session-heuristic-1",
      source: "heuristic",
    });
    expect(continued.sessionId).toBe(first.sessionId);
    expect(next).toMatchObject({
      sessionId: "session-heuristic-2",
      source: "heuristic",
    });
    expect(
      sessionizer.resolve({ manualSessionId: "session-manual" }),
    ).toMatchObject({ sessionId: "session-manual", source: "manual" });
  });

  it("keeps adapter and analysis mappings stable and rejects response reassignment", () => {
    const sessionizer = deterministicSessionizer();

    const adapter = sessionizer.resolve({ adapterSessionId: "agent-1" });
    expect(sessionizer.resolve({ adapterSessionId: "agent-1" }).sessionId).toBe(
      adapter.sessionId,
    );
    const analysis = sessionizer.resolve({
      analysisSessionId: "analysis-1",
    });
    expect(
      sessionizer.resolve({ analysisSessionId: "analysis-1" }).sessionId,
    ).toBe(analysis.sessionId);

    sessionizer.registerResponse("resp_1", "session-one");
    expect(() => sessionizer.registerResponse("resp_1", "session-two")).toThrow(
      /already assigned/u,
    );
    expect(sessionizer.knownResponseIds()).toEqual(new Set(["resp_1"]));
  });
});
