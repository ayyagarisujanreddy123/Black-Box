import type { ProxyHealth } from "../proxy/recorder-proxy.js";

export type DaemonLifecycleState =
  "new" | "starting" | "ready" | "stopping" | "stopped" | "failed";

export interface DaemonStatus {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly pid: number;
  readonly state: DaemonLifecycleState;
  readonly startedAt: string;
  readonly proxyOrigin: string;
  readonly controlOrigin: string;
  readonly proxy: ProxyHealth;
  readonly storage: {
    readonly schemaVersion: number;
    readonly readOnly: boolean;
    readonly recoveredIncompleteExchanges: number;
    readonly removedTemporaryBlobs: number;
  };
}
