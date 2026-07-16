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
