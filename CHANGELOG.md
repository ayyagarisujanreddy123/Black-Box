# Changelog

This file records user-visible changes to Black Box. Version 0.1.0 remains an unreleased source candidate until an official tag and package publication are completed.

## 0.1.0 — Unreleased

### Added

- Byte-faithful localhost proxy capture for supported OpenAI Responses and Chat Completions JSON/SSE traffic.
- Crash-safe SQLite evidence journal, content-addressed blob storage, recovery, migrations, quotas, retention, and explicit garbage collection.
- `blackbox run` process capture with bounded output, signal forwarding, workspace baselines, live observations, and authoritative final file evidence.
- Authenticated local browser cockpit with session navigation, virtualized timeline, evidence inspection, context reconstruction, search, and live updates.
- Deterministic blame ranking, anomaly detection, incident reports, and explicit opt-in AI narrative enrichment with evidence minimization and consent binding.
- Tamper-evident share and forensic `.bbx` archives with strict verification and database-enforced read-only imports.
- Repeatable offline incident demo, measured local performance harness, cross-platform CI definition, clean-install package smoke testing, and release-candidate preflight.

### Security and privacy

- Sensitive authorization and cookie headers are excluded from persisted evidence.
- Control and cockpit services default to loopback with token and origin checks.
- Recorded markup remains inert, optional external analysis is disabled by default, and imported evidence cannot trigger analysis or replay.
- Apache-2.0 licensing and generated third-party notices are included in future runtime package contents.
- Repository install scripts are explicitly reviewed and version-pinned for npm's dependency lifecycle policy.

### Fixed

- Corrected the minimum Node.js requirement to 22.15.0, the first 22.x release with the Zstandard APIs required by the evidence blob store, and added an explicit `doctor` runtime check.

### Known limitations

- Responses WebSocket/Realtime and non-OpenAI provider protocols are not supported.
- Agent-specific adapters are not bundled.
- Black Box observes configured API, wrapped-process, and repository boundaries; it is not an operating-system sandbox or universal activity monitor.
- npm publication, signed tagging, and registry installation verification are deferred.
