import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rename,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PROCESS_RUN_CONFIGURATION,
  WorkspaceObserver,
} from "../src/index.js";

const roots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(root: string, ...arguments_: string[]): string {
  return execFileSync("git", ["-C", root, ...arguments_], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function configuration(maxUntrackedFileBytes = 32) {
  return {
    ...DEFAULT_PROCESS_RUN_CONFIGURATION,
    excludedPathSegments: [
      ...DEFAULT_PROCESS_RUN_CONFIGURATION.excludedPathSegments,
    ],
    maxUntrackedFileBytes,
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("authoritative workspace snapshots", () => {
  it("captures Git effects without blaming unchanged pre-existing dirt", async () => {
    const root = await temporaryRoot("blackbox-git-observer-test-");
    const blackBoxDirectory = join(root, "blackbox-home");
    await mkdir(join(root, "ignored"), { recursive: true });
    await mkdir(blackBoxDirectory, { recursive: true });
    git(root, "init", "--quiet");
    git(root, "config", "user.email", "blackbox@example.test");
    git(root, "config", "user.name", "Black Box Test");
    await Promise.all([
      writeFile(join(root, ".gitignore"), "ignored/\n"),
      writeFile(join(root, "modify.txt"), "before modify\n"),
      writeFile(join(root, "delete.txt"), "deleted line\n"),
      writeFile(join(root, "rename-old.txt"), "rename identity\n"),
      writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3, 4, 5])),
      writeFile(join(root, "dirty.txt"), "committed\n"),
    ]);
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "fixture baseline");
    await writeFile(join(root, "dirty.txt"), "pre-existing dirt\n");
    await writeFile(join(blackBoxDirectory, "internal.tmp"), "baseline\n");

    const observer = await WorkspaceObserver.start({
      cwd: root,
      dataDirectory: blackBoxDirectory,
      configuration: configuration(),
    });

    await Promise.all([
      writeFile(join(root, "modify.txt"), "after modify\n"),
      unlink(join(root, "delete.txt")),
      writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 9, 3, 4, 5])),
      writeFile(join(root, "untracked.txt"), "new file\n"),
      writeFile(join(root, "large.bin"), Buffer.alloc(64, 7)),
      writeFile(join(root, "ignored", "ignored.txt"), "ignored\n"),
      writeFile(join(blackBoxDirectory, "internal.tmp"), "final\n"),
    ]);
    await rename(join(root, "rename-old.txt"), join(root, "renamed.txt"));

    const completed = await observer.complete();
    const changes = new Map(
      completed.changes.map((change) => [change.summary.path, change]),
    );

    expect(observer.baseline.summary).toMatchObject({
      kind: "git",
      phase: "baseline",
      root: await realpath(root),
    });
    expect(observer.baseline.summary.gitHead).toMatch(/^[a-f\d]{40,64}$/u);
    expect(observer.baseline.summary.statusSha256).toMatch(/^[a-f\d]{64}$/u);
    expect(completed.snapshot.summary).toMatchObject({
      kind: "git",
      phase: "final",
      changedFileCount: 6,
    });
    expect([...changes.keys()].sort()).toEqual([
      "binary.bin",
      "delete.txt",
      "large.bin",
      "modify.txt",
      "renamed.txt",
      "untracked.txt",
    ]);
    expect(changes.has("dirty.txt")).toBe(false);
    expect(changes.has("ignored/ignored.txt")).toBe(false);
    expect(changes.has("blackbox-home/internal.tmp")).toBe(false);

    expect(changes.get("renamed.txt")?.summary).toMatchObject({
      operation: "rename",
      previousPath: "rename-old.txt",
      timingPrecision: "exact-final-diff",
    });
    expect(changes.get("delete.txt")?.summary).toMatchObject({
      operation: "delete",
      payloadKind: "git-binary-patch",
    });
    expect(
      Buffer.from(changes.get("delete.txt")?.payload as Uint8Array).toString(
        "utf8",
      ),
    ).toContain("deleted line");
    expect(changes.get("binary.bin")?.summary.payloadKind).toBe(
      "git-binary-patch",
    );
    expect(
      Buffer.from(changes.get("binary.bin")?.payload as Uint8Array).toString(
        "utf8",
      ),
    ).toContain("GIT binary patch");

    const untrackedPayload = JSON.parse(
      Buffer.from(changes.get("untracked.txt")?.payload as Uint8Array).toString(
        "utf8",
      ),
    ) as { after: { content: string } };
    expect(
      Buffer.from(untrackedPayload.after.content, "base64").toString(),
    ).toBe("new file\n");
    expect(changes.get("large.bin")).toMatchObject({
      summary: {
        operation: "create",
        afterByteLength: 64,
        sensitivity: "truncated",
      },
    });
    expect(changes.get("large.bin")?.payload).toBeUndefined();
    expect(
      completed.snapshot.manifest.entries.some(
        (entry) => entry.path === "large.bin" && entry.sha256.length === 64,
      ),
    ).toBe(true);
  });

  it("uses bounded content deltas for a non-Git directory", async () => {
    const root = await temporaryRoot("blackbox-directory-observer-test-");
    await Promise.all([
      writeFile(join(root, "modify.txt"), "old\n"),
      writeFile(join(root, "delete.txt"), "remove\n"),
      writeFile(join(root, "rename.txt"), "move\n"),
    ]);
    const observer = await WorkspaceObserver.start({
      cwd: root,
      configuration: configuration(1024),
    });

    await Promise.all([
      writeFile(join(root, "modify.txt"), "new\n"),
      unlink(join(root, "delete.txt")),
      writeFile(join(root, "create.txt"), "create\n"),
    ]);
    await rename(join(root, "rename.txt"), join(root, "moved.txt"));
    const completed = await observer.complete();

    expect(observer.baseline.summary.kind).toBe("directory");
    expect(completed.changes.map((change) => change.summary)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "create.txt", operation: "create" }),
        expect.objectContaining({ path: "delete.txt", operation: "delete" }),
        expect.objectContaining({ path: "modify.txt", operation: "modify" }),
        expect.objectContaining({
          path: "moved.txt",
          previousPath: "rename.txt",
          operation: "rename",
        }),
      ]),
    );
    expect(
      completed.changes.every(
        (change) => change.summary.payloadKind === "file-delta",
      ),
    ).toBe(true);
  });
});
