# Black Box

The local flight recorder for AI coding agents.

Black Box is being built as a CLI-managed localhost recorder with a browser cockpit. It will preserve API-visible messages, tool activity, process output, and filesystem effects so an incident can be investigated from evidence rather than guesswork.

## Current status

Milestones M0 through M6 provide a runnable, byte-faithful local recorder with a live browser cockpit and client-visible context time travel:

- strict npm/TypeScript workspace boundaries;
- versioned Zod contracts for sessions, raw exchanges, canonical events, reconstructed context, blame results, and incident reports;
- byte-exact OpenAI Responses and Chat Completions protocol fixtures, including malformed and incomplete traffic;
- a safe, disposable rogue-agent demo repository and deterministic evidence transcript;
- lint, format, typecheck, unit, packaged end-to-end, and build gates;
- a versioned SQLite WAL journal with transactional migrations and pre-migration backups;
- repositories for sessions, raw exchanges, events, file changes, context edges, analysis runs, and redactions;
- monotonic per-session sequence allocation, stable cursor pagination, and rebuildable FTS5 search;
- SHA-256 content-addressed blobs with Zstandard compression, inline/external storage, atomic rename, quotas, and integrity checks;
- startup recovery for interrupted exchanges and orphan temporary blobs;
- an HTTP JSON/SSE reverse proxy that preserves downstream status, headers, body bytes, and stream order while bounding capture memory and provenance;
- explicit evidence for completion, timeouts, client cancellation, upstream disconnects, and degraded capture;
- mandatory exclusion of authorization, cookie, and configured sensitive header values from persisted header evidence;
- a private per-install control token, loopback-only authenticated control API, atomic daemon lock, stale-lock recovery, and bounded shutdown;
- working `blackbox init`, `start`, `stop`, `status`, and `doctor` commands, including detached process management and real diagnostics;
- versioned Responses JSON/SSE and Chat Completions JSON/SSE normalizers with logical text and tool-call assembly;
- durable off-path normalization, parser-error evidence, unknown-event retention, and explicit first-wins replay/conflict handling;
- explicit, adapter, known-ancestry, and bounded idle-window session assignment with isolated internal analysis sessions;
- per-session capture and normalizer-version snapshots;
- working `blackbox sessions` and `blackbox inspect` commands for canonical event JSON;
- working `blackbox run -- <command...>` with daemon reuse, session-scoped proxy injection, command metadata, byte-exact bounded stdout/stderr frames, and child exit-status preservation;
- Git-aware and plain-directory baseline/final manifests with streamed SHA-256 hashes, tracked binary patches, and bounded file-content deltas;
- separate debounced `approximate-watcher` timing and authoritative `exact-final-diff` file evidence, including create, modify, delete, and unchanged-content rename detection;
- canonical-root path exclusions, Git-ignore handling, non-followed directory symlinks, bounded watcher state, Ctrl-C/SIGTERM forwarding, and abortable final cleanup;
- authenticated, schema-validated localhost queries for sessions, events, file changes, payloads, search, and health with bounded cursor pagination;
- a bounded SSE live-event channel with sequence recovery, heartbeats, reconnect support, and slow-reader protection;
- a packaged React cockpit with session navigation, a virtualized multi-lane timeline, search, inert raw evidence, provenance/header/diff inspection, keyboard navigation, and accessible/timestamp modes;
- working `blackbox open [session-id]` routing through a loopback-only fragment credential without printing the control token in normal output;
- deterministic reconstruction of explicit Chat Completions history and locally recorded Responses ancestry with cycle, depth, and recorded-sequence guards;
- explicit exact, reconstructed, partial, provider-managed, and unsupported completeness labels with machine-readable limitation reasons;
- an authenticated context inspector with ordered items, ancestry, clickable event provenance, opaque reasoning markers, and separate reported-versus-estimated input token counts.

HTTP JSON and SSE are supported. WebSocket/Realtime transport is rejected explicitly and reported by `doctor`. Wrapped process/filesystem observation is available at capture level L2, and the cockpit can inspect recordings and reconstruct API-visible request context while the daemon is still writing them. Deterministic blame and optional model analysis arrive in later milestones.

## Development quickstart

Requirements: Node.js 22.13 or newer and npm 10 or newer.

```bash
npm install
npm run check
npm run blackbox -- --help
```

Run the recorder with the default OpenAI upstream:

