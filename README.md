# Black Box

The local flight recorder for AI coding agents.

Black Box is being built as a CLI-managed localhost recorder with a browser cockpit. It will preserve API-visible messages, tool activity, process output, and filesystem effects so an incident can be investigated from evidence rather than guesswork.

## Current status

Milestones M0 through M3 provide a runnable, byte-faithful local recorder with canonical evidence:

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
- working `blackbox sessions` and `blackbox inspect` commands for canonical event JSON.

HTTP JSON and SSE are supported. WebSocket/Realtime transport is rejected explicitly and reported by `doctor`. Process/filesystem observation begins in M4; the browser query API and viewer begin in M5. Deterministic and optional model analysis arrive in later milestones.

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
npm run blackbox -- sessions
npm run blackbox -- inspect <session-id> --json
npm run blackbox -- stop
```

Use `--home PATH` or `BLACKBOX_HOME` to select the private data directory. Configure the provider with `--upstream URL` or `BLACKBOX_UPSTREAM_URL`; Black Box deliberately never treats `OPENAI_BASE_URL` as its upstream because that variable points clients back to the recorder.

Session assignment follows explicit `X-Blackbox-Session`, adapter `X-Blackbox-Agent-Session`, known `X-Blackbox-Response-Ancestor`, and short client-idle grouping in that order. Internal model analysis must set `X-Blackbox-Analysis-Session` and may identify the investigated session with `X-Blackbox-Analysis-Target`; analysis isolation overrides all ordinary grouping signals. These reserved headers are recorder controls and are neither forwarded upstream nor retained in raw request headers.

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
