import { z } from "zod";

export const DaemonLifecycleStateSchema = z.enum([
  "new",
  "starting",
  "ready",
  "stopping",
  "stopped",
  "failed",
]);

export const DaemonStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    instanceId: z.string().min(1).max(128),
    pid: z.number().int().positive(),
    state: DaemonLifecycleStateSchema,
    startedAt: z.iso.datetime({ offset: true }),
    proxyOrigin: z.url(),
    controlOrigin: z.url(),
    proxy: z
      .object({
        status: z.enum(["healthy", "degraded"]),
        activeRequests: z.number().int().nonnegative(),
        requestsStarted: z.number().int().nonnegative(),
        requestsCompleted: z.number().int().nonnegative(),
        captureFailures: z.number().int().nonnegative(),
        normalizationFailures: z.number().int().nonnegative(),
        droppedCaptureBytes: z.number().int().nonnegative(),
        droppedManifestEntries: z.number().int().nonnegative(),
        clientDisconnects: z.number().int().nonnegative(),
        upstreamFailures: z.number().int().nonnegative(),
        lastError: z.string().optional(),
      })
      .strict(),
    storage: z
      .object({
        schemaVersion: z.number().int().nonnegative(),
        readOnly: z.boolean(),
        recoveredIncompleteExchanges: z.number().int().nonnegative(),
        removedTemporaryBlobs: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type DaemonLifecycleState = z.infer<typeof DaemonLifecycleStateSchema>;
export type DaemonStatus = z.infer<typeof DaemonStatusSchema>;