```bash
npm run blackbox -- init
npm run blackbox -- doctor
npm run blackbox -- start
npm run blackbox -- status
# Point an OpenAI-compatible client at the OPENAI_BASE_URL printed by start.
npm run blackbox -- run -- <agent-command> [arguments...]
npm run blackbox -- open [session-id]
npm run blackbox -- sessions
npm run blackbox -- inspect <session-id> --json
npm run blackbox -- stop
```

Use `--home PATH` or `BLACKBOX_HOME` to select the private data directory. Configure the provider with `--upstream URL` or `BLACKBOX_UPSTREAM_URL`; Black Box deliberately never treats `OPENAI_BASE_URL` as its upstream because that variable points clients back to the recorder.

## Context time travel

Select a `model.request` event and open its **context** inspector tab. Chat Completions requests show the explicit message history sent by the client. Responses requests follow locally recorded `previous_response_id` ancestry and identify missing predecessors; Conversation objects, reusable prompt templates, server context management, unsupported payloads, and incomplete captures receive non-exact labels with the reason preserved.

Context items retain raw exchange, payload, and canonical event provenance. Provider-reported input usage remains separate from Black Box's rough visible-content estimate. Black Box does not expose or invent provider-hidden instructions or private model reasoning.

Session assignment follows explicit `X-Blackbox-Session`, adapter `X-Blackbox-Agent-Session`, known `X-Blackbox-Response-Ancestor`, and short client-idle grouping in that order. Internal model analysis must set `X-Blackbox-Analysis-Session` and may identify the investigated session with `X-Blackbox-Analysis-Target`; analysis isolation overrides all ordinary grouping signals. These reserved headers are recorder controls and are neither forwarded upstream nor retained in raw request headers.

## Wrapped process and workspace evidence

`blackbox run [--cwd PATH] -- <command...>` starts or reuses the daemon, assigns one explicit wrapped-process session, and injects a session-scoped `OPENAI_BASE_URL`. API traffic, process output, and workspace effects therefore share a session without requiring the child to construct recorder headers. The wrapper mirrors stdout/stderr and returns the child's exit code; Ctrl-C and SIGTERM are forwarded while Black Box retains a bounded cleanup window.

Before launch, the wrapper records a Git-aware or plain-directory baseline. At completion it compares that baseline directly with a new manifest, so unchanged pre-existing dirt is not attributed to the child. Small baseline-clean tracked changes retain `git diff --binary` evidence; small untracked, baseline-dirty, and non-Git changes retain a base64 file delta. Files above `--max-untracked-file-bytes` (1 MiB by default) remain hash-only. Known credential-file names such as `.env`, private keys, and credential files are also hash-only.

Filesystem timing has two deliberately distinct precision labels:

- `approximate-watcher` events are debounced observations made while the child runs. They can preserve useful timing and some transient effects, but OS watcher delivery is not an exact mutation clock.
- `exact-final-diff` events are authoritative baseline-to-final state differences. The same effect can appear once in each precision class; consumers should not silently treat them as two independent mutations.

Capture is restricted to the canonical Git/directory root. Black Box excludes `.git`, dependency/build/cache directories, its own home directory, and untracked Git-ignored paths. It records a symlink's target text but never traverses a directory symlink, and it does not claim to audit writes elsewhere on the operating system. Use `--watcher-debounce-ms`, `--cleanup-timeout-ms`, and `--max-untracked-file-bytes` to adjust the exposed bounds.

Useful individual commands:

```bash
npm run format       # verify formatting
npm run lint         # lint all implementation and test code
npm run typecheck    # check the strict shared TypeScript contract
npm test             # run unit, contract, fixture, proxy, and lifecycle tests
npm run test:e2e     # build and exercise the packaged detached CLI/daemon path
npm run build        # compile every workspace
npm run clean        # remove TypeScript build outputs
```

## Repository map

```text
apps/
  cli/              command surface and process lifecycle
  daemon/           recorder proxy and local API
  viewer/           browser cockpit (a dependency leaf)
  demo-agent/       deterministic and optional live demo agent
packages/
  protocol/         shared versioned evidence contracts
  storage/          SQLite journal and blob storage
  normalizers/      endpoint-specific JSON/SSE normalization
  context/          client-visible context reconstruction
  analysis/         anomaly, blame, and report logic
  adapters/         optional agent integrations
  test-fixtures/    byte-exact protocol fixtures
demo/               disposable rogue repository and transcript
docs/decisions/     implementation decision records
```

See [design.md](./design.md) for the product and architecture contract, [plan.md](./plan.md) for milestone acceptance criteria, and [CONTRIBUTING.md](./CONTRIBUTING.md) before changing schemas or golden fixtures.
