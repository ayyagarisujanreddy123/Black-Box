import { createServer, type Server } from "node:http";
import { EventEmitter } from "node:events";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BlackBoxDaemon,
  readControlToken,
  resolveDaemonPaths,
  type DaemonPaths,
} from "@blackbox/daemon";
import { openBlackBoxStorage } from "@blackbox/storage";
import { afterEach, describe, expect, it } from "vitest";

import {
  UnsafeControlOriginError,
  createViewerUrl,
  parseCliArguments,
  requestDaemonStatus,
  resolveStartConfiguration,
  runCli,
  type CliOutput,
  type CliRuntime,
  type ResolvedStartConfiguration,
  type SignalEventSource,
} from "../src/index.js";

class CapturedOutput implements CliOutput {
  value = "";

  write(value: string | Uint8Array): void {
    this.value +=
      typeof value === "string" ? value : Buffer.from(value).toString("utf8");
  }

  clear(): void {
    this.value = "";
  }
}

const roots: string[] = [];
const daemons: BlackBoxDaemon[] = [];
const servers: Server[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "blackbox-cli-test-"));
  roots.push(root);
  return root;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  servers.push(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function upstream(): Promise<string> {
  return listen(
    createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"upstream":true}');
    }),
  );
}

async function eventually(
  predicate: () => boolean | Promise<boolean>,
  timeoutMilliseconds = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("Condition was not satisfied before timeout.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function runtime(
  stdout: CapturedOutput,
  stderr: CapturedOutput,
  launchDaemon?: (configuration: ResolvedStartConfiguration) => Promise<number>,
): Partial<CliRuntime> {
  return {
    stdout,
    stderr,
    environment: {},
    ...(launchDaemon === undefined ? {} : { launchDaemon }),
  };
}

afterEach(async () => {
  for (const daemon of daemons.splice(0)) {
    await daemon.stop().catch(() => undefined);
  }
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("CLI initialization and configuration", () => {
  it("initializes private storage idempotently without printing the token", async () => {
    const root = await temporaryRoot();
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();
    const paths = resolveDaemonPaths(root);

    expect(
      await runCli(["init", "--home", root], runtime(stdout, stderr)),
    ).toBe(0);
    const token = await readControlToken(paths.tokenPath);
    expect(
      await runCli(["init", "--home", root], runtime(stdout, stderr)),
    ).toBe(0);

    expect(stdout.value).not.toContain(token);
    expect(stderr.value).toBe("");
    expect((await stat(paths.homeDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.tokenPath)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.databasePath)).mode & 0o777).toBe(0o600);
  });

  it("uses BLACKBOX_UPSTREAM_URL but never reuses OPENAI_BASE_URL", () => {
    const parsed = parseCliArguments(["start", "--proxy-port", "0"]);
    const ignored = resolveStartConfiguration(parsed.flags, {
      OPENAI_BASE_URL: "http://127.0.0.1:9",
    });
    const selected = resolveStartConfiguration(parsed.flags, {
      BLACKBOX_UPSTREAM_URL: "http://127.0.0.1:8080",
      OPENAI_BASE_URL: "http://127.0.0.1:9",
    });

    expect(ignored.proxy.upstream.origin).toBe("https://api.openai.com");
    expect(selected.proxy.upstream.origin).toBe("http://127.0.0.1:8080");
  });

  it("returns a usage error for unknown flags", async () => {
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();

    expect(await runCli(["start", "--mystery"], runtime(stdout, stderr))).toBe(
      2,
    );
    expect(stderr.value).toContain("Unknown flag --mystery");
    expect(stderr.value).toContain("blackbox --help");
  });
});

describe("CLI daemon lifecycle", () => {
  it("starts idempotently, reports status, and stops through authenticated control", async () => {
    const root = await temporaryRoot();
    const upstreamOrigin = await upstream();
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();
    let launches = 0;
    const launch = async (configuration: ResolvedStartConfiguration) => {
      launches += 1;
      const daemon = new BlackBoxDaemon({
        homeDirectory: configuration.paths.homeDirectory,
        proxy: {
          ...configuration.proxy,
          upstream: configuration.proxy.upstream,
        },
        control: {
          listenHost: configuration.controlHost,
          listenPort: configuration.controlPort,
        },
        shutdownGraceMilliseconds: 100,
      });
      daemons.push(daemon);
      await daemon.start();
      return process.pid;
    };
    const cliRuntime = runtime(stdout, stderr, launch);
    const startArguments = [
      "start",
      "--home",
      root,
      "--upstream",
      upstreamOrigin,
      "--proxy-port",
      "0",
      "--control-port",
      "0",
    ];

    expect(await runCli(startArguments, cliRuntime)).toBe(0);
    expect(await runCli(startArguments, cliRuntime)).toBe(0);
    expect(launches).toBe(1);
    expect(stdout.value).toContain("OPENAI_BASE_URL=http://127.0.0.1:");
    const token = await readControlToken(resolveDaemonPaths(root).tokenPath);
    expect(stdout.value).not.toContain(token);

    stdout.clear();
    expect(await runCli(["status", "--home", root, "--json"], cliRuntime)).toBe(
      0,
    );
    expect(JSON.parse(stdout.value)).toMatchObject({
      state: "ready",
      proxy: { status: "healthy" },
    });
    expect(stdout.value).not.toContain(token);

    stdout.clear();
    expect(await runCli(["stop", "--home", root], cliRuntime)).toBe(0);
    expect(stdout.value).toContain("daemon stopped");
    stdout.clear();
    expect(await runCli(["status", "--home", root, "--json"], cliRuntime)).toBe(
      1,
    );
    expect(JSON.parse(stdout.value)).toEqual({ state: "stopped" });
    expect(stderr.value).toBe("");
  });

  it("recovers a corrupt lock during an idempotent stop", async () => {
    const root = await temporaryRoot();
    const paths = resolveDaemonPaths(root);
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();
    await writeFile(paths.lockPath, "{corrupt", { mode: 0o600 });

    expect(
      await runCli(["stop", "--home", root], runtime(stdout, stderr)),
    ).toBe(0);
    expect(stdout.value).toContain("removed corrupt lock");
    await expect(readFile(paths.lockPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("will not send a token to a non-loopback lock endpoint", async () => {
    const root = await temporaryRoot();
    const paths: DaemonPaths = resolveDaemonPaths(root);

    await expect(
      requestDaemonStatus(
        {
          schemaVersion: 1,
          instanceId: "daemon-hostile-lock",
          pid: process.pid,
          startedAt: "2026-07-16T12:00:00.000Z",
          updatedAt: "2026-07-16T12:00:00.000Z",
          state: "ready",
          proxyOrigin: "http://127.0.0.1:4141",
          controlOrigin: "https://attacker.example",
        },
        paths,
      ),
    ).rejects.toBeInstanceOf(UnsafeControlOriginError);
  });

  it("runs a child in one proxy/process session and returns its exit code", async () => {
    const root = await temporaryRoot();
    const workspace = await temporaryRoot();
    const upstreamOrigin = await upstream();
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();
    const launch = async (configuration: ResolvedStartConfiguration) => {
      const daemon = new BlackBoxDaemon({
        homeDirectory: configuration.paths.homeDirectory,
        proxy: {
          ...configuration.proxy,
          upstream: configuration.proxy.upstream,
        },
        control: {
          listenHost: configuration.controlHost,
          listenPort: configuration.controlPort,
        },
        shutdownGraceMilliseconds: 100,
      });
      daemons.push(daemon);
      await daemon.start();
      return process.pid;
    };
    const script = `
      (async () => {
        const response = await fetch(process.env.OPENAI_BASE_URL + "/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "fixture", input: "wrapped" })
        });
        const body = await response.text();
        require("node:fs").writeFileSync("agent-output.txt", "created by child\\n");
        process.stdout.write(JSON.stringify({
          base: process.env.OPENAI_BASE_URL,
          session: process.env.BLACKBOX_SESSION_ID,
          status: response.status,
          body
        }));
        process.stderr.write("child-stderr\\n");
        process.exitCode = 7;
      })().catch((error) => {
        process.stderr.write(String(error));
        process.exitCode = 99;
      });
    `;

    const exitCode = await runCli(
      [
        "run",
        "--home",
        root,
        "--upstream",
        upstreamOrigin,
        "--proxy-port",
        "0",
        "--control-port",
        "0",
        "--cwd",
        workspace,
        "--",
        process.execPath,
        "-e",
        script,
      ],
      runtime(stdout, stderr, launch),
    );

    expect(exitCode).toBe(7);
    const childOutput = JSON.parse(stdout.value) as {
      base: string;
      session: string;
      status: number;
      body: string;
    };
    expect(childOutput).toMatchObject({
      status: 200,
      body: '{"upstream":true}',
    });
    expect(childOutput.base).toContain("/.blackbox/session/");
    expect(childOutput.base).toMatch(/\/v1$/u);
    expect(stderr.value).toBe("child-stderr\n");

    const paths = resolveDaemonPaths(root);
    const storage = await openBlackBoxStorage({
      databasePath: paths.databasePath,
      dataDirectory: paths.dataDirectory,
      recoverIncompleteExchanges: false,
    });
    try {
      await eventually(() => {
        const session = storage.sessions.get(childOutput.session);
        return (
          session?.status === "completed" &&
          storage.events
            .list(childOutput.session)
            .events.some((event) => event.type === "model.response.completed")
        );
      });
      const session = storage.sessions.getRequired(childOutput.session);
      const events = storage.events.list(childOutput.session).events;
      expect(session).toMatchObject({
        captureLevel: "wrapped-process",
        status: "completed",
        command: { executable: process.execPath, cwd: workspace },
        repoRoot: await realpath(workspace),
      });
      expect(events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "session.started",
          "process.started",
          "process.stdout",
          "process.stderr",
          "process.exited",
          "session.ended",
          "model.response.completed",
          "workspace.snapshot",
          "file.create",
        ]),
      );
      expect(
        events.some(
          (event) =>
            event.type === "file.create" &&
            event.summary.timingPrecision === "approximate-watcher",
        ),
      ).toBe(true);
      const fileEvent = events.find(
        (event) =>
          event.type === "file.create" &&
          event.summary.timingPrecision === "exact-final-diff",
      );
      expect(fileEvent).toMatchObject({
        source: "filesystem",
        summary: {
          path: "agent-output.txt",
          operation: "create",
          payloadKind: "file-delta",
        },
      });
      expect(
        storage.fileChanges.getByEvent(fileEvent?.id as string),
      ).toMatchObject({
        path: "agent-output.txt",
        operation: "create",
        patchBlobId: fileEvent?.payloadRef?.id,
      });
      const rawRow = storage.unsafeDatabase
        .prepare("SELECT id FROM raw_exchanges WHERE session_id = ?")
        .get(childOutput.session) as { id: string };
      expect(storage.rawExchanges.getRequired(rawRow.id).path).toBe(
        "/v1/responses",
      );
    } finally {
      storage.close();
    }
  });

  it("forwards Ctrl-C and preserves the child's final filesystem effect", async () => {
    const root = await temporaryRoot();
    const workspace = await temporaryRoot();
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();
    const signalSource = new EventEmitter();
    const launch = async (configuration: ResolvedStartConfiguration) => {
      const daemon = new BlackBoxDaemon({
        homeDirectory: configuration.paths.homeDirectory,
        proxy: configuration.proxy,
        control: {
          listenHost: configuration.controlHost,
          listenPort: configuration.controlPort,
        },
        shutdownGraceMilliseconds: 100,
      });
      daemons.push(daemon);
      await daemon.start();
      return process.pid;
    };
    const script = `
      const fs = require("node:fs");
      process.on("SIGINT", () => {
        fs.writeFileSync("signal-result.txt", "signal forwarded\\n");
        process.exit(42);
      });
      process.stdout.write("ready\\n");
      setInterval(() => undefined, 1000);
    `;

    const running = runCli(
      [
        "run",
        "--home",
        root,
        "--proxy-port",
        "0",
        "--control-port",
        "0",
        "--cwd",
        workspace,
        "--watcher-debounce-ms",
        "10",
        "--cleanup-timeout-ms",
        "2000",
        "--",
        process.execPath,
        "-e",
        script,
      ],
      {
        ...runtime(stdout, stderr, launch),
        signalSource: signalSource as SignalEventSource,
      },
    );
    await eventually(() => stdout.value.includes("ready\n"));
    signalSource.emit("SIGINT");

    expect(await running).toBe(42);
    expect(stderr.value).toBe("");
    expect(signalSource.listenerCount("SIGINT")).toBe(0);
    expect(signalSource.listenerCount("SIGTERM")).toBe(0);

    const paths = resolveDaemonPaths(root);
    const storage = await openBlackBoxStorage({
      databasePath: paths.databasePath,
      dataDirectory: paths.dataDirectory,
      recoverIncompleteExchanges: false,
    });
    try {
      const session = storage.sessions.list(1)[0];
      expect(session).toMatchObject({
        status: "completed",
        repoRoot: await realpath(workspace),
      });
      const events = storage.events.list(session?.id as string).events;
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "process.exited",
            summary: expect.objectContaining({ exitCode: 42 }),
          }),
          expect.objectContaining({
            type: "file.create",
            summary: expect.objectContaining({
              path: "signal-result.txt",
              timingPrecision: "exact-final-diff",
            }),
          }),
          expect.objectContaining({ type: "workspace.snapshot" }),
        ]),
      );
    } finally {
      storage.close();
    }
  });
});

