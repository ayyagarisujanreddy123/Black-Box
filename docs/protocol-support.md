# Protocol and transport support

Black Box is an HTTP reverse proxy for OpenAI-compatible and Anthropic Messages clients. The proxy preserves response bytes while normalization creates a separate derived evidence layer; a parser failure does not rewrite a valid upstream response.

| Surface                                  | Forwarding  | Normalized evidence | Notes                                                        |
| ---------------------------------------- | ----------- | ------------------- | ------------------------------------------------------------ |
| `/v1/responses` JSON                     | Yes         | Yes                 | Request, output items, tool calls/results, errors and usage  |
| `/v1/responses` SSE                      | Yes         | Yes                 | Ordered chunks retained with byte-fidelity fixture coverage  |
| `/v1/chat/completions` JSON              | Yes         | Yes                 | Messages, choices, tool calls, errors and usage              |
| `/v1/chat/completions` SSE               | Yes         | Yes                 | Ordered streaming normalization                              |
| `/v1/messages` JSON                      | Yes         | Yes                 | Anthropic text, tool use/results, errors, stop reason, usage |
| `/v1/messages` SSE                       | Yes         | Yes                 | Anthropic message/content deltas and mid-stream errors       |
| Other HTTP `/v1/*` routes                | Yes         | Raw/unknown         | Forwarded when possible; no unsupported semantic claim       |
| Responses WebSocket / Realtime           | No          | No                  | Upgrade requests are rejected explicitly                     |
| Bedrock, Vertex, or other native schemas | Not claimed | No                  | Require a dedicated protocol integration                     |

## Client setup

`blackbox run -- <command>` auto-detects direct `codex` and `claude` executables. Codex receives a one-run `openai_base_url` CLI override and a session-scoped `OPENAI_BASE_URL` ending in `/v1`. Claude receives a session-scoped `ANTHROPIC_BASE_URL` without the `/v1` suffix expected to be added by Anthropic clients. Use `--agent` when a shell, package runner, or other launcher hides the real executable.

The default upstream is `https://api.openai.com` for Codex/OpenAI-compatible clients and `https://api.anthropic.com` for Claude. `--upstream` and `BLACKBOX_UPSTREAM_URL` override that selection with a credential-free HTTP(S) origin. Each wrapped session stores its validated upstream so differently configured clients can reuse one daemon without cross-provider routing.

For a separately managed client, run `blackbox start --upstream <provider-origin>` and configure the client with the printed base URL. This is L1/API capture: Black Box cannot see out-of-band tool execution or file effects without the wrapper or an adapter.

Native Claude support covers the Anthropic Messages HTTP API. Claude Code configurations that use Bedrock, Vertex AI, or another provider-native protocol are outside this boundary. OpenAI Responses WebSocket/Realtime remains unsupported.

## Fidelity and bounds

Hop-by-hop headers are removed as required for proxying. `authorization`, `x-api-key`, cookies, proxy credentials, and configured sensitive headers are forwarded in memory when needed but excluded from persisted header evidence. Existing stores are migrated to scrub any historically retained `x-api-key` header fields. The upstream response body is passed through unchanged. Capture queues, request/response body sizes and stream-manifest entries are bounded. If a bound, disconnect, crash or storage failure prevents a complete recording, the raw exchange is retained as incomplete rather than represented as complete.

Run `blackbox doctor` to inspect the selected upstream, listeners, storage, quota and known WebSocket limitation before a live capture.
