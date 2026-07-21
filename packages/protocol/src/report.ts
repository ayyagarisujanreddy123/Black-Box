import { z } from "zod";

import {
  CaptureLevelSchema,
  EvidenceKindSchema,
  IdentifierSchema,
  IsoTimestampSchema,
  NullableTokenCountSchema,
  SchemaVersionSchema,
  Sha256Schema,
} from "./common.js";
import { ContextCompletenessSchema } from "./context.js";

export const ReportEvidenceReferenceSchema = z
  .object({
    eventId: IdentifierSchema,
    statement: z.string().trim().min(1),
  })
  .strict();

export const ReportAnalysisUsageSchema = z
  .object({
    inputTokens: NullableTokenCountSchema,
    outputTokens: NullableTokenCountSchema,
    totalTokens: NullableTokenCountSchema,
  })
  .strict();

const DeterministicAnalysisDisclosureSchema = z
  .object({
    mode: z.literal("deterministic"),
    analyzer: z.string().trim().min(1),
    promptVersion: z.null(),
    model: z.null(),
    externalEvidenceSent: z.literal(false),
    redactionRuleIds: z.array(IdentifierSchema),
  })
  .strict();

const AiAnalysisDisclosureSchema = z
  .object({
    mode: z.literal("ai-enriched"),
    analyzer: z.string().trim().min(1),
    promptVersion: z.string().trim().min(1),
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),
    externalEvidenceSent: z.literal(true),
    redactionRuleIds: z.array(IdentifierSchema),
    analysisSessionId: IdentifierSchema,
    transmittedEvidenceSha256: Sha256Schema,
    usage: ReportAnalysisUsageSchema,
  })
  .strict();

export const AnalysisDisclosureSchema = z.discriminatedUnion("mode", [
  DeterministicAnalysisDisclosureSchema,
  AiAnalysisDisclosureSchema,
]);

export const IncidentReportSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: IdentifierSchema,
    sessionId: IdentifierSchema,
    targetEventId: IdentifierSchema.optional(),
    generatedAt: IsoTimestampSchema,
    capture: z
      .object({
        level: CaptureLevelSchema,
        contextCompleteness: ContextCompletenessSchema,
        missingSignals: z.array(z.string().trim().min(1)),
      })
      .strict(),
    impact: z.string().trim().min(1),
    factualTimeline: z.array(
      z
        .object({
          eventId: IdentifierSchema,
          occurredAt: IsoTimestampSchema,
          statement: z.string().trim().min(1),
          evidence: z.union([z.literal("observed"), z.literal("derived")]),
        })
        .strict(),
    ),
    rootCauseHypothesis: z
      .object({
        statement: z.string().trim().min(1),
        evidence: z.literal("inferred"),
        confidence: z.enum(["low", "medium", "high"]),
        supports: z.array(ReportEvidenceReferenceSchema),
      })
      .strict(),
    contributingConditions: z.array(ReportEvidenceReferenceSchema),
    counterevidence: z.array(ReportEvidenceReferenceSchema),
    alternatives: z.array(
      z
        .object({
          explanation: z.string().trim().min(1),
          evidenceIds: z.array(IdentifierSchema),
        })
        .strict(),
    ),
    preventionActions: z.array(
      z
        .object({
          action: z.string().trim().min(1),
          evidenceIds: z.array(IdentifierSchema),
        })
        .strict(),
    ),
    containmentAndRecovery: z.array(ReportEvidenceReferenceSchema),
    limitations: z.array(z.string().trim().min(1)),
    analysis: AnalysisDisclosureSchema,
  })
  .strict();

export const AiReportCitationSchema = z
  .object({
    eventId: IdentifierSchema,
    excerpt: z.string().trim().min(1).max(2_000),
  })
  .strict();

const AiCitedStatementSchema = z
  .object({
    statement: z.string().trim().min(1).max(4_000),
    citations: z.array(AiReportCitationSchema).max(20),
  })
  .strict();

