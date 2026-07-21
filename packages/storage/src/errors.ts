export class StorageError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageError";
    this.code = code;
  }
}

export class StorageCompatibilityError extends StorageError {
  readonly actualVersion: number;
  readonly supportedVersion: number;

  constructor(actualVersion: number, supportedVersion: number) {
    super(
      "STORAGE_SCHEMA_NEWER",
      `Database schema version ${actualVersion} is newer than supported version ${supportedVersion}.`,
    );
    this.name = "StorageCompatibilityError";
    this.actualVersion = actualVersion;
    this.supportedVersion = supportedVersion;
  }
}

export class StorageRuntimeCompatibilityError extends StorageError {
  readonly actualVersion: string;
  readonly minimumVersion: string;

  constructor(actualVersion: string, minimumVersion: string) {
    super(
      "STORAGE_RUNTIME_UNSUPPORTED",
      `Node.js ${actualVersion} does not provide the required Zstandard storage APIs; use Node.js ${minimumVersion} or newer.`,
    );
    this.name = "StorageRuntimeCompatibilityError";
    this.actualVersion = actualVersion;
    this.minimumVersion = minimumVersion;
  }
}

export class StorageIntegrityError extends StorageError {
  constructor(message: string, options?: ErrorOptions) {
    super("STORAGE_INTEGRITY", message, options);
    this.name = "StorageIntegrityError";
  }
}

export class MigrationError extends StorageError {
  readonly migrationVersion: number;

  constructor(version: number, message: string, options?: ErrorOptions) {
    super("STORAGE_MIGRATION", message, options);
    this.name = "MigrationError";
    this.migrationVersion = version;
  }
}

export class BlobCorruptionError extends StorageIntegrityError {
  readonly blobId: string;

  constructor(blobId: string, message: string, options?: ErrorOptions) {
    super(`Blob ${blobId} failed integrity verification: ${message}`, options);
    this.name = "BlobCorruptionError";
    this.blobId = blobId;
  }
}

export class StorageCapacityError extends StorageError {
  constructor(message: string, options?: ErrorOptions) {
    super("STORAGE_CAPACITY", message, options);
    this.name = "StorageCapacityError";
  }
}

export class ImmutableEvidenceError extends StorageIntegrityError {
  constructor(message: string) {
    super(message);
    this.name = "ImmutableEvidenceError";
  }
}

export class SequenceAllocationError extends StorageError {
  constructor(sessionId: string) {
    super(
      "SEQUENCE_ALLOCATION",
      `Cannot allocate a sequence for missing session ${sessionId}.`,
    );
    this.name = "SequenceAllocationError";
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const { code } = error;
  return typeof code === "string" ? code : undefined;
}

export function isCapacityFailure(error: unknown): boolean {
  return ["ENOSPC", "EDQUOT", "SQLITE_FULL"].includes(errorCode(error) ?? "");
}

export function throwTranslatedCapacityError(
  error: unknown,
  operation: string,
): never {
  if (isCapacityFailure(error)) {
    throw new StorageCapacityError(
      `${operation} failed because storage capacity was exhausted.`,
      { cause: error },
    );
  }

  throw error;
}
