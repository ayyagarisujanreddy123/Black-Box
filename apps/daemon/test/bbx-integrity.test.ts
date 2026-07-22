import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BbxArchiveIntegrityError,
  BbxArchiveSizeError,
  readBbxArchiveFile,
} from "../src/index.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "blackbox-bbx-read-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("bounded BBX file reads", () => {
  it("reads through one descriptor and enforces the byte limit", async () => {
    const root = await temporaryRoot();
    const exactPath = join(root, "exact.bbx");
    const oversizedPath = join(root, "oversized.bbx");
    await writeFile(exactPath, "12345678");
    await writeFile(oversizedPath, "123456789");

    expect(Buffer.from(await readBbxArchiveFile(exactPath, 8)).toString()).toBe(
      "12345678",
    );
    await expect(readBbxArchiveFile(oversizedPath, 8)).rejects.toBeInstanceOf(
      BbxArchiveSizeError,
    );
  });

  it("rejects a non-file descriptor", async () => {
    const root = await temporaryRoot();

    await expect(readBbxArchiveFile(root, 8)).rejects.toBeInstanceOf(
      BbxArchiveIntegrityError,
    );
  });
});
