import { createHash } from "node:crypto";

import {
  ANOMALY_ANALYZER_VERSION,
  DETERMINISTIC_SCORING_VERSION,
  DeterministicAnalyzer,
  isAnalyzableTarget,
  normalizedTargetForEvent,
  type AnalysisContextWindow,
} from "@blackbox/analysis";
import { ContextReconstructor } from "@blackbox/context";
import {
  BlameAnalysisSchema,
  ContextResultSchema,
  EventDetailSchema,
  EventListQuerySchema,
  EventPageSchema,
  EventSearchQuerySchema,
  EventSearchResultSchema,
  FileChangeListQuerySchema,
  FileChangePageSchema,
  IdentifierSchema,
  LiveEventCursorSchema,
  SessionDetailSchema,
  SessionListQuerySchema,
  SessionPageSchema,
  WorkspaceFileChangeSummarySchema,
  type BlobReference,
  type BlameAnalysis,
  type EventDetail,
  type EventListQueryInput,
  type EventPage,
  type EventSearchQueryInput,
  type EventSearchResult,
  type FileChangeListQueryInput,
  type FileChangePage,
  type BlackBoxEvent,
  type ContextResult,
  type SessionDetail,
  type SessionListQueryInput,
  type SessionPage,
} from "@blackbox/protocol";
import type { BlackBoxStorage } from "@blackbox/storage";

const DETERMINISTIC_ANALYZER_ID = `${DETERMINISTIC_SCORING_VERSION}+${ANOMALY_ANALYZER_VERSION}`;
const ANALYSIS_MEDIA_TYPE = "application/vnd.blackbox.blame+json";
const MAXIMUM_ANALYSIS_EVENTS = 5_000;
const MAXIMUM_BLAME_CANDIDATES = 500;

export class EvidenceQueryNotFoundError extends Error {
  constructor(
    readonly kind: "session" | "event" | "payload",
    readonly id: string,
  ) {
    super(
      `${kind[0]?.toUpperCase() ?? "E"}${kind.slice(1)} ${id} was not found.`,
    );
    this.name = "EvidenceQueryNotFoundError";
  }
}

export class EvidencePayloadTooLargeError extends Error {
  constructor(
    readonly reference: BlobReference,
    readonly maximumBytes: number,
  ) {
    super(
      `Payload ${reference.id} is ${reference.byteLength} bytes; the query limit is ${maximumBytes} bytes.`,
    );
    this.name = "EvidencePayloadTooLargeError";
  }
}

export interface EvidencePayload {
  readonly reference: BlobReference;
  readonly bytes: Uint8Array;
}

function literalFtsQuery(query: string): string {
  return query
    .split(/\s+/u)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" AND ");
}

function collectVisibleStrings(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectVisibleStrings(item, output);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) {
      collectVisibleStrings(item, output);
    }
  }
}

function analysisRunId(sessionId: string, targetEventId: string): string {
  const digest = createHash("sha256")
    .update(
      `${sessionId}\u0000${targetEventId}\u0000${DETERMINISTIC_ANALYZER_ID}`,
    )
    .digest("hex");
  return `analysis-blame-${digest}`;
}

function normalizedEvidencePath(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/^\.\//u, "").toLowerCase();
}