describe("CLI cockpit opening", () => {
  it("starts the daemon and opens a selected session through a fragment credential", async () => {
    const root = await temporaryRoot();
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();
    const paths = resolveDaemonPaths(root);
    const opened: URL[] = [];
    let launches = 0;
    const launch = async (configuration: ResolvedStartConfiguration) => {
      launches += 1;
      const daemon = new BlackBoxDaemon({
        homeDirectory: configuration.paths.homeDirectory,
        proxy: configuration.proxy,
        control: {
          listenHost: configuration.controlHost,
          listenPort: configuration.controlPort,
        },
        shutdownGraceMilliseconds: 100,
      });
      daemons.push(daemon);
      await daemon.start();
      return process.pid;
    };
    const cliRuntime: Partial<CliRuntime> = {
      ...runtime(stdout, stderr, launch),
      openBrowser: (url) => {
        opened.push(new URL(url));
        return Promise.resolve();
      },
    };

    expect(await runCli(["init", "--home", root], cliRuntime)).toBe(0);
    const storage = await openBlackBoxStorage({
      databasePath: paths.databasePath,
      dataDirectory: paths.dataDirectory,
      recoverIncompleteExchanges: false,
    });
    try {
      storage.sessions.create({
        schemaVersion: 1,
        id: "session-cockpit",
        startedAt: "2026-07-16T12:00:00.000Z",
        status: "active",
        captureLevel: "api",
        models: [],
        tags: [],
        counts: {
          events: 0,
          errors: 0,
          inputTokens: null,
          outputTokens: null,
        },
        metadata: {},
      });
    } finally {
      storage.close();
    }

    stdout.clear();
    expect(
      await runCli(["open", "missing-session", "--home", root], cliRuntime),
    ).toBe(1);
    expect(launches).toBe(0);
    expect(opened).toHaveLength(0);
    expect(stderr.value).toContain("Session missing-session does not exist");

    stdout.clear();
    stderr.clear();
    expect(
      await runCli(
        [
          "open",
          "session-cockpit",
          "--home",
          root,
          "--proxy-port",
          "0",
          "--control-port",
          "0",
        ],
        cliRuntime,
      ),
    ).toBe(0);
    expect(launches).toBe(1);

    const token = await readControlToken(paths.tokenPath);
    const url = opened[0];
    expect(url?.origin).toBe(daemons[0]?.status().controlOrigin);
    expect(url?.pathname).toBe("/");
    expect(url?.search).toBe("");
    expect(new URLSearchParams(url?.hash.slice(1))).toEqual(
      new URLSearchParams({ token, session: "session-cockpit" }),
    );
    expect(stdout.value).toBe(
      "Opened Black Box cockpit for session session-cockpit.\n",
    );
    expect(stdout.value).not.toContain(token);
    expect(stderr.value).toBe("");
  });

  it("refuses to place a control token in a non-loopback viewer URL", () => {
    expect(() =>
      createViewerUrl("https://attacker.example", "a".repeat(43)),
    ).toThrow("Refusing to open a non-loopback Black Box control origin");
  });
});

