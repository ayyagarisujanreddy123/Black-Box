import { z } from "zod";

import {
  FileLocationSchema,
  IdentifierSchema,
  JsonObjectSchema,
  SchemaVersionSchema,
} from "./common.js";
import { ContextCompletenessSchema } from "./context.js";

export const BlameConfidenceSchema = z.enum(["low", "medium", "high"]);

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

export type BlameCandidate = z.infer<typeof BlameCandidateSchema>;
export type BlameConfidence = z.infer<typeof BlameConfidenceSchema>;
export type BlameResult = z.infer<typeof BlameResultSchema>;
export type BlameTarget = z.infer<typeof BlameTargetSchema>;
