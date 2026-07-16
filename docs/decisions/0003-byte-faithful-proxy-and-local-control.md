# ADR 0003: Byte-faithful proxy and authenticated local control

- Status: Accepted
- Date: 2026-07-16
- Milestone: M2

## Context

The recorder sits on a provider request path, so a capture defect must not alter otherwise valid traffic or exhaust the caller's machine. At the same time, a localhost process or hostile browser page must not be able to inspect or stop the daemon merely because it can reach a loopback port. CLI lifecycle also needs to survive crashes, concurrent starts, and stale lock files without killing an unrelated process.

## Decision

1. Run the recorder proxy and control API as separate Node HTTP listeners. The control listener is always loopback-only; the proxy requires explicit consent for any non-loopback bind.
2. Forward request credentials in memory, but make authorization, cookies, proxy credentials, response cookies, hop-by-hop fields, and configured sensitive headers structurally absent from persisted header contracts.
3. Pipe request and response bytes through transparent stream tees. Do not parse or reserialize traffic on the forwarding path. Preserve unknown supported HTTP routes as opaque OpenAI-compatible exchanges.
4. Bound retained request bytes, response bytes, global capture memory, and per-exchange chunk-manifest entries. Forward all traffic after a bound is reached, but mark its evidence `capture-incomplete` and expose degraded health.
5. Journal a raw exchange before forwarding, then finalize it with first-byte and end timestamps plus distinct completed, timeout, client-disconnected, upstream-disconnected, upstream-error, or capture-incomplete outcomes. Recording failures fail open; unsafe configuration fails closed.
6. Reject HTTP upgrades with `426 Upgrade Required` until WebSocket/Realtime fidelity is implemented and tested.
7. Generate one random 256-bit base64url control token per installation. Store private directories as `0700` and sensitive files as `0600`. Require bearer authentication on every control endpoint, validate loopback `Host`, and reject untrusted browser `Origin` values. Never place the token in lock records, normal output, or daemon logs.
8. Write complete lock and token files through private temporary files and atomic links/renames. Serialize lock acquisition, validate instance ownership before update or removal, reject a live owner, and recover corrupt or dead-process locks without signaling the recorded PID.
9. Launch the daemon detached with a minimal environment, wait for an authenticated ready response, and shut down in reverse dependency order. Force lingering proxy/control connections closed after a bounded grace period.

## Consequences

- OpenAI-compatible HTTP JSON/SSE clients can use the printed `OPENAI_BASE_URL` without response-body transformation.
- Slow or failed capture sacrifices evidence completeness rather than caller availability or unbounded memory.
- Authorization and cookie values remain usable upstream but cannot enter typed persisted header evidence or routine logs. Payload redaction is a separate policy layer because the same text may legitimately occur in a request body.
- CLI start is idempotent, concurrent stale-lock recovery has one winner, and stop never relies on blindly killing a PID.
- WebSocket and Realtime clients receive an explicit unsupported result instead of an unverified partial recording.
- The control API is intentionally small in M2; query, viewer, and live-event endpoints arrive in later milestones.
