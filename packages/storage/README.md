# `@blackbox/storage`

The storage package is the durable local evidence journal. It can be used independently of the daemon and viewer.

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

Opening a writable store enables WAL, validates the migration ledger, applies pending migrations after a backup, removes orphan temporary blobs, and marks interrupted exchanges as incomplete. Pass `allowNewerReadOnly: true` only when query-only access to a future schema is preferable to a compatibility error.

Blob reads always verify stored length, decoded length, and SHA-256. `unsafeDatabase` exists for diagnostics and low-level tests; application code should use the repositories.
