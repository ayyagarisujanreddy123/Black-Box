import { createHash } from "node:crypto";

import { IdentifierSchema, Sha256Schema } from "@blackbox/protocol";
import { z } from "zod";

import type { BlobStore } from "./blob-store.js";

const BigIntStringSchema = z.string().regex(/^\d+$/u);

export const ChunkManifestEntrySchema = z
  .object({
    sequence: z.number().int().positive(),
    direction: z.enum(["request", "response"]),
    monotonicOffsetNs: BigIntStringSchema,
    byteOffset: z.number().int().nonnegative(),
    byteLength: z.number().int().nonnegative(),
    sha256: Sha256Schema,
  })
  .strict();

export const ChunkManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    exchangeId: IdentifierSchema,
    startedMonotonicNs: BigIntStringSchema,
    completed: z.boolean(),
    entries: z.array(ChunkManifestEntrySchema),
  })
  .strict()
  .superRefine((manifest, context) => {
    const offsets = { request: 0, response: 0 };
    let previousMonotonic = -1n;

    manifest.entries.forEach((entry, index) => {
      if (entry.sequence !== index + 1) {
        context.addIssue({
          code: "custom",
          message: "Chunk sequence must be contiguous",
          path: ["entries", index, "sequence"],
        });
      }
      const monotonic = BigInt(entry.monotonicOffsetNs);
      if (monotonic < previousMonotonic) {
        context.addIssue({
          code: "custom",
          message: "Chunk monotonic offsets must not decrease",
          path: ["entries", index, "monotonicOffsetNs"],
        });
      }
      previousMonotonic = monotonic;
      if (entry.byteOffset !== offsets[entry.direction]) {
        context.addIssue({
          code: "custom",
          message: "Chunk byte offsets must be contiguous per direction",
          path: ["entries", index, "byteOffset"],
        });
      }
      offsets[entry.direction] += entry.byteLength;
    });
  });

export type ChunkManifest = z.infer<typeof ChunkManifestSchema>;
export type ChunkManifestEntry = z.infer<typeof ChunkManifestEntrySchema>;

export class ChunkManifestBuilder {
  private readonly entries: ChunkManifestEntry[] = [];
  private readonly offsets = { request: 0, response: 0 };
  private lastObservedNs: bigint;

  constructor(
    readonly exchangeId: string,
    readonly startedMonotonicNs: bigint = process.hrtime.bigint(),
  ) {
    IdentifierSchema.parse(exchangeId);
    this.lastObservedNs = startedMonotonicNs;
  }

  append(
    direction: "request" | "response",
    chunk: Uint8Array,
    observedAtNs: bigint = process.hrtime.bigint(),
  ): ChunkManifestEntry {
    if (observedAtNs < this.lastObservedNs) {
      throw new RangeError("Chunk monotonic time cannot move backward.");
    }

    const entry = ChunkManifestEntrySchema.parse({
      sequence: this.entries.length + 1,
      direction,
      monotonicOffsetNs: (observedAtNs - this.startedMonotonicNs).toString(),
      byteOffset: this.offsets[direction],
      byteLength: chunk.byteLength,
      sha256: createHash("sha256").update(chunk).digest("hex"),
    });
    this.entries.push(entry);
    this.offsets[direction] += chunk.byteLength;
    this.lastObservedNs = observedAtNs;
    return entry;
  }

  build(completed: boolean): ChunkManifest {
    return ChunkManifestSchema.parse({
      schemaVersion: 1,
      exchangeId: this.exchangeId,
      startedMonotonicNs: this.startedMonotonicNs.toString(),
      completed,
      entries: this.entries,
    });
  }

  async persist(blobStore: BlobStore, completed: boolean) {
    const manifest = this.build(completed);
    return blobStore.put(JSON.stringify(manifest), {
      mediaType: "application/vnd.blackbox.chunk-manifest+json",
    });
  }
}
