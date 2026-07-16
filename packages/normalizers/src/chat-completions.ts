import {
  NormalizationExchangeSchema,
  NormalizationResultSchema,
  type CanonicalEventDraft,
  type ExchangeNormalizer,
  type NormalizationExchange,
  type NormalizationOptions,
  type NormalizationResult,
  type ParserDiagnostic,
} from "./contracts.js";
import { SseReplayDetector } from "./duplicates.js";
import { materializeCanonicalEvents } from "./events.js";
import { decodeSseChunks, type SseFrame } from "./sse.js";

export const CHAT_COMPLETIONS_NORMALIZER_VERSION = "1.0.0";

type JsonRecord = Record<string, unknown>;

interface ChatUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

interface ToolAssembly {
  id?: string;
  name?: string;
  arguments: string;
}

interface ChoiceAssembly {
  readonly index: number;
  content: string;
  refusal: string;
  finishReason?: string;
  readonly tools: Map<number, ToolAssembly>;
  readonly unknownDeltas: JsonRecord[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

function tokenValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function usage(value: unknown): ChatUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const inputTokens = tokenValue(value.prompt_tokens);
  const outputTokens = tokenValue(value.completion_tokens);
  const totalTokens = tokenValue(value.total_tokens);
  if (inputTokens === null && outputTokens === null && totalTokens === null) {
    return undefined;
  }
  return { inputTokens, outputTokens, totalTokens };
}

function usageSummary(value: ChatUsage): JsonRecord {
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    totalTokens: value.totalTokens,
  };
}

function diagnostic(
  kind: ParserDiagnostic["kind"],
  message: string,
  options: {
    readonly frameIndex?: number;
    readonly eventType?: string;
    readonly fatal?: boolean;
  } = {},
): ParserDiagnostic {
  return {
    kind,
    message,
    ...(options.frameIndex === undefined
      ? {}
      : { frameIndex: options.frameIndex }),
    ...(options.eventType === undefined
      ? {}
      : { eventType: options.eventType }),
    fatal: options.fatal === true,
  };
}

function parserErrorDraft(frameIndex?: number): CanonicalEventDraft {
  return {
    type: "parser.error",
    evidence: "derived",
    summary: {
      parser: "openai.chat-completions.sse",
      ...(frameIndex === undefined ? {} : { frameIndex }),
    },
  };
}