describe("CLI canonical inspection", () => {
  it("lists user sessions and emits canonical event JSON", async () => {
    const root = await temporaryRoot();
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();
    const cliRuntime = runtime(stdout, stderr);
    const paths = resolveDaemonPaths(root);
    const startedAt = "2026-07-16T12:00:00.000Z";

    expect(await runCli(["init", "--home", root], cliRuntime)).toBe(0);
    const storage = await openBlackBoxStorage({
      databasePath: paths.databasePath,
      dataDirectory: paths.dataDirectory,
      recoverIncompleteExchanges: false,
    });
    try {
      for (const [id, internalAnalysis] of [
        ["session-visible", false],
        ["session-internal", true],
      ] as const) {
        storage.sessions.create({
          schemaVersion: 1,
          id,
          startedAt,
          status: "active",
          captureLevel: "api",
          models: [],
          tags: internalAnalysis ? ["internal-analysis"] : [],
          counts: {
            events: 0,
            errors: 0,
            inputTokens: null,
            outputTokens: null,
          },
          metadata: { internalAnalysis },
        });
      }
      storage.events.insert({
        schemaVersion: 1,
        id: "event-visible-1",
        sessionId: "session-visible",
        sequence: 1,
        occurredAt: startedAt,
        observedAt: startedAt,
        source: "proxy",
        type: "message.assistant",
        evidence: "observed",
        summary: { text: "inspectable" },
        redaction: { applied: false, ruleIds: [] },
      });
      storage.events.insert({
        schemaVersion: 1,
        id: "event-visible-2",
        sessionId: "session-visible",
        sequence: 2,
        occurredAt: startedAt,
        observedAt: startedAt,
        source: "proxy",
        type: "tool.call",
        evidence: "observed",
        summary: { name: "inspect" },
        redaction: { applied: false, ruleIds: [] },
      });
    } finally {
      storage.close();
    }

    stdout.clear();
    expect(
      await runCli(["sessions", "--home", root, "--json"], cliRuntime),
    ).toBe(0);
    expect(
      (JSON.parse(stdout.value) as { id: string }[]).map(
        (session) => session.id,
      ),
    ).toEqual(["session-visible"]);

    stdout.clear();
    expect(
      await runCli(
        ["sessions", "--home", root, "--include-internal", "--json"],
        cliRuntime,
      ),
    ).toBe(0);
    expect(JSON.parse(stdout.value)).toHaveLength(2);

    stdout.clear();
    expect(
      await runCli(
        ["inspect", "session-visible", "--home", root, "--json"],
        cliRuntime,
      ),
    ).toBe(0);
    const inspection = JSON.parse(stdout.value) as {
      session: { id: string };
      events: { id: string; type: string; summary: unknown }[];
    };
    expect(inspection.session.id).toBe("session-visible");
    expect(inspection.events).toEqual([
      expect.objectContaining({
        id: "event-visible-1",
        type: "message.assistant",
        summary: { text: "inspectable" },
      }),
      expect.objectContaining({ id: "event-visible-2", type: "tool.call" }),
    ]);

    stdout.clear();
    expect(
      await runCli(
        [
          "inspect",
          "session-visible",
          "--home",
          root,
          "--limit",
          "1",
          "--json",
        ],
        cliRuntime,
      ),
    ).toBe(0);
    const firstPage = JSON.parse(stdout.value) as {
      events: { id: string }[];
      nextCursor: string;
    };
    stdout.clear();
    expect(
      await runCli(
        [
          "inspect",
          "session-visible",
          "--home",
          root,
          "--limit",
          "1",
          "--cursor",
          firstPage.nextCursor,
          "--json",
        ],
        cliRuntime,
      ),
    ).toBe(0);
    expect(firstPage.events.map((event) => event.id)).toEqual([
      "event-visible-1",
    ]);
    expect(
      (JSON.parse(stdout.value) as { events: { id: string }[] }).events.map(
        (event) => event.id,
      ),
    ).toEqual(["event-visible-2"]);
    expect(stderr.value).toBe("");
  });

  it("validates inspect positional arguments", async () => {
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();

    expect(await runCli(["inspect"], runtime(stdout, stderr))).toBe(2);
    expect(stderr.value).toContain("requires exactly one session ID");
  });
});

