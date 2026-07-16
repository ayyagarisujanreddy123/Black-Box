# Black Box

The local flight recorder for AI coding agents.

Black Box is being built as a CLI-managed localhost recorder with a browser cockpit. It will preserve API-visible messages, tool activity, process output, and filesystem effects so an incident can be investigated from evidence rather than guesswork.

## Current status

Milestones M0 and M1 establish the implementation and durable-evidence foundation:

- strict npm/TypeScript workspace boundaries;
- versioned Zod contracts for sessions, raw exchanges, canonical events, reconstructed context, blame results, and incident reports;
- byte-exact OpenAI Responses and Chat Completions protocol fixtures, including malformed and incomplete traffic;
- a safe, disposable rogue-agent demo repository and deterministic evidence transcript;
- lint, format, typecheck, unit-test, and build gates.
- a versioned SQLite WAL journal with transactional migrations and pre-migration backups;
- repositories for sessions, raw exchanges, events, file changes, context edges, analysis runs, and redactions;
- monotonic per-session sequence allocation, stable cursor pagination, and rebuildable FTS5 search;
- SHA-256 content-addressed blobs with Zstandard compression, inline/external storage, atomic rename, quotas, and integrity checks;
- startup recovery for interrupted exchanges and orphan temporary blobs.

The recorder daemon, proxy, and viewer are not implemented yet. The CLI skeleton reports unsupported commands instead of simulating capture.

## Development quickstart

Requirements: Node.js 22.13 or newer and npm 10 or newer.

```bash
npm install
npm run check
npm run blackbox -- --help
```

Useful individual commands:

```bash
npm run format       # verify formatting
npm run lint         # lint all implementation and test code
npm run typecheck    # check the strict shared TypeScript contract
npm test             # run contract and fixture tests
npm run test:e2e     # run the end-to-end suite (empty until M1)
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