function decodeJson(bytes: Uint8Array | undefined): unknown {
  if (bytes === undefined) {
    return undefined;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function contentType(exchange: NormalizationExchange): string {
  for (const [name, value] of Object.entries(exchange.responseHeaders ?? {})) {
    if (name.toLowerCase() === "content-type") {
      return (Array.isArray(value) ? value[0] : value) ?? "";
    }
  }
  return "";
}

function parseArguments(
  raw: string,
  diagnostics: ParserDiagnostic[],
  context: string,
): unknown {
  try {
    return JSON.parse(raw);
  } catch (error: unknown) {
    diagnostics.push(
      diagnostic(
        "invalid-payload",
        `${context} arguments were not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { eventType: context },
      ),
    );
    return raw;
  }
}

function messageText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts = content
    .filter(isRecord)
    .filter((part) => part.type === "text")
    .map((part) => stringValue(part.text) ?? "");
  return parts.length === 0 ? undefined : parts.join("");
}

function requestToolResults(request: JsonRecord | undefined) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const drafts: CanonicalEventDraft[] = [];
  for (const value of messages) {
    if (!isRecord(value) || value.role !== "tool") {
      continue;
    }
    const callId = stringValue(value.tool_call_id);
    drafts.push({
      type: "tool.result",
      summary: {
        ...(callId === undefined ? {} : { callId }),
        output: value.content ?? null,
      },
    });
  }
  return drafts;
}

function toolCallDrafts(
  calls: unknown,
  diagnostics: ParserDiagnostic[],
): CanonicalEventDraft[] {
  if (!Array.isArray(calls)) {
    return [];
  }
  const drafts: CanonicalEventDraft[] = [];
  for (const call of calls) {
    if (!isRecord(call)) {
      diagnostics.push(
        diagnostic("invalid-payload", "Chat tool call was not an object."),
      );
      continue;
    }
    const fn = isRecord(call.function) ? call.function : undefined;
    const rawArguments = stringValue(fn?.arguments) ?? "";
    drafts.push({
      type: "tool.call",
      summary: {
        ...(stringValue(call.id) === undefined
          ? {}
          : { callId: stringValue(call.id) }),
        ...(stringValue(fn?.name) === undefined
          ? {}
          : { name: stringValue(fn?.name) }),
        arguments: parseArguments(
          rawArguments,
          diagnostics,
          "chat.message.tool_call",
        ),
      },
    });
  }
  return drafts;
}

function apiErrorDraft(
  responseStatus: number | undefined,
  response: JsonRecord,
): CanonicalEventDraft | undefined {
  const error = isRecord(response.error) ? response.error : undefined;
  if (error === undefined && (responseStatus ?? 200) < 400) {
    return undefined;
  }
  return {
    type: "api.error",
    summary: {
      ...(responseStatus === undefined ? {} : { status: responseStatus }),
      ...(stringValue(error?.type) === undefined
        ? {}
        : { type: stringValue(error?.type) }),
      ...(stringValue(error?.code) === undefined
        ? {}
        : { code: stringValue(error?.code) }),
      ...(stringValue(error?.message) === undefined
        ? {}
        : { message: stringValue(error?.message) }),
    },
  };
}

function normalizeJson(
  exchange: NormalizationExchange,
  options: NormalizationOptions,
): NormalizationResult {
  const parserId = "openai.chat-completions.json";
  const diagnostics: ParserDiagnostic[] = [];
  let request: JsonRecord | undefined;
  let response: JsonRecord | undefined;
  try {
    const decoded = decodeJson(exchange.requestBody);
    if (isRecord(decoded)) {
      request = decoded;
    } else {
      diagnostics.push(
        diagnostic("invalid-payload", "Chat request must be an object."),
      );
    }
  } catch (error: unknown) {
    diagnostics.push(
      diagnostic(
        "malformed-json",
        `Chat request JSON could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  try {
    const decoded = decodeJson(exchange.responseBody);
    if (isRecord(decoded)) {
      response = decoded;
    } else {
      diagnostics.push(
        diagnostic("invalid-payload", "Chat response must be an object.", {
          fatal: true,
        }),
      );
    }
  } catch (error: unknown) {
    diagnostics.push(
      diagnostic(
        "malformed-json",
        `Chat response JSON could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
        { fatal: true },
      ),
    );
  }

  const drafts: CanonicalEventDraft[] = [];
  if (response === undefined) {
    drafts.push({
      type: "parser.error",
      evidence: "derived",
      summary: { parser: parserId },
    });
  } else {
    const apiError = apiErrorDraft(exchange.responseStatus, response);
    if (apiError !== undefined) {
      drafts.push(apiError);
    } else {
      drafts.push(...requestToolResults(request));
      drafts.push({
        type: "model.request",
        summary: {
          endpoint: exchange.path,
          ...(stringValue(request?.model) === undefined
            ? {}
            : { model: stringValue(request?.model) }),
        },
      });

      const choices = Array.isArray(response.choices) ? response.choices : [];
      for (const choiceValue of choices) {
        if (!isRecord(choiceValue)) {
          diagnostics.push(
            diagnostic("invalid-payload", "Chat choice was not an object."),
          );
          continue;
        }
        const choiceIndex = integerValue(choiceValue.index) ?? 0;
        const message = isRecord(choiceValue.message)
          ? choiceValue.message
          : undefined;
        const text = messageText(message?.content);
        const refusal = stringValue(message?.refusal);
        if (text !== undefined || refusal !== undefined) {
          drafts.push({
            type: "message.assistant",
            summary: {
              ...(choiceIndex === 0 ? {} : { choiceIndex }),
              text: text ?? "",
              ...(refusal === undefined ? {} : { refusal }),
            },
          });
        }
        drafts.push(...toolCallDrafts(message?.tool_calls, diagnostics));
        if (isRecord(message?.function_call)) {
          const rawArguments =
            stringValue(message.function_call.arguments) ?? "";
          drafts.push({
            type: "tool.call",
            evidence: "derived",
            summary: {
              callId: `legacy-choice-${choiceIndex}-function`,
              ...(stringValue(message.function_call.name) === undefined
                ? {}
                : { name: stringValue(message.function_call.name) }),
              arguments: parseArguments(
                rawArguments,
                diagnostics,
                "chat.message.function_call",
              ),
            },
          });
        }
      }

      const reported = usage(response.usage);
      if (reported !== undefined) {
        drafts.push({ type: "model.usage", summary: usageSummary(reported) });
      }
      const firstChoice = choices.find(isRecord);
      drafts.push({
        type: "model.response.completed",
        summary: {
          ...(stringValue(response.id) === undefined
            ? {}
            : { responseId: stringValue(response.id) }),
          ...(stringValue(firstChoice?.finish_reason) === undefined
            ? {}
            : { finishReason: stringValue(firstChoice?.finish_reason) }),
          ...(reported === undefined
            ? {
                usage: "unknown",
                inputTokens: null,
                outputTokens: null,
              }
            : {}),
        },
      });
    }
  }

  return NormalizationResultSchema.parse({
    parserId,
    parserVersion: CHAT_COMPLETIONS_NORMALIZER_VERSION,
    status: diagnostics.some((entry) => entry.fatal) ? "malformed" : "parsed",
    events: materializeCanonicalEvents(exchange, drafts, options),
    diagnostics,
  });
}

function choiceAssembly(
  choices: Map<number, ChoiceAssembly>,
  index: number,
): ChoiceAssembly {
  const existing = choices.get(index);
  if (existing !== undefined) {
    return existing;
  }
  const created: ChoiceAssembly = {
    index,
    content: "",
    refusal: "",
    tools: new Map(),
    unknownDeltas: [],
  };
  choices.set(index, created);
  return created;
}

function toolAssembly(choice: ChoiceAssembly, index: number): ToolAssembly {
  const existing = choice.tools.get(index);
  if (existing !== undefined) {
    return existing;
  }
  const created: ToolAssembly = { arguments: "" };
  choice.tools.set(index, created);
  return created;
}

function parseFrame(
  frame: SseFrame,
  diagnostics: ParserDiagnostic[],
): JsonRecord | undefined {
  if (frame.data === undefined || frame.data === "[DONE]") {
    return undefined;
  }
  try {
    const decoded = JSON.parse(frame.data);
    if (!isRecord(decoded)) {
      throw new TypeError("SSE data must decode to an object.");
    }
    return decoded;
  } catch (error: unknown) {
    diagnostics.push(
      diagnostic(
        "malformed-sse",
        `Chat SSE frame ${frame.index} was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { frameIndex: frame.index },
      ),
    );
    return undefined;
  }
}

const KNOWN_DELTA_FIELDS = new Set([
  "role",
  "content",
  "refusal",
  "tool_calls",
  "function_call",
]);

function applyToolDeltas(
  choice: ChoiceAssembly,
  value: unknown,
  diagnostics: ParserDiagnostic[],
  frameIndex: number,
): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const callValue of value) {
    if (!isRecord(callValue)) {
      diagnostics.push(
        diagnostic("invalid-payload", "Chat tool delta was not an object.", {
          frameIndex,
          eventType: "chat.completion.chunk",
        }),
      );
      continue;
    }
    const index = integerValue(callValue.index);
    if (index === undefined || index < 0) {
      diagnostics.push(
        diagnostic("invalid-payload", "Chat tool delta had no valid index.", {
          frameIndex,
          eventType: "chat.completion.chunk",
        }),
      );
      continue;
    }
    const assembly = toolAssembly(choice, index);
    const id = stringValue(callValue.id);
    if (id !== undefined) {
      assembly.id = id;
    }
    const fn = isRecord(callValue.function) ? callValue.function : undefined;
    const name = stringValue(fn?.name);
    if (name !== undefined) {
      assembly.name = name;
    }
    const argumentsDelta = stringValue(fn?.arguments);
    if (argumentsDelta !== undefined) {
      assembly.arguments += argumentsDelta;
    }
  }
}

function normalizeSse(
  exchange: NormalizationExchange,
  options: NormalizationOptions,
): NormalizationResult {
  const parserId = "openai.chat-completions.sse";
  const diagnostics: ParserDiagnostic[] = [];
  const parserErrors: CanonicalEventDraft[] = [];
  const duplicateErrors: CanonicalEventDraft[] = [];
  const unknownFrames: CanonicalEventDraft[] = [];
  const choices = new Map<number, ChoiceAssembly>();
  let responseId: string | undefined;
  let reportedUsage: ChatUsage | undefined;
  let incomplete = false;
  let frames: readonly SseFrame[] = [];
  const replayDetector = new SseReplayDetector();

  try {
    const decoded = decodeSseChunks(
      exchange.responseBody === undefined ? [] : [exchange.responseBody],
    );
    frames = decoded.frames;
    if (decoded.incomplete !== undefined) {
      incomplete = true;
      diagnostics.push(
        diagnostic(
          "incomplete-sse",
          `Chat SSE frame ${decoded.incomplete.index} was not terminated.`,
          { frameIndex: decoded.incomplete.index },
        ),
      );
      if (exchange.outcome === "completed") {
        parserErrors.push(parserErrorDraft(decoded.incomplete.index));
      }
    }
  } catch (error: unknown) {
    diagnostics.push(
      diagnostic(
        "malformed-sse",
        `Chat SSE decoding failed: ${error instanceof Error ? error.message : String(error)}`,
        { fatal: true },
      ),
    );
    parserErrors.push(parserErrorDraft(1));
  }

  for (const frame of frames) {
    const beforeDiagnostics = diagnostics.length;
    const payload = parseFrame(frame, diagnostics);
    if (payload === undefined) {
      if (diagnostics.length > beforeDiagnostics) {
        parserErrors.push(parserErrorDraft(frame.index));
      }
      continue;
    }
    const replay = replayDetector.observe(frame, payload);
    if (replay.kind !== "accept") {
      diagnostics.push(replay.diagnostic);
      if (replay.kind === "conflict") {
        duplicateErrors.push(parserErrorDraft(frame.index));
      }
      continue;
    }
    responseId = stringValue(payload.id) ?? responseId;
    reportedUsage = usage(payload.usage) ?? reportedUsage;
    const frameChoices = Array.isArray(payload.choices) ? payload.choices : [];
    if (frameChoices.length === 0 && reportedUsage === undefined) {
      const error = isRecord(payload.error) ? payload.error : undefined;
      if (error !== undefined) {
        unknownFrames.push({
          type: "api.error",
          summary: {
            ...(exchange.responseStatus === undefined
              ? {}
              : { status: exchange.responseStatus }),
            ...(stringValue(error.type) === undefined
              ? {}
              : { type: stringValue(error.type) }),
            ...(stringValue(error.code) === undefined
              ? {}
              : { code: stringValue(error.code) }),
            ...(stringValue(error.message) === undefined
              ? {}
              : { message: stringValue(error.message) }),
          },
        });
      } else {
        diagnostics.push(
          diagnostic(
            "unsupported-event",
            "Chat SSE frame had neither choices nor usage.",
            { frameIndex: frame.index },
          ),
        );
        unknownFrames.push({
          type: "provider.event.unknown",
          evidence: "unknown",
          summary: {
            frameIndex: frame.index,
            payload,
            rawPayloadPreserved: true,
          },
        });
      }
    }

    for (const choiceValue of frameChoices) {
      if (!isRecord(choiceValue)) {
        diagnostics.push(
          diagnostic(
            "invalid-payload",
            "Chat choice delta was not an object.",
            {
              frameIndex: frame.index,
            },
          ),
        );
        parserErrors.push(parserErrorDraft(frame.index));
        continue;
      }
      const index = integerValue(choiceValue.index);
      if (index === undefined || index < 0) {
        diagnostics.push(
          diagnostic(
            "invalid-payload",
            "Chat choice delta had no valid index.",
            {
              frameIndex: frame.index,
            },
          ),
        );
        parserErrors.push(parserErrorDraft(frame.index));
        continue;
      }
      const assembly = choiceAssembly(choices, index);
      const finishReason = stringValue(choiceValue.finish_reason);
      if (finishReason !== undefined) {
        assembly.finishReason = finishReason;
      }
      const delta = isRecord(choiceValue.delta) ? choiceValue.delta : undefined;
      if (delta === undefined) {
        continue;
      }
      assembly.content += stringValue(delta.content) ?? "";
      assembly.refusal += stringValue(delta.refusal) ?? "";
      applyToolDeltas(assembly, delta.tool_calls, diagnostics, frame.index);
      if (isRecord(delta.function_call)) {
        const legacy = toolAssembly(assembly, 0);
        legacy.id ??= `legacy-choice-${index}-function`;
        const name = stringValue(delta.function_call.name);
        if (name !== undefined) {
          legacy.name = name;
        }
        legacy.arguments += stringValue(delta.function_call.arguments) ?? "";
      }
      const unknownDelta = Object.fromEntries(
        Object.entries(delta).filter(([name]) => !KNOWN_DELTA_FIELDS.has(name)),
      );
      if (Object.keys(unknownDelta).length > 0) {
        assembly.unknownDeltas.push(unknownDelta);
      }
    }
  }

  const semantic: CanonicalEventDraft[] = [];
  for (const choice of [...choices.values()].sort(
    (left, right) => left.index - right.index,
  )) {
    if (choice.content.length > 0 || choice.refusal.length > 0) {
      semantic.push({
        type: "message.assistant",
        summary: {
          ...(choice.index === 0 ? {} : { choiceIndex: choice.index }),
          text: choice.content,
          ...(choice.refusal.length === 0 ? {} : { refusal: choice.refusal }),
        },
      });
    }
    for (const [toolIndex, tool] of [...choice.tools.entries()].sort(
      ([left], [right]) => left - right,
    )) {
      semantic.push({
        type: "tool.call",
        summary: {
          callId: tool.id ?? `choice-${choice.index}-tool-${toolIndex}`,
          ...(tool.name === undefined ? {} : { name: tool.name }),
          arguments: parseArguments(
            tool.arguments,
            diagnostics,
            "chat.completion.chunk.tool_call",
          ),
          ...(choice.index === 0 ? {} : { choiceIndex: choice.index }),
        },
      });
    }
    for (const payload of choice.unknownDeltas) {
      semantic.push({
        type: "provider.delta.unknown",
        evidence: "unknown",
        summary: {
          choiceIndex: choice.index,
          payload,
          rawPayloadPreserved: true,
        },
      });
    }
  }
  semantic.push(...unknownFrames);
  if (reportedUsage !== undefined) {
    semantic.push({
      type: "model.usage",
      summary: usageSummary(reportedUsage),
    });
  }
  const firstChoice = [...choices.values()].sort(
    (left, right) => left.index - right.index,
  )[0];
  if (responseId !== undefined || firstChoice?.finishReason !== undefined) {
    semantic.push({
      type: "model.response.completed",
      summary: {
        ...(responseId === undefined ? {} : { responseId }),
        ...(firstChoice?.finishReason === undefined
          ? {}
          : { finishReason: firstChoice.finishReason }),
        ...(reportedUsage === undefined ? { usage: "unknown" } : {}),
      },
    });
  }
  if (exchange.outcome !== "completed" || !exchange.capture.responseComplete) {
    semantic.push({
      type: "transport.error",
      evidence: "derived",
      summary: {
        outcome: exchange.outcome,
        responseComplete: exchange.capture.responseComplete,
      },
    });
  }
  if (exchange.capture.droppedResponseBytes > 0) {
    diagnostics.push(
      diagnostic(
        "capture-incomplete",
        `${exchange.capture.droppedResponseBytes} response bytes were not retained.`,
      ),
    );
  }

  const drafts =
    parserErrors.length === 0
      ? [...duplicateErrors, ...semantic]
      : [
          ...parserErrors,
          ...duplicateErrors,
          ...semantic.filter(
            (draft) =>
              draft.type === "model.response.completed" ||
              draft.type === "transport.error",
          ),
        ];
  return NormalizationResultSchema.parse({
    parserId,
    parserVersion: CHAT_COMPLETIONS_NORMALIZER_VERSION,
    status:
      parserErrors.length > 0 || duplicateErrors.length > 0 || incomplete
        ? "malformed"
        : "parsed",
    events: materializeCanonicalEvents(exchange, drafts, options),
    diagnostics,
  });
}

export class ChatCompletionsNormalizer implements ExchangeNormalizer {
  readonly id = "openai.chat-completions";
  readonly version = CHAT_COMPLETIONS_NORMALIZER_VERSION;

  supports(exchange: NormalizationExchange): boolean {
    return exchange.protocol === "openai.chat-completions";
  }

  normalize(
    input: NormalizationExchange,
    options: NormalizationOptions = {},
  ): NormalizationResult {
    const exchange = NormalizationExchangeSchema.parse(input);
    if (!this.supports(exchange)) {
      return NormalizationResultSchema.parse({
        parserId: this.id,
        parserVersion: this.version,
        status: "unsupported",
        events: [],
        diagnostics: [],
      });
    }
    return contentType(exchange).toLowerCase().includes("text/event-stream")
      ? normalizeSse(exchange, options)
      : normalizeJson(exchange, options);
  }
}
