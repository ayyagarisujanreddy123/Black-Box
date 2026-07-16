export async function withCleanupDeadline<T>(
  timeoutMilliseconds: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1) {
    throw new RangeError("Cleanup timeout must be a positive safe integer.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new Error(
        `Workspace cleanup exceeded ${timeoutMilliseconds} milliseconds.`,
      ),
    );
  }, timeoutMilliseconds);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
