# `@blackbox/storage`

The storage package is the durable local Black Box evidence journal. It can be used
independently of the daemon and viewer, although it is primarily a Black Box
runtime component. Most users should install
[`@blackbox/cli`](https://www.npmjs.com/package/@blackbox/cli) instead.

```ts
import { openBlackBoxStorage } from "@blackbox/storage";

const storage = await openBlackBoxStorage({
  databasePath: "/path/to/blackbox.sqlite",
  dataDirectory: "/path/to/blackbox-data",
});

try {
  console.log(storage.schemaVersion, storage.recovery);
} finally {
  storage.close();
}
```

Opening a writable store enables WAL, validates the migration ledger, applies
pending migrations after a backup, removes orphan temporary blobs, and marks
interrupted exchanges as incomplete. Pass `allowNewerReadOnly: true` only when
query-only access to a future schema is preferable to a compatibility error.

Blob reads always verify stored length, decoded length, and SHA-256.
`unsafeDatabase` exists for diagnostics and low-level tests; application code
should use the repositories. Do not write directly to the database or blob
directory from another process.

## Project links

- [Black Box repository](https://github.com/ayyagarisujanreddy123/Black-Box)
- [Storage architecture](https://github.com/ayyagarisujanreddy123/Black-Box/blob/main/docs/decisions/0002-crash-safe-local-journal.md)
- [Security policy](https://github.com/ayyagarisujanreddy123/Black-Box/security/policy)
- [Apache-2.0 license](https://github.com/ayyagarisujanreddy123/Black-Box/blob/main/LICENSE)
