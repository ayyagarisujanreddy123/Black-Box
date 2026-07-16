import {
  EventListQuerySchema,
  EventPageSchema,
  EventSearchQuerySchema,
  EventSearchResultSchema,
  IdentifierSchema,
  SessionDetailSchema,
  SessionListQuerySchema,
  SessionPageSchema,
  type EventListQueryInput,
  type EventPage,
  type EventSearchQueryInput,
  type EventSearchResult,
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
      events: this.storage.events.search(session.id, query.query, query.limit),
    });
  }
}
