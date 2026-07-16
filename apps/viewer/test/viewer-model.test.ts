import { Buffer } from "node:buffer";

import { BlackBoxEventSchema, type BlackBoxEvent } from "@blackbox/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { parseViewerBootstrap } from "../src/bootstrap.js";
import { decodeFileDelta } from "../src/diff.js";
import { JsonBlock } from "../src/inspector.js";
import { TimelineView } from "../src/timeline-view.js";
import {
  classifyEvent,
  eventPreview,
  mergeTimelineEvents,
} from "../src/timeline.js";

const TIME = "2026-07-16T12:00:00.000Z";

function event(
  sequence: number,
  input: {
    readonly source?: BlackBoxEvent["source"];
    readonly type?: string;
    readonly summary?: Record<string, unknown>;
  } = {},
): BlackBoxEvent {
  return BlackBoxEventSchema.parse({
    schemaVersion: 1,
    id: `event-view-${sequence}`,
    sessionId: "session-view",
    sequence,
    occurredAt: TIME,
    observedAt: TIME,
    source: input.source ?? "proxy",
    type: input.type ?? "message.assistant",
    evidence: "observed",
    summary: input.summary ?? { text: `event ${sequence}` },
    redaction: { applied: false, ruleIds: [] },
  });
}

describe("viewer evidence model", () => {
  it("classifies lanes and merges replayed live evidence stably", () => {
    expect(classifyEvent(event(1))).toBe("model");
    expect(classifyEvent(event(2, { type: "tool.call" }))).toBe("tools");
    expect(
      classifyEvent(event(3, { source: "filesystem", type: "file.modify" })),
    ).toBe("system");
    expect(
      classifyEvent(event(4, { source: "filesystem", type: "file.delete" })),
    ).toBe("risk");
    expect(classifyEvent(event(5, { type: "usage.reported" }))).toBe("context");
    expect(
      mergeTimelineEvents([event(2)], [event(1), event(2), event(3)]).map(
        (item) => item.sequence,
      ),
    ).toEqual([1, 2, 3]);
  });

  it("decodes retained text states for a file diff", () => {
    const before = Buffer.from("one\ntwo\n", "utf8");
    const after = Buffer.from("one\nthree\n", "utf8");
    const decoded = decodeFileDelta(
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          path: "README.md",
          operation: "modify",
          before: {
            sha256: "a".repeat(64),
            byteLength: before.byteLength,
            encoding: "base64",
            content: before.toString("base64"),
          },
          after: {
            sha256: "b".repeat(64),
            byteLength: after.byteLength,
            encoding: "base64",
            content: after.toString("base64"),
          },
        }),
      ),
    );

    expect(decoded.before).toMatchObject({ kind: "text", text: "one\ntwo\n" });
    expect(decoded.after).toMatchObject({ kind: "text", text: "one\nthree\n" });
  });

  it("moves fragment credentials out of the visible URL", () => {
    const token = "d".repeat(43);
    const bootstrap = parseViewerBootstrap(
      new URL(
        `http://127.0.0.1:4142/?mode=local#token=${token}&session=session-live`,
      ),
    );

    expect(bootstrap).toEqual({
      token,
      sessionId: "session-live",
      cleanPath: "/?mode=local&session=session-live",
    });
    expect(bootstrap.cleanPath).not.toContain(token);
  });

  it("renders recorded markup as inert text", () => {
    const malicious = "<script>globalThis.compromised = true</script>";
    const html = renderToStaticMarkup(
      createElement(JsonBlock, { value: { text: malicious } }),
    );

    expect(eventPreview(event(1, { summary: { text: malicious } }))).toBe(
      malicious,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders only a bounded window for a 10,000-event timeline", () => {
    const events = Array.from({ length: 10_000 }, (_, index) =>
      event(index + 1),
    );
    const html = renderToStaticMarkup(
      createElement(TimelineView, {
        events,
        sessionStartedAt: TIME,
        timestampMode: "relative",
        accessibleMode: false,
        onSelect: () => undefined,
      }),
    );
    const renderedRows = html.match(/<li/gmu)?.length ?? 0;

    expect(renderedRows).toBeGreaterThan(0);
    expect(renderedRows).toBeLessThan(100);
    expect(html).toContain("event 1");
    expect(html).not.toContain("event 10000");
  });
});
