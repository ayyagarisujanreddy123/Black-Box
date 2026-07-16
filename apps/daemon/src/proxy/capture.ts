export class CaptureMemoryBudget {
  private retainedBytes = 0;

  constructor(readonly maximumBytes: number) {
    if (!Number.isInteger(maximumBytes) || maximumBytes < 1) {
      throw new RangeError("Capture memory budget must be a positive integer.");
    }
  }

  get usedBytes(): number {
    return this.retainedBytes;
  }

  claim(requestedBytes: number): number {
    const available = Math.max(0, this.maximumBytes - this.retainedBytes);
    const granted = Math.min(requestedBytes, available);
    this.retainedBytes += granted;
    return granted;
  }

  release(bytes: number): void {
    this.retainedBytes -= bytes;
    if (this.retainedBytes < 0) {
      throw new Error("Capture memory budget was released more than retained.");
    }
  }
}

export class BoundedByteCapture {
  private readonly chunks: Buffer[] = [];
  private retained = 0;
  private dropped = 0;
  private observed = 0;
  private released = false;
  private captureClosed = false;

  constructor(
    private readonly maximumBodyBytes: number,
    private readonly budget: CaptureMemoryBudget,
  ) {
    if (!Number.isInteger(maximumBodyBytes) || maximumBodyBytes < 1) {
      throw new RangeError("Capture body limit must be a positive integer.");
    }
  }

  get retainedBytes(): number {
    return this.retained;
  }

  get droppedBytes(): number {
    return this.dropped;
  }

  get observedBytes(): number {
    return this.observed;
  }

  append(chunk: Uint8Array): void {
    if (this.released) {
      throw new Error("Cannot append to a released capture.");
    }

    const buffer = Buffer.from(chunk);
    const observedBefore = this.observed;
    this.observed += buffer.length;
    const bodyCapacity = Math.max(0, this.maximumBodyBytes - observedBefore);
    const desired = this.captureClosed
      ? 0
      : Math.min(buffer.length, bodyCapacity);
    const granted = this.budget.claim(desired);

    if (granted > 0) {
      this.chunks.push(Buffer.from(buffer.subarray(0, granted)));
      this.retained += granted;
    }
    this.dropped += buffer.length - granted;
    if (granted < buffer.length) {
      this.captureClosed = true;
    }
  }

  bytes(): Buffer {
    if (this.released) {
      throw new Error("Cannot read a released capture.");
    }
    return Buffer.concat(this.chunks, this.retained);
  }

  release(): void {
    if (this.released) {
      return;
    }
    this.budget.release(this.retained);
    this.chunks.length = 0;
    this.released = true;
  }
}
