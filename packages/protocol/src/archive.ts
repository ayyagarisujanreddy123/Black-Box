import { z } from "zod";

import {
  BlobReferenceSchema,
  IdentifierSchema,
  IsoTimestampSchema,
  SchemaVersionSchema,
  Sha256Schema,
} from "./common.js";
import { SessionStatusSchema } from "./session.js";

export const BbxArchiveProfileSchema = z.enum(["share", "forensic"]);

export const BbxArchiveEntryPathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9._/-]+$/u)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.endsWith("/") &&
      !path.split("/").some((segment) => segment === ".." || segment === ""),
    "Archive entry paths must be normalized relative paths.",
  );

export const BbxArchiveEntryDescriptorSchema = z
  .object({
    path: BbxArchiveEntryPathSchema,
    mediaType: z.string().trim().min(1).max(256),
    byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sha256: Sha256Schema,
  })
  .strict();

export const BbxArchiveBlobSchema = z
  .object({
    entryPath: BbxArchiveEntryPathSchema,
    reference: BlobReferenceSchema,
  })
  .strict();

export const BbxArchiveRecordCountsSchema = z
  .object({
    sessions: z.literal(1),
    events: z.number().int().nonnegative(),
    rawExchanges: z.number().int().nonnegative(),
    normalizationRuns: z.number().int().nonnegative(),
    fileChanges: z.number().int().nonnegative(),
    contextEdges: z.number().int().nonnegative(),
    analysisRuns: z.number().int().nonnegative(),
    redactions: z.number().int().nonnegative(),
    blobs: z.number().int().nonnegative(),
    reports: z.number().int().nonnegative().max(1),
  })
  .strict();

export const BbxArchiveManifestSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    format: z.literal("blackbox-bbx"),
    archiveId: IdentifierSchema,
    exportedAt: IsoTimestampSchema,
    profile: BbxArchiveProfileSchema,
    sourceSessionId: IdentifierSchema,
    sourceSessionStatus: SessionStatusSchema,
    storageSchemaVersion: z.number().int().nonnegative(),
    entries: z.array(BbxArchiveEntryDescriptorSchema).max(100_000),
    blobs: z.array(BbxArchiveBlobSchema).max(100_000),
    counts: BbxArchiveRecordCountsSchema,
    totalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    redaction: z
      .object({
        applied: z.boolean(),
        count: z.number().int().nonnegative(),
        ruleIds: z.array(IdentifierSchema),
      })
      .strict(),
    warnings: z.array(z.string().trim().min(1).max(2_000)).max(100),
  })
  .strict()
  .superRefine((manifest, context) => {
    const paths = manifest.entries.map((entry) => entry.path);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "Archive entry paths must be unique.",
      });
    }
    const blobPaths = manifest.blobs.map((blob) => blob.entryPath);
    if (new Set(blobPaths).size !== blobPaths.length) {
      context.addIssue({
        code: "custom",
        path: ["blobs"],
        message: "Archive blob paths must be unique.",
      });
    }
    const entryPaths = new Set(paths);
    if (blobPaths.some((path) => !entryPaths.has(path))) {
      context.addIssue({
        code: "custom",
        path: ["blobs"],
        message: "Every archive blob must reference a declared entry.",
      });
    }
    const byteLength = manifest.entries.reduce(
      (total, entry) => total + entry.byteLength,
      0,
    );
    if (byteLength !== manifest.totalBytes) {
      context.addIssue({
        code: "custom",
        path: ["totalBytes"],
        message: "Archive totalBytes must equal the declared entry sizes.",
      });
    }
    if (manifest.counts.blobs !== manifest.blobs.length) {
      context.addIssue({
        code: "custom",
        path: ["counts", "blobs"],
        message: "Archive blob count does not match the blob manifest.",
      });
    }
  });

export const BbxArchiveEntrySchema = z
  .object({
    path: BbxArchiveEntryPathSchema,
    encoding: z.literal("base64"),
    data: z.string().max(750_000_000),
  })
  .strict();

export const BbxArchiveSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    manifest: BbxArchiveManifestSchema,
    manifestSha256: Sha256Schema,
    entries: z.array(BbxArchiveEntrySchema).max(100_000),
  })
  .strict()
  .superRefine((archive, context) => {
    const paths = archive.entries.map((entry) => entry.path);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "Archive payload entry paths must be unique.",
      });
    }
    const declared = archive.manifest.entries.map((entry) => entry.path);
    if (
      paths.length !== declared.length ||
      paths.some((path, index) => path !== declared[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message:
          "Archive payload entries must match manifest order and paths exactly.",
      });
    }
  });

export const BbxArchiveImportResultSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    archiveId: IdentifierSchema,
    sessionId: IdentifierSchema,
    profile: BbxArchiveProfileSchema,
    importedAt: IsoTimestampSchema,
    readOnly: z.literal(true),
    eventCount: z.number().int().nonnegative(),
    blobCount: z.number().int().nonnegative(),
  })
  .strict();

export type BbxArchive = z.infer<typeof BbxArchiveSchema>;
export type BbxArchiveBlob = z.infer<typeof BbxArchiveBlobSchema>;
export type BbxArchiveEntry = z.infer<typeof BbxArchiveEntrySchema>;
export type BbxArchiveEntryDescriptor = z.infer<
  typeof BbxArchiveEntryDescriptorSchema
>;
export type BbxArchiveImportResult = z.infer<
  typeof BbxArchiveImportResultSchema
>;
export type BbxArchiveManifest = z.infer<typeof BbxArchiveManifestSchema>;
export type BbxArchiveProfile = z.infer<typeof BbxArchiveProfileSchema>;
