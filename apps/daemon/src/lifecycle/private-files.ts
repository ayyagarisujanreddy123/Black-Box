import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_PRIVATE_TEXT_BYTES = 64 * 1024;

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const information = await lstat(path);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error(`Private data path is not a real directory: ${path}`);
  }
  await chmod(path, PRIVATE_DIRECTORY_MODE);
}

async function writeTemporaryPrivateFile(
  targetPath: string,
  contents: string,
): Promise<string> {
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporaryPath, PRIVATE_FILE_MODE);
  return temporaryPath;
}

export async function createPrivateFileExclusive(
  path: string,
  contents: string,
): Promise<boolean> {
  await ensurePrivateDirectory(dirname(path));
  const temporaryPath = await writeTemporaryPrivateFile(path, contents);
  try {
    try {
      await link(temporaryPath, path);
    } catch (error: unknown) {
      if (hasCode(error, "EEXIST")) {
        return false;
      }
      throw error;
    }
    await chmod(path, PRIVATE_FILE_MODE);
    return true;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function replacePrivateFile(
  path: string,
  contents: string,
): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const temporaryPath = await writeTemporaryPrivateFile(path, contents);
  try {
    await rename(temporaryPath, path);
    await chmod(path, PRIVATE_FILE_MODE);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function readPrivateTextFile(path: string): Promise<string> {
  const information = await lstat(path);
  if (!information.isFile() || information.isSymbolicLink()) {
    throw new Error(`Sensitive path is not a regular file: ${path}`);
  }
  if (information.size > MAX_PRIVATE_TEXT_BYTES) {
    throw new Error(
      `Sensitive file exceeds ${MAX_PRIVATE_TEXT_BYTES} bytes: ${path}`,
    );
  }
  await chmod(path, PRIVATE_FILE_MODE);
  return readFile(path, "utf8");
}

export function isMissingFileError(error: unknown): boolean {
  return hasCode(error, "ENOENT");
}
