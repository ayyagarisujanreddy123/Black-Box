import { z } from "zod";

export const SseFrameSchema = z
  .object({
    index: z.number().int().positive(),
    event: z.string().optional(),
    data: z.string().optional(),
    id: z.string().optional(),
    retry: z.number().int().nonnegative().optional(),
    comments: z.array(z.string()),
    unknownFields: z.array(
      z.object({ name: z.string(), value: z.string() }).strict(),
    ),
    raw: z.string(),
  })
  .strict();

export const IncompleteSseFrameSchema = z
  .object({
    index: z.number().int().positive(),
    raw: z.string().min(1),
  })
  .strict();

export type SseFrame = z.infer<typeof SseFrameSchema>;
export type IncompleteSseFrame = z.infer<typeof IncompleteSseFrameSchema>;

export interface SseDecoderOptions {
  readonly maximumBufferedCharacters?: number;
  readonly maximumFrameCharacters?: number;
  readonly maximumFrames?: number;
}

export interface SseDecodeResult {
  readonly frames: readonly SseFrame[];
  readonly incomplete?: IncompleteSseFrame;
}

export class SseLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SseLimitError";
  }
}

export class IncrementalSseDecoder {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly maximumBufferedCharacters: number;
  private readonly maximumFrameCharacters: number;
  private readonly maximumFrames: number;
  private textBuffer = "";
  private frameLines: string[] = [];
  private frameCharacters = 0;
  private emittedFrames = 0;
  private finished = false;
  private atStart = true;

  constructor(options: SseDecoderOptions = {}) {
    this.maximumBufferedCharacters =
      options.maximumBufferedCharacters ?? 16 * 1024 * 1024;
    this.maximumFrameCharacters =
      options.maximumFrameCharacters ?? 4 * 1024 * 1024;
    this.maximumFrames = options.maximumFrames ?? 100_000;
    for (const [name, value] of [
      ["buffer", this.maximumBufferedCharacters],
      ["frame", this.maximumFrameCharacters],
      ["frame count", this.maximumFrames],
    ] as const) {
      if (!Number.isInteger(value) || value < 1) {
        throw new RangeError(`SSE ${name} limit must be a positive integer.`);
      }
    }
  }

  push(chunk: Uint8Array): SseFrame[] {
    if (this.finished) {
      throw new Error("Cannot append bytes after the SSE decoder is finished.");
    }
    this.appendDecoded(this.decoder.decode(chunk, { stream: true }));
    return this.drainLines(false);
  }

  finish(): SseDecodeResult {
    if (this.finished) {
      throw new Error("SSE decoder finish may only be called once.");
    }
    this.finished = true;
    this.appendDecoded(this.decoder.decode());
    const frames = this.drainLines(true);
    const raw = this.frameLines.join("\n");
    this.frameLines = [];
    this.frameCharacters = 0;
    return {
      frames,
      ...(raw.length === 0
        ? {}
        : {
            incomplete: IncompleteSseFrameSchema.parse({
              index: this.emittedFrames + 1,
              raw,
            }),
          }),
    };
  }

  private appendDecoded(value: string): void {
    let decoded = value;
    if (this.atStart && decoded.length > 0) {
      this.atStart = false;
      if (decoded.charCodeAt(0) === 0xfeff) {
        decoded = decoded.slice(1);
      }
    }
    this.textBuffer += decoded;
    if (this.textBuffer.length > this.maximumBufferedCharacters) {
      throw new SseLimitError("SSE undecoded line buffer exceeded its limit.");
    }
  }

  private drainLines(final: boolean): SseFrame[] {
    const frames: SseFrame[] = [];
    while (true) {
      let newlineIndex = -1;
      for (let index = 0; index < this.textBuffer.length; index += 1) {
        const character = this.textBuffer[index];
        if (character === "\n" || character === "\r") {
          newlineIndex = index;
          break;
        }
      }
      if (newlineIndex === -1) {
        if (final && this.textBuffer.length > 0) {
          this.acceptLine(this.textBuffer);
          this.textBuffer = "";
        }
        break;
      }
      const newline = this.textBuffer[newlineIndex];
      if (
        newline === "\r" &&
        newlineIndex === this.textBuffer.length - 1 &&
        !final
      ) {
        break;
      }
      const line = this.textBuffer.slice(0, newlineIndex);
      const newlineLength =
        newline === "\r" && this.textBuffer[newlineIndex + 1] === "\n" ? 2 : 1;
      this.textBuffer = this.textBuffer.slice(newlineIndex + newlineLength);
      if (line.length === 0) {
        const frame = this.dispatchFrame();
        if (frame !== undefined) {
          frames.push(frame);
        }
      } else {
        this.acceptLine(line);
      }
    }
    return frames;
  }

  private acceptLine(line: string): void {
    this.frameCharacters += line.length + 1;
    if (this.frameCharacters > this.maximumFrameCharacters) {
      throw new SseLimitError("SSE frame exceeded its character limit.");
    }
    this.frameLines.push(line);
  }

  private dispatchFrame(): SseFrame | undefined {
    if (this.frameLines.length === 0) {
      return undefined;
    }
    if (this.emittedFrames >= this.maximumFrames) {
      throw new SseLimitError("SSE frame count exceeded its limit.");
    }
    const data: string[] = [];
    const comments: string[] = [];
    const unknownFields: { name: string; value: string }[] = [];
    let event: string | undefined;
    let id: string | undefined;
    let retry: number | undefined;

    for (const line of this.frameLines) {
      if (line.startsWith(":")) {
        comments.push(line.slice(1).replace(/^ /u, ""));
        continue;
      }
      const colon = line.indexOf(":");
      const name = colon === -1 ? line : line.slice(0, colon);
      const rawValue = colon === -1 ? "" : line.slice(colon + 1);
      const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
      switch (name) {
        case "event":
          event = value;
          break;
        case "data":
          data.push(value);
          break;
        case "id":
          if (!value.includes("\0")) {
            id = value;
          }
          break;
        case "retry":
          if (/^\d+$/u.test(value)) {
            retry = Number(value);
          }
          break;
        default:
          unknownFields.push({ name, value });
      }
    }

    this.emittedFrames += 1;
    const frame = SseFrameSchema.parse({
      index: this.emittedFrames,
      ...(event === undefined ? {} : { event }),
      ...(data.length === 0 ? {} : { data: data.join("\n") }),
      ...(id === undefined ? {} : { id }),
      ...(retry === undefined ? {} : { retry }),
      comments,
      unknownFields,
      raw: `${this.frameLines.join("\n")}\n\n`,
    });
    this.frameLines = [];
    this.frameCharacters = 0;
    return frame;
  }
}

export function decodeSseChunks(
  chunks: readonly Uint8Array[],
  options: SseDecoderOptions = {},
): SseDecodeResult {
  const decoder = new IncrementalSseDecoder(options);
  const frames: SseFrame[] = [];
  for (const chunk of chunks) {
    frames.push(...decoder.push(chunk));
  }
  const finished = decoder.finish();
  frames.push(...finished.frames);
  return {
    frames,
    ...(finished.incomplete === undefined
      ? {}
      : { incomplete: finished.incomplete }),
  };
}
