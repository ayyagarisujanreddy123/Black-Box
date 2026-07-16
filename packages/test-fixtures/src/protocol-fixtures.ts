import { encodeUtf8 } from "./bytes.js";

export const REQUIRED_PROTOCOL_COVERAGE = [
  "responses-json-text",
  "responses-sse-text-and-function-arguments",
  "chat-completions-json",
  "chat-completions-sse-content-and-tool-deltas",
  "http-4xx-json-error",
  "mid-stream-disconnect",
  "malformed-sse-line",
  "unknown-v1-route",
  "usage-present",
  "usage-absent",
  "missing-previous-response",
] as const;

export type ProtocolCoverage = (typeof REQUIRED_PROTOCOL_COVERAGE)[number];

export interface ProtocolFixture {
  readonly id: string;
  readonly description: string;
  readonly covers: readonly ProtocolCoverage[];
  readonly protocol:
    | "openai.responses"
    | "openai.chat-completions"
    | "unknown-openai-compatible";
  readonly request: {
    readonly method: "POST";
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly chunks: readonly Uint8Array[];
  };
  readonly response: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly chunks: readonly Uint8Array[];
    readonly outcome:
      "completed" | "upstream-disconnected" | "capture-incomplete";
  };
  readonly expectedRawBytes: {
    readonly request: Uint8Array;
    readonly response: Uint8Array;
  };
  readonly expectedCanonicalEvents: readonly unknown[];
}

interface FixtureSource {
  readonly id: string;
  readonly description: string;
  readonly covers: readonly ProtocolCoverage[];
  readonly protocol: ProtocolFixture["protocol"];
  readonly path: string;
  readonly requestChunks: readonly string[];
  readonly expectedRequest: string;
  readonly status: number;
  readonly responseContentType: string;
  readonly responseChunks: readonly string[];
  readonly expectedResponse: string;
  readonly outcome: ProtocolFixture["response"]["outcome"];
  readonly expectedCanonicalEvents: readonly unknown[];
}

const FIXTURE_TIME = "2026-07-15T12:00:00.000Z";
const FIXTURE_SESSION_ID = "session-golden-protocol";

function event(
  fixtureId: string,
  sequence: number,
  type: string,
  summary: Readonly<Record<string, unknown>>,
  options: {
    readonly evidence?: "observed" | "derived" | "unknown";
    readonly source?: "proxy" | "analysis";
  } = {},
): unknown {
  return {
    schemaVersion: 1,
    id: `event-${fixtureId}-${sequence}`,
    sessionId: FIXTURE_SESSION_ID,
    sequence,
    occurredAt: FIXTURE_TIME,
    observedAt: FIXTURE_TIME,
    source: options.source ?? "proxy",
    type,
    evidence: options.evidence ?? "observed",
    summary,
    redaction: { applied: false, ruleIds: [] },
  };
}

function defineFixture(source: FixtureSource): ProtocolFixture {
  return {
    id: source.id,
    description: source.description,
    covers: source.covers,
    protocol: source.protocol,
    request: {
      method: "POST",
      path: source.path,
      headers: { "content-type": "application/json" },
      chunks: source.requestChunks.map(encodeUtf8),
    },
    response: {
      status: source.status,
      headers: { "content-type": source.responseContentType },
      chunks: source.responseChunks.map(encodeUtf8),
      outcome: source.outcome,
    },
    expectedRawBytes: {
      request: encodeUtf8(source.expectedRequest),
      response: encodeUtf8(source.expectedResponse),
    },
    expectedCanonicalEvents: source.expectedCanonicalEvents,
  };
}

const responsesJsonRequest = JSON.stringify({
  model: "gpt-5.2",
  input: "Say hello.",
});
const responsesJsonResponse = JSON.stringify({
  id: "resp_text",
  object: "response",
  status: "completed",
  output: [
    {
      type: "message",
      id: "msg_text",
      role: "assistant",
      content: [{ type: "output_text", text: "Hello." }],
    },
  ],
  usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 },
});

const responsesSseRequest = JSON.stringify({
  model: "gpt-5.2",
  input: "Inspect the repository.",
  stream: true,
  tools: [{ type: "function", name: "read_file" }],
});
const responsesSseChunks = [
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_stream"}}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_',
  'text.delta","item_id":"msg_stream","delta":"I will "}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_stream","delta":"check."}\n\n',
  'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"call_stream","delta":"{\\"path\\":\\"READ"}\n\n',
  'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"call_stream","delta":"ME.md\\"}"}\n\n',
  'event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","item_id":"call_stream","name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_stream","status":"completed","usage":{"input_tokens":18,"output_tokens":11,"total_tokens":29}}}\n\n',
];
const responsesSseBody = responsesSseChunks.join("");

