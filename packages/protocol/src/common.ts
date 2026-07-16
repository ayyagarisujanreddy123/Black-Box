import { z } from "zod";

export const CURRENT_SCHEMA_VERSION = 1 as const;

export const SchemaVersionSchema = z.literal(CURRENT_SCHEMA_VERSION);
export const IdentifierSchema = z.string().trim().min(1).max(512);
export const Sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);
export const IsoTimestampSchema = z.iso.datetime({ offset: true });
export const JsonObjectSchema = z.record(z.string(), z.unknown());
export const NullableTokenCountSchema = z
  .number()
  .int()
  .nonnegative()
  .nullable();

export const EvidenceKindSchema = z.enum([
  "observed",
  "derived",
  "inferred",
  "unknown",
]);

export const EvidenceSourceSchema = z.enum([
  "proxy",
  "process",
  "filesystem",
  "adapter",
  "analysis",
]);

export const CaptureLevelSchema = z.enum(["api", "wrapped-process", "adapter"]);

export const RedactionSchema = z
  .object({
    applied: z.boolean(),
    ruleIds: z.array(IdentifierSchema),
  })
  .strict();

export const BlobReferenceSchema = z
  .object({
    id: IdentifierSchema,
    sha256: Sha256Schema,
    codec: z.enum(["identity", "gzip", "zstd"]),
    mediaType: z.string().trim().min(1).max(256),
    byteLength: z.number().int().nonnegative(),
    truncated: z.boolean().default(false),
  })
  .strict();

export const FileLocationSchema = z
  .object({
    path: z.string().min(1),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .strict()
  .refine((location) => location.endLine >= location.startLine, {
    message: "endLine must be greater than or equal to startLine",
    path: ["endLine"],
  });

export const ProvenanceReferenceSchema = z
  .object({
    eventId: IdentifierSchema.optional(),
    exchangeId: IdentifierSchema.optional(),
    payloadRef: BlobReferenceSchema.optional(),
    location: FileLocationSchema.optional(),
  })
  .strict()
  .refine(
    (reference) =>
      reference.eventId !== undefined ||
      reference.exchangeId !== undefined ||
      reference.payloadRef !== undefined,
    { message: "At least one provenance identifier is required" },
  );

export const PreservedRecordSchema = z
  .object({
    status: z.literal("preserved"),
    recordKind: z.string().trim().min(1).max(128),
    declaredSchemaVersion: z.number().int().nonnegative().nullable(),
    reason: z.enum([
      "unsupported-schema-version",
      "malformed-payload",
      "unknown-record-kind",
    ]),
    rawPayloadRef: BlobReferenceSchema,
  })
  .strict();

export type BlobReference = z.infer<typeof BlobReferenceSchema>;
export type CaptureLevel = z.infer<typeof CaptureLevelSchema>;
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;
export type FileLocation = z.infer<typeof FileLocationSchema>;
export type PreservedRecord = z.infer<typeof PreservedRecordSchema>;
export type ProvenanceReference = z.infer<typeof ProvenanceReferenceSchema>;
export type Redaction = z.infer<typeof RedactionSchema>;
