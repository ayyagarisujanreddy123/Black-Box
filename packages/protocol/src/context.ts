import { z } from "zod";

import {
  EvidenceKindSchema,
  IdentifierSchema,
  JsonObjectSchema,
  NullableTokenCountSchema,
  ProvenanceReferenceSchema,
  SchemaVersionSchema,
} from "./common.js";

export const CONTEXT_VISIBILITY_NOTICE =
  "Provider-hidden instructions and internal reasoning are outside the API-visible record.";

export const ContextCompletenessSchema = z.enum([
  "exact-client-request",
  "reconstructed-client-chain",
  "partial-client-chain",
  "provider-managed-context",
  "unknown-unsupported",
]);

export const ContextItemKindSchema = z.enum([
  "instructions",
  "message",
  "tool-definition",
  "tool-call",
  "tool-result",
  "reasoning-opaque",
  "settings",
  "unknown",
]);

export const ContextItemSchema = z
  .object({
    id: IdentifierSchema,
    position: z.number().int().nonnegative(),
    kind: ContextItemKindSchema,
    role: z
      .enum(["system", "developer", "user", "assistant", "tool"])
      .optional(),
    evidence: EvidenceKindSchema,
    summary: JsonObjectSchema,
    provenance: ProvenanceReferenceSchema,
  })
  .strict();

export const ContextAncestryNodeSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.enum(["request", "response", "conversation", "missing"]),
    locallyAvailable: z.boolean(),
  })
  .strict();

export const ContextAncestryEdgeSchema = z
  .object({
    from: IdentifierSchema,
    to: IdentifierSchema,
    relation: z.enum([
      "previous-response",
      "conversation-member",
      "explicit-input",
    ]),
    evidence: EvidenceKindSchema,
  })
  .strict();

export const ContextResultSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    requestEventId: IdentifierSchema,
    completeness: ContextCompletenessSchema,
    items: z.array(ContextItemSchema),
    ancestry: z
      .object({
        nodes: z.array(ContextAncestryNodeSchema),
        edges: z.array(ContextAncestryEdgeSchema),
      })
      .strict(),
    reportedInputTokens: NullableTokenCountSchema,
    estimatedInputTokens: NullableTokenCountSchema,
    modelContextLimit: NullableTokenCountSchema,
    limitationReasons: z.array(z.string().trim().min(1)),
    visibilityNotice: z.literal(CONTEXT_VISIBILITY_NOTICE),
  })
  .strict()
  .superRefine((result, context) => {
    for (let index = 1; index < result.items.length; index += 1) {
      const previous = result.items[index - 1];
      const current = result.items[index];

      if (
        previous !== undefined &&
        current !== undefined &&
        current.position <= previous.position
      ) {
        context.addIssue({
          code: "custom",
          message: "Context item positions must be strictly increasing",
          path: ["items", index, "position"],
        });
      }
    }
  });

export type ContextCompleteness = z.infer<typeof ContextCompletenessSchema>;
export type ContextItem = z.infer<typeof ContextItemSchema>;
export type ContextResult = z.infer<typeof ContextResultSchema>;
