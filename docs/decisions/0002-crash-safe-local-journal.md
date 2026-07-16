# ADR 0002: Crash-safe local evidence journal

- Status: Accepted
- Date: 2026-07-16
- Milestone: M1

## Context

The proxy will eventually forward traffic while the viewer reads live evidence. A recording failure must not block valid provider traffic, but a crash must also not leave apparently complete evidence. Large bodies and stream chunks cannot all live in hot SQLite rows.

## Decision

1. Use SQLite in WAL mode with foreign keys, bounded busy waits, transactional migrations, and a checksum ledger.
2. Allocate canonical event sequences with one atomic `UPDATE ... RETURNING` per reservation. Sequence gaps after crashes are allowed; reuse is not.
3. Store validated record JSON alongside indexed columns. The JSON preserves the versioned contract while columns serve stable queries.
4. Treat captured request identity and body hashes as immutable. A raw exchange may move from `recording` to `complete` or `recovered`, but finalization cannot rewrite its request evidence.
5. Record normalization runs by raw exchange and parser version. Repeating the same run returns its original event IDs; conflicting output is an integrity error.
6. Address blobs by the SHA-256 of decoded captured bytes. Use native Zstandard compression when it reduces size, inline small bodies, and atomically rename larger bodies into a private blob tree.
7. Verify blob length, decompression, and hash whenever evidence is read. Never silently return corrupt bytes.
8. Mark exchanges left in `recording` as explicitly incomplete during startup recovery and remove orphan temporary blob files.
9. Back up any existing database before applying a newer migration. Reject future schema versions unless query-only access is explicitly requested.

## Consequences

- A viewer can read committed evidence while the recorder writes.
- Parser failures and parser upgrades do not alter raw bodies or their hashes.
- A killed recorder leaves recoverable, visibly incomplete evidence instead of a false success.
- File and database capacity failures surface as a distinct error and leave no partial blob metadata.
- Blob files written immediately before a process crash may remain unreferenced; a later retention pass can safely identify them by content hash.
