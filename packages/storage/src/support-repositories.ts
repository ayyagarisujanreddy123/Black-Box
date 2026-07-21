import type Database from "better-sqlite3";

import { ImmutableEvidenceError } from "./errors.js";
import {
  AnalysisRunRecordSchema,
  ContextEdgeRecordSchema,
  FileChangeRecordSchema,
  RedactionRecordSchema,
  type AnalysisRunRecord,
  type ContextEdgeRecord,
  type FileChangeRecord,
  type RedactionRecord,
} from "./records.js";

interface RecordJsonRow {
  readonly record_json: string;
}

export class FileChangeRepository {
  constructor(private readonly database: Database.Database) {}

  insert(input: FileChangeRecord): FileChangeRecord {
    const record = FileChangeRecordSchema.parse(input);
    this.database
      .prepare(
        `INSERT INTO file_changes(
           event_id, schema_version, path, operation, previous_path,
           before_hash, after_hash, patch_blob_id, timing_precision,
           sensitivity, record_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.eventId,
        record.schemaVersion,
        record.path,
        record.operation,
        record.previousPath ?? null,
        record.beforeHash ?? null,
        record.afterHash ?? null,
        record.patchBlobId ?? null,
        record.timingPrecision,
        record.sensitivity,
        JSON.stringify(record),
      );
    return record;
  }

  getByEvent(eventId: string): FileChangeRecord | undefined {
    const row = this.database
      .prepare("SELECT record_json FROM file_changes WHERE event_id = ?")
      .get(eventId) as RecordJsonRow | undefined;
    return row === undefined
      ? undefined
      : FileChangeRecordSchema.parse(JSON.parse(row.record_json));
  }
}

export class ContextEdgeRepository {
  constructor(private readonly database: Database.Database) {}

  insert(input: ContextEdgeRecord): ContextEdgeRecord {
    const record = ContextEdgeRecordSchema.parse(input);
    this.database
      .prepare(
        `INSERT INTO context_edges(
           session_id, from_event_id, to_event_id, edge_type, evidence,
           schema_version, metadata_json, record_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.sessionId,
        record.fromEventId,
        record.toEventId,
        record.edgeType,
        record.evidence,
        record.schemaVersion,
        JSON.stringify(record.metadata),
        JSON.stringify(record),
      );
    return record;
  }

  listForTarget(sessionId: string, toEventId: string): ContextEdgeRecord[] {
    const rows = this.database
      .prepare(
        `SELECT record_json FROM context_edges
         WHERE session_id = ? AND to_event_id = ?
         ORDER BY from_event_id, edge_type`,
      )
      .all(sessionId, toEventId) as RecordJsonRow[];
    return rows.map((row) =>
      ContextEdgeRecordSchema.parse(JSON.parse(row.record_json)),
    );
  }
}

export class AnalysisRunRepository {
  constructor(private readonly database: Database.Database) {}

