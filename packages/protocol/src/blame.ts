import { z } from "zod";

import {
  FileLocationSchema,
  IdentifierSchema,
  JsonObjectSchema,
  SchemaVersionSchema,
} from "./common.js";
import { ContextCompletenessSchema } from "./context.js";

export const BlameConfidenceSchema = z.enum(["low", "medium", "high"]);

export const AnomalySeveritySchema = z.enum(["low", "medium", "high"]);

export const AnomalyFindingSchema = z
  .object({
    id: IdentifierSchema,
    ruleId: IdentifierSchema,
    severity: AnomalySeveritySchema,
    title: z.string().trim().min(1),
    explanation: z.string().trim().min(1),
    eventIds: z.array(IdentifierSchema).min(1),
    inputs: JsonObjectSchema,
    threshold: JsonObjectSchema,
  })
  .strict();

export const AnomalyResultSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    analyzerVersion: z.string().trim().min(1),
    sessionId: IdentifierSchema,
    targetEventId: IdentifierSchema,
    findings: z.array(AnomalyFindingSchema),
    limitations: z.array(z.string().trim().min(1)),
  })
  .strict();

export const BlameTargetSchema = z
  .object({
    eventId: IdentifierSchema,
    verb: z.string().trim().min(1),
    entity: z.string().trim().min(1).optional(),
    path: z.string().min(1).optional(),
    arguments: JsonObjectSchema,
    scope: z.string().trim().min(1).optional(),
    result: z.string().trim().min(1).optional(),
    impact: z.string().trim().min(1).optional(),
  })
  .strict();

export const BlameCandidateSchema = z
  .object({
    eventId: IdentifierSchema,
    score: z.number().min(0).max(1).finite(),
    features: z.record(z.string().trim().min(1), z.number().finite()),
    hardProvenanceEdge: z.boolean(),
  })
  .strict();

export const BlameResultSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    scoringVersion: z.string().trim().min(1),
    target: BlameTargetSchema,
    contextCompleteness: ContextCompletenessSchema,
    conclusion: z.string().trim().min(1),
    confidence: BlameConfidenceSchema,
    confidenceReasons: z.array(z.string().trim().min(1)),
    primaryOrigin: z
      .object({
        eventId: IdentifierSchema,
        excerpt: z.string().min(1),
        location: FileLocationSchema.optional(),
      })
      .strict()
      .optional(),
    candidates: z.array(BlameCandidateSchema),
    propagation: z.array(
      z
        .object({
          from: IdentifierSchema,
          to: IdentifierSchema,
          relation: z.string().trim().min(1),
        })
        .strict(),
    ),
    evidence: z.array(
      z
        .object({
          eventId: IdentifierSchema,
          supports: z.string().trim().min(1),
        })
        .strict(),
    ),
    counterevidence: z.array(
      z
        .object({
          eventId: IdentifierSchema,
          weakens: z.string().trim().min(1),
        })
        .strict(),
    ),
    alternatives: z.array(
      z
        .object({
          explanation: z.string().trim().min(1),
          evidenceIds: z.array(IdentifierSchema),
        })
        .strict(),
    ),
    limitations: z.array(z.string().trim().min(1)),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.confidence === "high" &&
      !result.candidates.some((candidate) => candidate.hardProvenanceEdge)
    ) {
      context.addIssue({
        code: "custom",
        message: "High confidence requires at least one hard provenance edge",
        path: ["confidence"],
      });
    }

    if (
      result.confidence === "high" &&
      result.contextCompleteness !== "exact-client-request" &&
      result.contextCompleteness !== "reconstructed-client-chain"
    ) {
      context.addIssue({
        code: "custom",
        message: "High confidence requires complete relevant client context",
        path: ["contextCompleteness"],
      });
    }
  });

export const BlameAnalysisSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    blame: BlameResultSchema,
    anomalies: AnomalyResultSchema,
  })
  .strict()
  .superRefine((analysis, context) => {
    if (analysis.blame.target.eventId !== analysis.anomalies.targetEventId) {
      context.addIssue({
        code: "custom",
        message: "Blame and anomaly results must describe the same target",
        path: ["anomalies", "targetEventId"],
      });
    }
  });

export type AnomalyFinding = z.infer<typeof AnomalyFindingSchema>;
export type AnomalyResult = z.infer<typeof AnomalyResultSchema>;
export type AnomalySeverity = z.infer<typeof AnomalySeveritySchema>;
export type BlameAnalysis = z.infer<typeof BlameAnalysisSchema>;
export type BlameCandidate = z.infer<typeof BlameCandidateSchema>;
export type BlameConfidence = z.infer<typeof BlameConfidenceSchema>;
export type BlameResult = z.infer<typeof BlameResultSchema>;
export type BlameTarget = z.infer<typeof BlameTargetSchema>;