const chatJsonRequest = JSON.stringify({
  model: "gpt-5.2",
  messages: [{ role: "user", content: "Say hello." }],
});
const chatJsonResponse = JSON.stringify({
  id: "chatcmpl_json",
  object: "chat.completion",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hello from chat." },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
});

const chatSseRequest = JSON.stringify({
  model: "gpt-5.2",
  messages: [{ role: "user", content: "Read README.md." }],
  tools: [{ type: "function", function: { name: "read_file" } }],
  stream: true,
});
const chatSseChunks = [
  'data: {"id":"chatcmpl_stream","choices":[{"index":0,"delta":{"role":"assistant","content":"I will "},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl_stream","choices":[{"index":0,"delta":{"content":"inspect it."},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl_stream","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"tool_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":"}}]},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl_stream","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
  'data: {"id":"chatcmpl_stream","choices":[],"usage":{"prompt_tokens":21,"completion_tokens":12,"total_tokens":33}}\n\n',
  "data: [DONE]\n\n",
];
const chatSseBody = chatSseChunks.join("");

const errorRequest = JSON.stringify({ model: "missing-model", input: "Hello" });
const errorResponse = JSON.stringify({
  error: {
    message: "The requested model does not exist.",
    type: "invalid_request_error",
    code: "model_not_found",
  },
});

const disconnectRequest = JSON.stringify({
  model: "gpt-5.2",
  input: "Stream a response.",
  stream: true,
});
const disconnectChunks = [
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_disconnect"}}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_disconnect","delta":"Partial",',
];
const disconnectBody = disconnectChunks.join("");

const malformedRequest = JSON.stringify({
  model: "gpt-5.2",
  input: "Malformed fixture.",
  stream: true,
});
const malformedChunks = [
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_malformed"}}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":\n\n',
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_malformed","status":"completed"}}\n\n',
];
const malformedBody = malformedChunks.join("");

const unknownRequest = JSON.stringify({
  model: "gpt-5.2",
  operation: "opaque",
});
const unknownResponse = JSON.stringify({
  id: "opaque_1",
  result: { value: 42 },
});

const usagePresentRequest = JSON.stringify({
  model: "gpt-5.2",
  input: "Usage fixture.",
});
const usagePresentResponse = JSON.stringify({
  id: "resp_usage",
  object: "response",
  status: "completed",
  output: [],
  usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
});

const usageAbsentRequest = JSON.stringify({
  model: "gpt-5.2",
  input: "No usage fixture.",
});
const usageAbsentResponse = JSON.stringify({
  id: "resp_no_usage",
  object: "response",
  status: "completed",
  output: [],
});

const missingPreviousRequest = JSON.stringify({
  model: "gpt-5.2",
  previous_response_id: "resp_not_recorded",
  input: [{ role: "user", content: "Continue." }],
});
const missingPreviousResponse = JSON.stringify({
  id: "resp_child",
  object: "response",
  status: "completed",
  output: [],
});

