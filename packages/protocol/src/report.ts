import { z } from "zod";

import {
  CaptureLevelSchema,
  EvidenceKindSchema,
  IdentifierSchema,
  IsoTimestampSchema,
  SchemaVersionSchema,
} from "./common.js";
import { ContextCompletenessSchema } from "./context.js";

const ReportEvidenceReferenceSchema = z
  .object({
    eventId: IdentifierSchema,
    statement: z.string().trim().min(1),
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
    model: z.string().trim().min(1),
    externalEvidenceSent: z.literal(true),
    redactionRuleIds: z.array(IdentifierSchema),
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
    limitations: z.array(z.string().trim().min(1)),
    analysis: AnalysisDisclosureSchema,
  })
  .strict();

export type AnalysisDisclosure = z.infer<typeof AnalysisDisclosureSchema>;
export type IncidentReport = z.infer<typeof IncidentReportSchema>;

export { EvidenceKindSchema as ReportEvidenceKindSchema };
