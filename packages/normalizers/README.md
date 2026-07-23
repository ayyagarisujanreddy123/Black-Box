# `@blackbox/normalizers`

Deterministic normalization for OpenAI-compatible and Anthropic Messages HTTP
evidence captured by Black Box.

The package parses supported Responses, Chat Completions, and Anthropic Messages
JSON/SSE payloads into versioned canonical events while keeping parser diagnostics
and unknown items explicit. It does not proxy traffic or rewrite provider
responses. Raw exchange bytes remain a separate source of truth.

This is primarily a Black Box runtime component. Most users should install
[`@blackbox/cli`](https://www.npmjs.com/package/@blackbox/cli) instead.

## Supported normalization boundary

- OpenAI Responses JSON and server-sent events
- OpenAI Chat Completions JSON and server-sent events
- Anthropic Messages JSON and server-sent events
- Incremental text and function/tool-call argument assembly
- Usage, errors, duplicates, malformed frames, and unknown items

Responses WebSocket/Realtime traffic and Bedrock, Vertex, or other provider-native
schemas are not supported by version 0.1. See the protocol support document before
describing another client or provider as compatible.

## Project links

- [Black Box repository](https://github.com/ayyagarisujanreddy123/Black-Box)
- [Protocol support](https://github.com/ayyagarisujanreddy123/Black-Box/blob/main/docs/protocol-support.md)
- [Security policy](https://github.com/ayyagarisujanreddy123/Black-Box/security/policy)
- [Apache-2.0 license](https://github.com/ayyagarisujanreddy123/Black-Box/blob/main/LICENSE)
