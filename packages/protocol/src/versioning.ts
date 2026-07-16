import { z } from "zod";

import { CURRENT_SCHEMA_VERSION } from "./common.js";

const VersionProbeSchema = z
  .object({ schemaVersion: z.number().int().nonnegative() })
  .loose();

export class UnsupportedSchemaVersionError extends Error {
  readonly actualVersion: number;
  readonly expectedVersion = CURRENT_SCHEMA_VERSION;
  readonly recordKind: string;

  constructor(recordKind: string, actualVersion: number) {
    super(
      `${recordKind} schema version ${actualVersion} is unsupported; expected ${CURRENT_SCHEMA_VERSION}. Preserve the raw payload before continuing.`,
    );
    this.name = "UnsupportedSchemaVersionError";
    this.actualVersion = actualVersion;
    this.recordKind = recordKind;
  }
}

export function parseCurrentRecord<T>(
  recordKind: string,
  schema: z.ZodType<T>,
  input: unknown,
): T {
  const versionProbe = VersionProbeSchema.safeParse(input);

  if (
    versionProbe.success &&
    versionProbe.data.schemaVersion !== CURRENT_SCHEMA_VERSION
  ) {
    throw new UnsupportedSchemaVersionError(
      recordKind,
      versionProbe.data.schemaVersion,
    );
  }

  return schema.parse(input);
}
