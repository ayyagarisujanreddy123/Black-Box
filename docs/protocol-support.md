# Protocol and transport support

Black Box is an HTTP reverse proxy for OpenAI-compatible clients. The proxy preserves response bytes while normalization creates a separate derived evidence layer; a parser failure does not rewrite a valid upstream response.

| Surface                              | Forwarding  | Normalized evidence | Notes                                                        |
| ------------------------------------ | ----------- | ------------------- | ------------------------------------------------------------ |
| `/v1/responses` JSON                 | Yes         | Yes                 | Request, output items, tool calls/results, errors and usage  |
| `/v1/responses` SSE                  | Yes         | Yes                 | Ordered chunks retained with byte-fidelity fixture coverage  |
| `/v1/chat/completions` JSON          | Yes         | Yes                 | Messages, choices, tool calls, errors and usage              |
| `/v1/chat/completions` SSE           | Yes         | Yes                 | Ordered streaming normalization                              |
| Other HTTP `/v1/*` routes            | Yes         | Raw/unknown         | Forwarded when possible; no unsupported semantic claim       |
| Responses WebSocket / Realtime       | No          | No                  | Upgrade requests are rejected explicitly                     |
| Non-OpenAI provider-specific schemas | Not claimed | No                  | May forward as ordinary HTTP only when compatible with setup |

## Client setup

`blackbox run -- <command>` injects a session-scoped `OPENAI_BASE_URL` ending in `/v1`. The child must honor that variable for provider traffic to pass through Black Box. Process and workspace evidence still works when the child ignores it, but API evidence will be absent.

For a separately managed client, run `blackbox start` and configure the client to use the printed proxy origin as its OpenAI-compatible base URL. This is L1/API capture: Black Box cannot see out-of-band tool execution or file effects without the wrapper or an adapter.

## Fidelity and bounds

Hop-by-hop headers are removed as required for proxying, sensitive credential headers are forwarded in memory when needed but excluded from persisted evidence, and the upstream response body is passed through unchanged. Capture queues, request/response body sizes and stream-manifest entries are bounded. If a bound, disconnect, crash or storage failure prevents a complete recording, the raw exchange is retained as incomplete rather than represented as complete.

Run `blackbox doctor` to inspect the selected upstream, listeners, storage, quota and known WebSocket limitation before a live capture.