  insert(input: AnalysisRunRecord): AnalysisRunRecord {
    const record = AnalysisRunRecordSchema.parse(input);
    this.database
      .prepare(
        `INSERT INTO analysis_runs(
           id, session_id, schema_version, kind, target_event_id, status,
           analyzer, prompt_version, started_at, ended_at, result_blob_id,
           error, record_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.sessionId,
        record.schemaVersion,
        record.kind,
        record.targetEventId ?? null,
        record.status,
        record.analyzer,
        record.promptVersion ?? null,
        record.startedAt,
        record.endedAt ?? null,
        record.resultBlobId ?? null,
        record.error ?? null,
        JSON.stringify(record),
      );
    return record;
  }

  replace(input: AnalysisRunRecord): AnalysisRunRecord {
    const record = AnalysisRunRecordSchema.parse(input);
    const existing = this.get(record.id);
    if (
      existing === undefined ||
      existing.sessionId !== record.sessionId ||
      existing.kind !== record.kind ||
      existing.analyzer !== record.analyzer ||
      existing.startedAt !== record.startedAt ||
      existing.targetEventId !== record.targetEventId ||
      existing.promptVersion !== record.promptVersion
    ) {
      throw new ImmutableEvidenceError(
        `Analysis run ${record.id} does not exist or changed identity.`,
      );
    }
    const result = this.database
      .prepare(
        `UPDATE analysis_runs SET
           status = ?, ended_at = ?, result_blob_id = ?, error = ?,
           record_json = ?
         WHERE id = ? AND session_id = ? AND kind = ? AND analyzer = ?`,
      )
      .run(
        record.status,
        record.endedAt ?? null,
        record.resultBlobId ?? null,
        record.error ?? null,
        JSON.stringify(record),
        record.id,
        record.sessionId,
        record.kind,
        record.analyzer,
      );

    if (result.changes !== 1) {
      throw new ImmutableEvidenceError(
        `Analysis run ${record.id} changed during replacement.`,
      );
    }
    return record;
  }

  get(id: string): AnalysisRunRecord | undefined {
    const row = this.database
      .prepare("SELECT record_json FROM analysis_runs WHERE id = ?")
      .get(id) as RecordJsonRow | undefined;
    return row === undefined
      ? undefined
      : AnalysisRunRecordSchema.parse(JSON.parse(row.record_json));
  }

  findCompleted(
    sessionId: string,
    kind: AnalysisRunRecord["kind"],
    targetEventId: string | undefined,
    analyzer: string,
  ): AnalysisRunRecord | undefined {
    const targetPredicate =
      targetEventId === undefined
        ? "target_event_id IS NULL"
        : "target_event_id = @targetEventId";
    const row = this.database
      .prepare(
        `SELECT record_json
         FROM analysis_runs
         WHERE session_id = @sessionId
           AND kind = @kind
           AND ${targetPredicate}
           AND analyzer = @analyzer
           AND status = 'completed'
           AND result_blob_id IS NOT NULL
         ORDER BY ended_at DESC, id DESC
         LIMIT 1`,
      )
      .get({
        sessionId,
        kind,
        targetEventId: targetEventId ?? null,
        analyzer,
      }) as RecordJsonRow | undefined;
    return row === undefined
      ? undefined
      : AnalysisRunRecordSchema.parse(JSON.parse(row.record_json));
  }

  insertIfAbsent(input: AnalysisRunRecord): {
    readonly record: AnalysisRunRecord;
    readonly inserted: boolean;
  } {
    const record = AnalysisRunRecordSchema.parse(input);
    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO analysis_runs(
           id, session_id, schema_version, kind, target_event_id, status,
           analyzer, prompt_version, started_at, ended_at, result_blob_id,
           error, record_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.sessionId,
        record.schemaVersion,
        record.kind,
        record.targetEventId ?? null,
        record.status,
        record.analyzer,
        record.promptVersion ?? null,
        record.startedAt,
        record.endedAt ?? null,
        record.resultBlobId ?? null,
        record.error ?? null,
        JSON.stringify(record),
      );
    const stored = this.get(record.id);
    if (stored === undefined) {
      throw new ImmutableEvidenceError(
        `Analysis run ${record.id} was not stored.`,
      );
    }
    if (
      stored.sessionId !== record.sessionId ||
      stored.kind !== record.kind ||
      stored.targetEventId !== record.targetEventId ||
      stored.analyzer !== record.analyzer
    ) {
      throw new ImmutableEvidenceError(
        `Analysis run ${record.id} conflicts with existing evidence.`,
      );
    }
    return { record: stored, inserted: result.changes === 1 };
  }
}

export class RedactionRepository {
  constructor(private readonly database: Database.Database) {}

  insert(input: RedactionRecord): RedactionRecord {
    const record = RedactionRecordSchema.parse(input);
    this.database
      .prepare(
        `INSERT INTO redactions(
           id, session_id, schema_version, location, rule_id, replacement,
           hash, record_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.sessionId,
        record.schemaVersion,
        record.location,
        record.ruleId,
        record.replacement,
        record.hash,
        JSON.stringify(record),
      );
    return record;
  }

  listForSession(sessionId: string): RedactionRecord[] {
    const rows = this.database
      .prepare(
        `SELECT record_json FROM redactions
         WHERE session_id = ? ORDER BY id`,
      )
      .all(sessionId) as RecordJsonRow[];
    return rows.map((row) =>
      RedactionRecordSchema.parse(JSON.parse(row.record_json)),
    );
  }
}
