export type ForwardedSignal = "SIGINT" | "SIGTERM";

export interface SignalEventSource {
  on(signal: ForwardedSignal, listener: () => void): unknown;
  off(signal: ForwardedSignal, listener: () => void): unknown;
}

export interface SignalTarget {
  kill(signal: ForwardedSignal): boolean;
}

export function installSignalForwarding(
  target: SignalTarget,
  source: SignalEventSource = process,
): () => void {
  let installed = true;
  const forward = (signal: ForwardedSignal) => {
    try {
      target.kill(signal);
    } catch {
      // A child can exit between signal receipt and forwarding.
    }
  };
  const onInterrupt = () => forward("SIGINT");
  const onTerminate = () => forward("SIGTERM");
  source.on("SIGINT", onInterrupt);
  source.on("SIGTERM", onTerminate);

  return () => {
    if (!installed) {
      return;
    }
    installed = false;
    source.off("SIGINT", onInterrupt);
    source.off("SIGTERM", onTerminate);
  };
}
