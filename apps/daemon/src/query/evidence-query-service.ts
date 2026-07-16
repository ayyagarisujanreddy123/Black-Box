import {
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
  type EventDetail,
  type EventListQueryInput,
  type EventPage,
  type EventSearchQueryInput,
  type EventSearchResult,
  type FileChangeListQueryInput,
  type FileChangePage,
  type BlackBoxEvent,
  type SessionDetail,
  type SessionListQueryInput,
  type SessionPage,
} from "@blackbox/protocol";
import type { BlackBoxStorage } from "@blackbox/storage";

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

export class EvidenceQueryService {
  constructor(private readonly storage: BlackBoxStorage) {}

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