export const AiIncidentNarrativeSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    impact: AiCitedStatementSchema,
    rootCauseHypothesis: AiCitedStatementSchema.extend({
      confidence: z.enum(["low", "medium", "high"]),
    }).strict(),
    contributingConditions: z.array(AiCitedStatementSchema).max(20),
    counterevidence: z.array(AiCitedStatementSchema).max(20),
    alternatives: z
      .array(
        z
          .object({
            explanation: z.string().trim().min(1).max(4_000),
            citations: z.array(AiReportCitationSchema).max(20),
          })
          .strict(),
      )
      .max(20),
    preventionActions: z
      .array(
        z
          .object({
            action: z.string().trim().min(1).max(4_000),
            citations: z.array(AiReportCitationSchema).max(20),
          })
          .strict(),
      )
      .max(20),
    limitations: z.array(z.string().trim().min(1).max(2_000)).max(20),
  })
  .strict();

export const ReportTransmissionCategorySchema = z.enum([
  "session-metadata",
  "factual-timeline",
  "blame",
  "anomalies",
  "counterevidence",
]);

export const ReportPreflightSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    sessionId: IdentifierSchema,
    targetEventId: IdentifierSchema.nullable(),
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),
    promptVersion: z.string().trim().min(1),
    categories: z.array(
      z
        .object({
          category: ReportTransmissionCategorySchema,
          itemCount: z.number().int().nonnegative(),
          byteLength: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    totalBytes: z.number().int().nonnegative(),
    eventCount: z.number().int().nonnegative(),
    redactionCount: z.number().int().nonnegative(),
    redactionRuleIds: z.array(IdentifierSchema),
    snapshotSha256: Sha256Schema,
    consentFingerprintSha256: Sha256Schema,
  })
  .strict();

export const AiReportRequestSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    consent: z.literal(true),
    consentFingerprintSha256: Sha256Schema,
    targetEventId: IdentifierSchema.optional(),
  })
  .strict();

export const ReportAiAttemptSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("not-requested"),
    })
    .strict(),
  z
    .object({
      status: z.literal("completed"),
      analysisSessionId: IdentifierSchema,
      provider: z.string().trim().min(1),
      model: z.string().trim().min(1),
      externalEvidenceSent: z.literal(true),
      usage: ReportAnalysisUsageSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      analysisSessionId: IdentifierSchema.optional(),
      provider: z.string().trim().min(1),
      model: z.string().trim().min(1),
      error: z.string().trim().min(1),
      externalEvidenceSent: z.boolean(),
      usage: ReportAnalysisUsageSchema.optional(),
    })
    .strict(),
]);

export const IncidentReportResultSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    requestedMode: z.enum(["deterministic", "ai"]),
    report: IncidentReportSchema,
    markdown: z.string().min(1),
    aiAttempt: ReportAiAttemptSchema,
    preflight: ReportPreflightSchema.optional(),
  })
  .strict();

export type AnalysisDisclosure = z.infer<typeof AnalysisDisclosureSchema>;
export type AiIncidentNarrative = z.infer<typeof AiIncidentNarrativeSchema>;
export type AiReportCitation = z.infer<typeof AiReportCitationSchema>;
export type AiReportRequest = z.infer<typeof AiReportRequestSchema>;
export type IncidentReport = z.infer<typeof IncidentReportSchema>;
export type IncidentReportResult = z.infer<typeof IncidentReportResultSchema>;
export type ReportAiAttempt = z.infer<typeof ReportAiAttemptSchema>;
export type ReportAnalysisUsage = z.infer<typeof ReportAnalysisUsageSchema>;
export type ReportEvidenceReference = z.infer<
  typeof ReportEvidenceReferenceSchema
>;
export type ReportPreflight = z.infer<typeof ReportPreflightSchema>;
export type ReportTransmissionCategory = z.infer<
  typeof ReportTransmissionCategorySchema
>;

export { EvidenceKindSchema as ReportEvidenceKindSchema };