describe("CLI doctor", () => {
  it("reports port conflicts, reachability, storage, limits, and WebSocket support", async () => {
    const root = await temporaryRoot();
    const upstreamOrigin = await upstream();
    const occupiedOrigin = await listen(createServer());
    const occupiedPort = new URL(occupiedOrigin).port;
    const stdout = new CapturedOutput();
    const stderr = new CapturedOutput();
    const cliRuntime = runtime(stdout, stderr);

    expect(await runCli(["init", "--home", root], cliRuntime)).toBe(0);
    stdout.clear();
    expect(
      await runCli(
        [
          "doctor",
          "--home",
          root,
          "--upstream",
          upstreamOrigin,
          "--proxy-port",
          occupiedPort,
          "--control-port",
          "0",
          "--json",
        ],
        cliRuntime,
      ),
    ).toBe(1);
    const conflicted = JSON.parse(stdout.value) as {
      checks: { id: string; status: string }[];
    };
    expect(conflicted.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "storage", status: "pass" }),
        expect.objectContaining({ id: "upstream", status: "pass" }),
        expect.objectContaining({ id: "proxy-port", status: "fail" }),
        expect.objectContaining({ id: "capture-limits", status: "pass" }),
        expect.objectContaining({
          id: "websocket-transport",
          status: "warn",
        }),
      ]),
    );

    const occupied = servers.pop();
    await new Promise<void>((resolve) => occupied?.close(() => resolve()));
    stdout.clear();
    expect(
      await runCli(
        [
          "doctor",
          "--home",
          root,
          "--upstream",
          upstreamOrigin,
          "--proxy-port",
          occupiedPort,
          "--control-port",
          "0",
          "--json",
        ],
        cliRuntime,
      ),
    ).toBe(0);
    expect(
      (JSON.parse(stdout.value) as { checks: { id: string; status: string }[] })
        .checks,
    ).toContainEqual(
      expect.objectContaining({ id: "websocket-transport", status: "warn" }),
    );

    stdout.clear();
    expect(
      await runCli(
        [
          "doctor",
          "--home",
          root,
          "--upstream",
          upstreamOrigin,
          "--proxy-port",
          occupiedPort,
          "--control-port",
          "0",
          "--websocket",
          "--json",
        ],
        cliRuntime,
      ),
    ).toBe(1);
    const websocket = JSON.parse(stdout.value) as {
      checks: { id: string; status: string }[];
    };
    expect(websocket.checks).toContainEqual(
      expect.objectContaining({ id: "websocket-transport", status: "fail" }),
    );
    expect(stderr.value).toBe("");
  });
});
