import { randomBytes } from "node:crypto";

import { z } from "zod";

import {
  createPrivateFileExclusive,
  ensurePrivateDirectory,
  readPrivateTextFile,
} from "./private-files.js";

export const ControlTokenSchema = z
  .string()
  .regex(/^[A-Za-z\d_-]{43}$/u, "Expected a 256-bit base64url token");

export class InvalidControlTokenError extends Error {
  constructor(path: string) {
    super(`Control token is invalid or incomplete: ${path}`);
    this.name = "InvalidControlTokenError";
  }
}

function parseControlToken(contents: string, path: string): string {
  const token = contents.trim();
  if (!ControlTokenSchema.safeParse(token).success) {
    throw new InvalidControlTokenError(path);
  }
  return token;
}

export async function readControlToken(path: string): Promise<string> {
  return parseControlToken(await readPrivateTextFile(path), path);
}

export async function ensureControlToken(
  homeDirectory: string,
  tokenPath: string,
): Promise<string> {
  await ensurePrivateDirectory(homeDirectory);
  const generated = randomBytes(32).toString("base64url");
  const created = await createPrivateFileExclusive(tokenPath, `${generated}\n`);
  return created ? generated : readControlToken(tokenPath);
}