export const protocolFixtures: readonly ProtocolFixture[] = [
  defineFixture({
    id: "responses-json-text",
    description:
      "Responses API non-streaming assistant text and reported usage",
    covers: ["responses-json-text"],
    protocol: "openai.responses",
    path: "/v1/responses",
    requestChunks: [responsesJsonRequest],
    expectedRequest: responsesJsonRequest,
    status: 200,
    responseContentType: "application/json",
    responseChunks: [responsesJsonResponse],
    expectedResponse: responsesJsonResponse,
    outcome: "completed",
    expectedCanonicalEvents: [
      event("responses-json-text", 1, "model.request", {
        endpoint: "/v1/responses",
        model: "gpt-5.2",
      }),
      event("responses-json-text", 2, "message.assistant", {
        messageId: "msg_text",
        text: "Hello.",
      }),
      event("responses-json-text", 3, "model.usage", {
        inputTokens: 7,
        outputTokens: 2,
        totalTokens: 9,
      }),
      event("responses-json-text", 4, "model.response.completed", {
        responseId: "resp_text",
        status: "completed",
      }),
    ],
  }),
  defineFixture({
    id: "responses-sse-text-function",
    description:
      "Responses SSE split across transport chunks with text and function argument deltas",
    covers: ["responses-sse-text-and-function-arguments"],
    protocol: "openai.responses",
    path: "/v1/responses",
    requestChunks: [
      responsesSseRequest.slice(0, 27),
      responsesSseRequest.slice(27),
    ],
    expectedRequest: responsesSseRequest,
    status: 200,
    responseContentType: "text/event-stream",
    responseChunks: responsesSseChunks,
    expectedResponse: responsesSseBody,
    outcome: "completed",
    expectedCanonicalEvents: [
      event("responses-sse-text-function", 1, "model.response.started", {
        responseId: "resp_stream",
      }),
      event("responses-sse-text-function", 2, "message.assistant", {
        messageId: "msg_stream",
        text: "I will check.",
      }),
      event("responses-sse-text-function", 3, "tool.call", {
        callId: "call_stream",
        name: "read_file",
        arguments: { path: "README.md" },
      }),
      event("responses-sse-text-function", 4, "model.usage", {
        inputTokens: 18,
        outputTokens: 11,
        totalTokens: 29,
      }),
      event("responses-sse-text-function", 5, "model.response.completed", {
        responseId: "resp_stream",
        status: "completed",
      }),
    ],
  }),
  defineFixture({
    id: "chat-json",
    description: "Chat Completions non-streaming assistant content",
    covers: ["chat-completions-json"],
    protocol: "openai.chat-completions",
    path: "/v1/chat/completions",
    requestChunks: [chatJsonRequest],
    expectedRequest: chatJsonRequest,
    status: 200,
    responseContentType: "application/json",
    responseChunks: [chatJsonResponse],
    expectedResponse: chatJsonResponse,
    outcome: "completed",
    expectedCanonicalEvents: [
      event("chat-json", 1, "model.request", {
        endpoint: "/v1/chat/completions",
        model: "gpt-5.2",
      }),
      event("chat-json", 2, "message.assistant", {
        text: "Hello from chat.",
      }),
      event("chat-json", 3, "model.usage", {
        inputTokens: 9,
        outputTokens: 4,
        totalTokens: 13,
      }),
      event("chat-json", 4, "model.response.completed", {
        responseId: "chatcmpl_json",
        finishReason: "stop",
      }),
    ],
  }),
  defineFixture({
    id: "chat-sse-content-tools",
    description:
      "Chat Completions SSE content and tool arguments assembled from deltas",
    covers: ["chat-completions-sse-content-and-tool-deltas"],
    protocol: "openai.chat-completions",
    path: "/v1/chat/completions",
    requestChunks: [chatSseRequest],
    expectedRequest: chatSseRequest,
    status: 200,
    responseContentType: "text/event-stream",
    responseChunks: chatSseChunks,
    expectedResponse: chatSseBody,
    outcome: "completed",
    expectedCanonicalEvents: [
      event("chat-sse-content-tools", 1, "message.assistant", {
        text: "I will inspect it.",
      }),
      event("chat-sse-content-tools", 2, "tool.call", {
        callId: "tool_1",
        name: "read_file",
        arguments: { path: "README.md" },
      }),
      event("chat-sse-content-tools", 3, "model.usage", {
        inputTokens: 21,
        outputTokens: 12,
        totalTokens: 33,
      }),
      event("chat-sse-content-tools", 4, "model.response.completed", {
        responseId: "chatcmpl_stream",
        finishReason: "tool_calls",
      }),
    ],
  }),
  defineFixture({
    id: "http-4xx-error",
    description: "Provider 4xx JSON error remains inspectable",
    covers: ["http-4xx-json-error"],
    protocol: "openai.responses",
    path: "/v1/responses",
    requestChunks: [errorRequest],
    expectedRequest: errorRequest,
    status: 404,
    responseContentType: "application/json",
    responseChunks: [errorResponse],
    expectedResponse: errorResponse,
    outcome: "completed",
    expectedCanonicalEvents: [
      event("http-4xx-error", 1, "api.error", {
        status: 404,
        type: "invalid_request_error",
        code: "model_not_found",
        message: "The requested model does not exist.",
      }),
    ],
  }),
  defineFixture({
    id: "mid-stream-disconnect",
    description: "Upstream closes a Responses stream during a JSON event",
    covers: ["mid-stream-disconnect"],
    protocol: "openai.responses",
    path: "/v1/responses",
    requestChunks: [disconnectRequest],
    expectedRequest: disconnectRequest,
    status: 200,
    responseContentType: "text/event-stream",
    responseChunks: disconnectChunks,
    expectedResponse: disconnectBody,
    outcome: "upstream-disconnected",
    expectedCanonicalEvents: [
      event("mid-stream-disconnect", 1, "model.response.started", {
        responseId: "resp_disconnect",
      }),
      event(
        "mid-stream-disconnect",
        2,
        "transport.error",
        {
          outcome: "upstream-disconnected",
          responseComplete: false,
        },
        { evidence: "derived" },
      ),
    ],
  }),
  defineFixture({
    id: "malformed-sse-line",
    description:
      "Malformed SSE data emits parser evidence without hiding raw bytes",
    covers: ["malformed-sse-line"],
    protocol: "openai.responses",
    path: "/v1/responses",
    requestChunks: [malformedRequest],
    expectedRequest: malformedRequest,
    status: 200,
    responseContentType: "text/event-stream",
    responseChunks: malformedChunks,
    expectedResponse: malformedBody,
    outcome: "completed",
    expectedCanonicalEvents: [
      event(
        "malformed-sse-line",
        1,
        "parser.error",
        { parser: "openai.responses.sse", frameIndex: 2 },
        { evidence: "derived" },
      ),
      event("malformed-sse-line", 2, "model.response.completed", {
        responseId: "resp_malformed",
        status: "completed",
      }),
    ],
  }),
  defineFixture({
    id: "unknown-v1-route",
    description:
      "Unknown OpenAI-compatible route is retained as opaque evidence",
    covers: ["unknown-v1-route"],
    protocol: "unknown-openai-compatible",
    path: "/v1/opaque-operation",
    requestChunks: [unknownRequest],
    expectedRequest: unknownRequest,
    status: 200,
    responseContentType: "application/json",
    responseChunks: [unknownResponse],
    expectedResponse: unknownResponse,
    outcome: "completed",
    expectedCanonicalEvents: [
      event(
        "unknown-v1-route",
        1,
        "unknown_api_exchange",
        {
          path: "/v1/opaque-operation",
          rawPayloadPreserved: true,
        },
        { evidence: "unknown" },
      ),
    ],
  }),
  defineFixture({
    id: "usage-present",
    description: "Reported usage remains an observed fact",
    covers: ["usage-present"],
    protocol: "openai.responses",
    path: "/v1/responses",
    requestChunks: [usagePresentRequest],
    expectedRequest: usagePresentRequest,
    status: 200,
    responseContentType: "application/json",
    responseChunks: [usagePresentResponse],
    expectedResponse: usagePresentResponse,
    outcome: "completed",
    expectedCanonicalEvents: [
      event("usage-present", 1, "model.usage", {
        status: "reported",
        inputTokens: 5,
        outputTokens: 1,
        totalTokens: 6,
      }),
    ],
  }),
  defineFixture({
    id: "usage-absent",
    description: "Missing usage is represented as unknown, never zero",
    covers: ["usage-absent"],
    protocol: "openai.responses",
    path: "/v1/responses",
    requestChunks: [usageAbsentRequest],
    expectedRequest: usageAbsentRequest,
    status: 200,
    responseContentType: "application/json",
    responseChunks: [usageAbsentResponse],
    expectedResponse: usageAbsentResponse,
    outcome: "completed",
    expectedCanonicalEvents: [
      event("usage-absent", 1, "model.response.completed", {
        responseId: "resp_no_usage",
        usage: "unknown",
        inputTokens: null,
        outputTokens: null,
      }),
    ],
  }),
  defineFixture({
    id: "missing-previous-response",
    description:
      "A missing previous_response_id predecessor produces a partial context label",
    covers: ["missing-previous-response"],
    protocol: "openai.responses",
    path: "/v1/responses",
    requestChunks: [missingPreviousRequest],
    expectedRequest: missingPreviousRequest,
    status: 200,
    responseContentType: "application/json",
    responseChunks: [missingPreviousResponse],
    expectedResponse: missingPreviousResponse,
    outcome: "completed",
    expectedCanonicalEvents: [
      event("missing-previous-response", 1, "model.request", {
        previousResponseId: "resp_not_recorded",
        contextCompleteness: "partial-client-chain",
        missingAncestorIds: ["resp_not_recorded"],
      }),
      event("missing-previous-response", 2, "model.response.completed", {
        responseId: "resp_child",
        usage: "unknown",
      }),
    ],
  }),
] as const;

export function getProtocolFixture(id: string): ProtocolFixture {
  const fixture = protocolFixtures.find((candidate) => candidate.id === id);

  if (fixture === undefined) {
    throw new Error(`Unknown protocol fixture: ${id}`);
  }

  return fixture;
}