function relatedInvocation(
  events: readonly BlackBoxEvent[],
  target: BlackBoxEvent,
): BlackBoxEvent {
  if (target.type === "tool.call") {
    return target;
  }
  const byId = new Map(events.map((event) => [event.id, event]));
  const parent =
    target.parentId === undefined ? undefined : byId.get(target.parentId);
  if (parent?.type === "tool.call") {
    return parent;
  }
  const grandparent =
    parent?.parentId === undefined ? undefined : byId.get(parent.parentId);
  if (grandparent?.type === "tool.call") {
    return grandparent;
  }
  const targetPath = normalizedTargetForEvent(target).path;
  const candidates = events
    .filter(
      (event) => event.type === "tool.call" && event.sequence < target.sequence,
    )
    .map((event) => {
      let score = 0;
      if (
        target.correlationId !== undefined &&
        event.correlationId === target.correlationId
      ) {
        score += 2;
      }
      const candidatePath = normalizedTargetForEvent(event).path;
      if (
        targetPath !== undefined &&
        candidatePath !== undefined &&
        normalizedEvidencePath(candidatePath) ===
          normalizedEvidencePath(targetPath)
      ) {
        score += 1;
      }
      return { event, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || right.event.sequence - left.event.sequence,
    );
  return candidates[0]?.event ?? target;
}

export class EvidenceQueryService {
  private readonly context: ContextReconstructor;
  private readonly analyzer = new DeterministicAnalyzer();

  constructor(private readonly storage: BlackBoxStorage) {
    this.context = new ContextReconstructor({
      getEvent: (eventId) => this.storage.events.get(eventId),
      getEventOrigin: (eventId) => this.storage.events.getOrigin(eventId),
      getExchange: (exchangeId) => this.storage.rawExchanges.get(exchangeId),
      getEventsForExchange: (exchangeId) =>
        this.storage.events.listForExchange(exchangeId),
      findResponseEvent: (sessionId, responseId) =>
        this.storage.events.findResponseEvent(sessionId, responseId),
      getPayload: (payloadId) => this.storage.blobs.get(payloadId),
    });
  }

  listSessions(input: SessionListQueryInput = {}): SessionPage {
    const query = SessionListQuerySchema.parse(input);
    const page = this.storage.sessions.listPage({
      limit: query.limit,
      includeInternal: query.includeInternal,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    return SessionPageSchema.parse({
      schemaVersion: 1,
      sessions: page.sessions,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
  }

  getSession(sessionId: string): SessionDetail {
    const id = IdentifierSchema.parse(sessionId);
    const session = this.storage.sessions.get(id);
    if (session === undefined) {
      throw new EvidenceQueryNotFoundError("session", id);
    }
    return SessionDetailSchema.parse({ schemaVersion: 1, session });
  }

  listEvents(sessionId: string, input: EventListQueryInput = {}): EventPage {
    const { session } = this.getSession(sessionId);
    const query = EventListQuerySchema.parse(input);
    const page = this.storage.events.list(session.id, {
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.source === undefined ? {} : { source: query.source }),
      ...(query.occurredAfter === undefined
        ? {}
        : { occurredAfter: query.occurredAfter }),
      ...(query.occurredBefore === undefined
        ? {}
        : { occurredBefore: query.occurredBefore }),
    });
    return EventPageSchema.parse({
      schemaVersion: 1,
      sessionId: session.id,
      events: page.events,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
  }

  getEvent(eventId: string): EventDetail {
    const id = IdentifierSchema.parse(eventId);
    const event = this.storage.events.get(id);
    if (event === undefined) {
      throw new EvidenceQueryNotFoundError("event", id);
    }
    const origin = this.storage.events.getOrigin(id);
    const rawExchange =
      origin?.rawExchangeId === undefined
        ? undefined
        : this.storage.rawExchanges.get(origin.rawExchangeId);
    const parsedChange = event.type.startsWith("file.")
      ? WorkspaceFileChangeSummarySchema.safeParse(event.summary)
      : undefined;
    return EventDetailSchema.parse({
      schemaVersion: 1,
      event,
      ...(parsedChange?.success === true
        ? { fileChange: parsedChange.data }
        : {}),
      ...(rawExchange === undefined ? {} : { rawExchange }),
      ...(origin?.normalizationVersion === undefined
        ? {}
        : { normalizationVersion: origin.normalizationVersion }),
    });
  }

  async getContext(eventId: string): Promise<ContextResult> {
    const { event } = this.getEvent(eventId);
    if (event.type !== "model.request") {
      throw new RangeError(
        "Context is only available for model.request events.",
      );
    }
    return ContextResultSchema.parse(await this.context.reconstruct(event.id));
  }

  async getBlame(eventId: string): Promise<BlameAnalysis> {
    const { event } = this.getEvent(eventId);
    if (!isAnalyzableTarget(event)) {
      throw new RangeError(
        "Blame analysis is only available for tool invocations and file actions.",
      );
    }
    const cached = await this.getCachedBlame(event.sessionId, event.id);
    if (cached !== undefined) {
      return cached;
    }
    const { session } = this.getSession(event.sessionId);
    const window = this.storage.events.listThroughSequence(
      session.id,
      event.sequence,
      MAXIMUM_ANALYSIS_EVENTS,
    );
    const invocation = relatedInvocation(window.events, event);
    const invocationOrigin = this.storage.events.getOrigin(invocation.id);
    const requestEvent =
      invocationOrigin?.rawExchangeId === undefined
        ? invocation.source === "proxy"
          ? [...window.events]
              .reverse()
              .find(
                (candidate) =>
                  candidate.type === "model.request" &&
                  candidate.sequence <= invocation.sequence,
              )
          : undefined
        : this.storage.events
            .listForExchange(invocationOrigin.rawExchangeId)
            .find((candidate) => candidate.type === "model.request");
    let context: AnalysisContextWindow | undefined;
    if (requestEvent !== undefined) {
      try {
        const reconstructed = await this.context.reconstruct(requestEvent.id);
        const visibleTexts: string[] = [];
        for (const item of reconstructed.items) {
          collectVisibleStrings(item.summary, visibleTexts);
        }
        context = {
          completeness: reconstructed.completeness,
          limitationReasons: reconstructed.limitationReasons,
          requestEventId: reconstructed.requestEventId,
          availableEventIds: reconstructed.items.flatMap((item) =>
            item.provenance.eventId === undefined
              ? []
              : [item.provenance.eventId],
          ),
          visibleTexts,
        };
      } catch {
        context = {
          completeness: "unknown-unsupported",
          limitationReasons: [
            "The nearest recorded model request could not be reconstructed for this target.",
          ],
          requestEventId: requestEvent.id,
        };
      }
    }
    const result = this.analyzer.analyze({
      session,
      events: window.events,
      targetEventId: event.id,
      ...(context === undefined ? {} : { context }),
      provenanceEdges: this.storage.contextEdges
        .listForTarget(session.id, event.id)
        .map((edge) => ({
          from: edge.fromEventId,
          to: edge.toEventId,
          relation: edge.edgeType,
        })),
      limitations: window.truncated
        ? [
            `Analysis was bounded to the ${MAXIMUM_ANALYSIS_EVENTS} events nearest the target.`,
          ]
        : [],
      maximumCandidates: MAXIMUM_BLAME_CANDIDATES,
    });
    if (this.storage.readOnly) {
      return result;
    }
    const serialized = JSON.stringify(result);
    const resultBlob = await this.storage.blobs.put(serialized, {
      mediaType: ANALYSIS_MEDIA_TYPE,
    });
    const completedAt = new Date().toISOString();
    const stored = this.storage.analysisRuns.insertIfAbsent({
      schemaVersion: 1,
      id: analysisRunId(session.id, event.id),
      sessionId: session.id,
      kind: "blame",
      targetEventId: event.id,
      status: "completed",
      analyzer: DETERMINISTIC_ANALYZER_ID,
      startedAt: completedAt,
      endedAt: completedAt,
      resultBlobId: resultBlob.id,
    }).record;
    if (stored.resultBlobId === undefined) {
      throw new Error(
        `Completed analysis run ${stored.id} has no result payload.`,
      );
    }
    if (stored.resultBlobId !== resultBlob.id) {
      return this.readBlameBlob(stored.resultBlobId);
    }
    return result;
  }

  private async getCachedBlame(
    sessionId: string,
    targetEventId: string,
  ): Promise<BlameAnalysis | undefined> {
    const run = this.storage.analysisRuns.findCompleted(
      sessionId,
      "blame",
      targetEventId,
      DETERMINISTIC_ANALYZER_ID,
    );
    return run?.resultBlobId === undefined
      ? undefined
      : this.readBlameBlob(run.resultBlobId);
  }

  private async readBlameBlob(blobId: string): Promise<BlameAnalysis> {
    const bytes = await this.storage.blobs.get(blobId);
    return BlameAnalysisSchema.parse(
      JSON.parse(Buffer.from(bytes).toString("utf8")),
    );
  }

  listFileChanges(
    sessionId: string,
    input: FileChangeListQueryInput = {},
  ): FileChangePage {
    const { session } = this.getSession(sessionId);
    const query = FileChangeListQuerySchema.parse(input);
    const page = this.storage.events.list(session.id, {
      limit: query.limit,
      source: "filesystem",
      typePrefix: "file.",
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    return FileChangePageSchema.parse({
      schemaVersion: 1,
      sessionId: session.id,
      changes: page.events.map((event) => {
        const change = WorkspaceFileChangeSummarySchema.safeParse(
          event.summary,
        );
        return { event, change: change.success ? change.data : null };
      }),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
  }

  listEventsAfterSequence(
    sessionId: string,
    afterSequence: number,
    limit: number,
  ): BlackBoxEvent[] {
    const id = IdentifierSchema.parse(sessionId);
    const cursor = LiveEventCursorSchema.parse(afterSequence);
    return this.storage.events.listAfterSequence(id, cursor, limit);
  }

  searchEvents(
    sessionId: string,
    input: EventSearchQueryInput,
  ): EventSearchResult {
    const { session } = this.getSession(sessionId);
    const query = EventSearchQuerySchema.parse(input);
    return EventSearchResultSchema.parse({
      schemaVersion: 1,
      sessionId: session.id,
      query: query.query,
      events: this.storage.events.search(
        session.id,
        literalFtsQuery(query.query),
        query.limit,
      ),
    });
  }

  async getPayload(
    payloadId: string,
    maximumBytes: number,
  ): Promise<EvidencePayload> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new RangeError("Maximum query payload bytes must be positive.");
    }
    const id = IdentifierSchema.parse(payloadId);
    const reference = this.storage.blobs.describe(id);
    if (reference === undefined) {
      throw new EvidenceQueryNotFoundError("payload", id);
    }
    if (reference.byteLength > maximumBytes) {
      throw new EvidencePayloadTooLargeError(reference, maximumBytes);
    }
    return { reference, bytes: await this.storage.blobs.get(id) };
  }
}
