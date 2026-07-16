import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  installSignalForwarding,
  withCleanupDeadline,
  type ForwardedSignal,
  type SignalEventSource,
} from "../src/index.js";

describe("wrapped process lifecycle guards", () => {
  it("forwards termination signals and removes both listeners", () => {
    const source = new EventEmitter();
    const kill = vi.fn<(signal: ForwardedSignal) => boolean>(() => true);
    const remove = installSignalForwarding(
      { kill },
      source as SignalEventSource,
    );

    source.emit("SIGINT");
    source.emit("SIGTERM");
    expect(kill.mock.calls).toEqual([["SIGINT"], ["SIGTERM"]]);

    remove();
    remove();
    source.emit("SIGINT");
    expect(kill).toHaveBeenCalledTimes(2);
  });

  it("aborts cleanup work at its configured deadline", async () => {
    const startedAt = Date.now();
    await expect(
      withCleanupDeadline(
        20,
        async (signal) =>
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      ),
    ).rejects.toThrow("Workspace cleanup exceeded 20 milliseconds");
    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});
