import { z } from "zod";

import {
  IdentifierSchema,
  IsoTimestampSchema,
  SchemaVersionSchema,
  Sha256Schema,
} from "./common.js";

export const ProcessOutputStreamSchema = z.enum(["stdout", "stderr"]);

export const ProcessStartedSummarySchema = z
  .object({
    pid: z.number().int().positive(),
    parentPid: z.number().int().positive(),
    executable: z.string().min(1),
    arguments: z.array(z.string()),
    cwd: z.string().min(1),
  })
  .strict();

export const ProcessOutputSummarySchema = z
  .object({
    pid: z.number().int().positive(),
    stream: ProcessOutputStreamSchema,
    frameIndex: z.number().int().positive(),
    byteLength: z.number().int().nonnegative(),
    encoding: z.enum(["utf-8", "binary"]),
    truncated: z.boolean(),
  })
  .strict();

export const ProcessExitedSummarySchema = z
  .object({
    pid: z.number().int().positive(),
    exitCode: z.number().int().nullable(),
    signal: z.string().min(1).nullable(),
    success: z.boolean(),
  })
  .strict();

export const ProcessFailureSummarySchema = z
  .object({
    executable: z.string().min(1),
    code: z.string().min(1).optional(),
    message: z.string().min(1).max(4096),
  })
  .strict();

export const ProcessRunConfigurationSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    maxOutputFrameBytes: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024),
    maxUntrackedFileBytes: z
      .number()
      .int()
      .nonnegative()
      .max(1024 * 1024 * 1024),
    watcherDebounceMilliseconds: z.number().int().positive().max(60_000),
    cleanupGraceMilliseconds: z.number().int().positive().max(120_000),
    excludedPathSegments: z.array(z.string().trim().min(1)),
  })
  .strict();

export const WorkspaceBaselineSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    kind: z.enum(["git", "directory"]),
    cwd: z.string().min(1),
    root: z.string().min(1),
    capturedAt: IsoTimestampSchema,
    gitHead: z.string().min(1).nullable().optional(),
    statusSha256: Sha256Schema.optional(),
  })
  .strict();

export const WorkspaceManifestEntrySchema = z
  .object({
    path: z.string().min(1),
    kind: z.enum(["file", "symlink"]),
    byteLength: z.number().int().nonnegative(),
    mode: z.number().int().nonnegative(),
    modifiedAt: IsoTimestampSchema,
    sha256: Sha256Schema,
    tracked: z.boolean(),
  })
  .strict();

export const WorkspaceManifestSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    root: z.string().min(1),
    capturedAt: IsoTimestampSchema,
    entries: z.array(WorkspaceManifestEntrySchema),
  })
  .strict();

export const WorkspaceSnapshotSummarySchema = WorkspaceBaselineSchema.extend({
  phase: z.enum(["baseline", "final"]),
  fileCount: z.number().int().nonnegative(),
  capturedContentBytes: z.number().int().nonnegative(),
  changedFileCount: z.number().int().nonnegative().optional(),
  incompleteReasons: z.array(z.string().min(1)),
}).strict();

export const WorkspaceFileChangeSummarySchema = z
  .object({
    path: z.string().min(1),
    operation: z.enum(["create", "modify", "delete", "rename"]),
    previousPath: z.string().min(1).optional(),
    beforeHash: Sha256Schema.optional(),
    afterHash: Sha256Schema.optional(),
    beforeByteLength: z.number().int().nonnegative().optional(),
    afterByteLength: z.number().int().nonnegative().optional(),
    timingPrecision: z.enum([
      "exact-adapter",
      "approximate-watcher",
      "exact-final-diff",
    ]),
    sensitivity: z.enum(["normal", "sensitive", "secret", "truncated"]),
    payloadKind: z.enum(["git-binary-patch", "file-delta"]).optional(),
  })
  .strict();

export const ProcessObservationIdentitySchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    sessionId: IdentifierSchema,
    executable: z.string().min(1),
    arguments: z.array(z.string()),
    cwd: z.string().min(1),
    startedAt: IsoTimestampSchema,
    configuration: ProcessRunConfigurationSchema,
  })
  .strict();

export type ProcessExitedSummary = z.infer<typeof ProcessExitedSummarySchema>;
export type ProcessFailureSummary = z.infer<typeof ProcessFailureSummarySchema>;
export type ProcessObservationIdentity = z.infer<
  typeof ProcessObservationIdentitySchema
>;
export type ProcessOutputStream = z.infer<typeof ProcessOutputStreamSchema>;
export type ProcessOutputSummary = z.infer<typeof ProcessOutputSummarySchema>;
export type ProcessRunConfiguration = z.infer<
  typeof ProcessRunConfigurationSchema
>;
export type ProcessStartedSummary = z.infer<typeof ProcessStartedSummarySchema>;
export type WorkspaceBaseline = z.infer<typeof WorkspaceBaselineSchema>;
export type WorkspaceFileChangeSummary = z.infer<
  typeof WorkspaceFileChangeSummarySchema
>;
export type WorkspaceManifest = z.infer<typeof WorkspaceManifestSchema>;
export type WorkspaceManifestEntry = z.infer<
  typeof WorkspaceManifestEntrySchema
>;
export type WorkspaceSnapshotSummary = z.infer<
  typeof WorkspaceSnapshotSummarySchema
>;
