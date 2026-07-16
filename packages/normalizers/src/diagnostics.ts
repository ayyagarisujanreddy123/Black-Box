import {
  NormalizationResultSchema,
  type CanonicalEventDraft,
  type NormalizationExchange,
  type NormalizationOptions,
  type NormalizationResult,
  type ParserDiagnostic,
} from "./contracts.js";
import { canonicalEventId, materializeCanonicalEvents } from "./events.js";

function alreadyRepresented(
  result: NormalizationResult,
  diagnostic: ParserDiagnostic,
): boolean {
  const expectedType =
    diagnostic.kind === "duplicate-replay"
      ? "parser.replay_ignored"
      : diagnostic.kind === "capture-incomplete"
        ? "capture.incomplete"
        : "parser.error";
  return result.events.some(
    (event) =>
      event.type === expectedType &&
      (diagnostic.frameIndex === undefined ||
        event.summary.frameIndex === diagnostic.frameIndex),
  );
}

function diagnosticDraft(
  parserId: string,
  diagnostic: ParserDiagnostic,
): CanonicalEventDraft | undefined {
  if (diagnostic.kind === "unsupported-event") {
    return undefined;
  }
  if (diagnostic.kind === "incomplete-sse" && !diagnostic.fatal) {
    return undefined;
  }
  const summary = {
    parser: parserId,
    kind: diagnostic.kind,
    message: diagnostic.message,
    ...(diagnostic.frameIndex === undefined
      ? {}
      : { frameIndex: diagnostic.frameIndex }),
    ...(diagnostic.eventType === undefined
      ? {}
      : { eventType: diagnostic.eventType }),
  };
  if (diagnostic.kind === "duplicate-replay") {
    return {
      type: "parser.replay_ignored",
      evidence: "derived",
      summary,
    };
  }
  if (diagnostic.kind === "capture-incomplete") {
    return {
      type: "capture.incomplete",
      evidence: "derived",
      summary,
    };
  }
  return { type: "parser.error", evidence: "derived", summary };
}

export function appendDiagnosticEvidence(
  exchange: NormalizationExchange,
  result: NormalizationResult,
  options: NormalizationOptions = {},
): NormalizationResult {
  const drafts = result.diagnostics.flatMap((diagnostic) => {
    if (alreadyRepresented(result, diagnostic)) {
      return [];
    }
    const draft = diagnosticDraft(result.parserId, diagnostic);
    return draft === undefined ? [] : [draft];
  });
  if (drafts.length === 0) {
    return result;
  }

  const offset = result.events.length;
  const firstSequence = (options.firstSequence ?? 1) + offset;
  const eventId = options.eventId ?? canonicalEventId;
  const diagnosticEvents = materializeCanonicalEvents(exchange, drafts, {
    ...options,
    firstSequence,
    eventId: (input, ordinal) => eventId(input, offset + ordinal),
  });
  return NormalizationResultSchema.parse({
    ...result,
    events: [...result.events, ...diagnosticEvents],
  });
}
