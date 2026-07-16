import type { ParserDiagnostic } from "./contracts.js";
import type { SseFrame } from "./sse.js";

type JsonRecord = Record<string, unknown>;

export type SseReplayDisposition =
  | { readonly kind: "accept" }
  | {
      readonly kind: "replay" | "conflict";
      readonly diagnostic: ParserDiagnostic;
    };

function replayIdentity(
  frame: SseFrame,
  payload: JsonRecord,
): string | undefined {
  if (frame.id !== undefined && frame.id.length > 0) {
    return `sse-id:${frame.id}`;
  }
  if (typeof payload.event_id === "string" && payload.event_id.length > 0) {
    return `event-id:${payload.event_id}`;
  }
  if (
    typeof payload.sequence_number === "number" &&
    Number.isInteger(payload.sequence_number) &&
    payload.sequence_number >= 0
  ) {
    return `sequence-number:${payload.sequence_number}`;
  }
  return undefined;
}

function displayIdentity(identity: string): string {
  return identity.length <= 256 ? identity : `${identity.slice(0, 253)}...`;
}

export class SseReplayDetector {
  private readonly seen = new Map<string, string>();

  observe(
    frame: SseFrame,
    payload: JsonRecord,
    eventType?: string,
  ): SseReplayDisposition {
    const identity = replayIdentity(frame, payload);
    if (identity === undefined) {
      return { kind: "accept" };
    }

    const fingerprint = `${frame.event ?? ""}\0${frame.data ?? ""}`;
    const previous = this.seen.get(identity);
    if (previous === undefined) {
      this.seen.set(identity, fingerprint);
      return { kind: "accept" };
    }

    const replay = previous === fingerprint;
    return {
      kind: replay ? "replay" : "conflict",
      diagnostic: {
        kind: replay ? "duplicate-replay" : "duplicate-conflict",
        message: replay
          ? `Ignored replayed SSE payload with identity ${displayIdentity(identity)}.`
          : `Ignored conflicting SSE payload with identity ${displayIdentity(identity)}; the first payload remains authoritative.`,
        frameIndex: frame.index,
        ...(eventType === undefined ? {} : { eventType }),
        fatal: !replay,
      },
    };
  }
}
