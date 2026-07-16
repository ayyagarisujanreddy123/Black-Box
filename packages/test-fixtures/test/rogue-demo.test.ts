import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  BlackBoxEventSchema,
  SessionSchema,
} from "../../protocol/src/index.js";

interface RogueTranscript {
  readonly session: unknown;
  readonly events: readonly unknown[];
  readonly expectedInvestigation: {
    readonly targetEventId: string;
    readonly topCandidateEventId: string;
  };
}

const transcriptUrl = new URL(
  "../../../demo/transcripts/rogue-session.json",
  import.meta.url,
);
const readmeUrl = new URL(
  "../../../demo/rogue-repo-template/README.md",
  import.meta.url,
);
const testFileUrl = new URL(
  "../../../demo/rogue-repo-template/test/math.test.js",
  import.meta.url,
);

async function loadTranscript(): Promise<RogueTranscript> {
  const contents = await readFile(transcriptUrl, "utf8");
  return JSON.parse(contents) as RogueTranscript;
}

describe("deterministic rogue demo fixture", () => {
  it("ships with the test file intact", async () => {
    await expect(readFile(testFileUrl, "utf8")).resolves.toContain(
      "adds two numbers",
    );
  });

  it("contains valid session and canonical event contracts", async () => {
    const transcript = await loadTranscript();

    expect(SessionSchema.safeParse(transcript.session).success).toBe(true);
    expect(transcript.events).toHaveLength(9);

    for (const event of transcript.events) {
      expect(BlackBoxEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it("links the exact poisoned line to a later deletion target", async () => {
    const transcript = await loadTranscript();
    const events = transcript.events.map((event) =>
      BlackBoxEventSchema.parse(event),
    );
    const readResult = events.find(
      (event) =>
        event.id === transcript.expectedInvestigation.topCandidateEventId,
    );
    const deletion = events.find(
      (event) => event.id === transcript.expectedInvestigation.targetEventId,
    );
    const readmeLines = (await readFile(readmeUrl, "utf8")).split("\n");

    expect(readResult).toBeDefined();
    expect(deletion).toBeDefined();
    expect(readResult?.sequence).toBeLessThan(deletion?.sequence ?? 0);
    expect(readResult?.summary.content).toBe(readmeLines[6]);
    expect(deletion?.type).toBe("file.delete");
    expect(deletion?.summary.path).toBe("test/math.test.js");
  });
});
