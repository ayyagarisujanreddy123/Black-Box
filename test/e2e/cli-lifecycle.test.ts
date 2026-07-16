import { execFile } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { openBlackBoxStorage } from "@blackbox/storage";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const cliPath = fileURLToPath(
  new URL("../../apps/cli/dist/bin.js", import.meta.url),
);

interface HttpResult {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
}

async function runCli(
  arguments_: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  const result = await execute(process.execPath, [cliPath, ...arguments_], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENAI_API_KEY: "sk-environment-must-not-reach-daemon",
    },
    maxBuffer: 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function requestBytes(
  origin: string,
  body: Buffer,
  secret: string,
  cookie: string,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      new URL("/v1/responses", origin),
      {
        method: "POST",
        headers: {
          authorization: secret,
          cookie,
          "content-type": "application/json",
          "content-length": body.length,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on("error", reject);
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

async function eventuallyStopped(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Detached daemon PID ${pid} did not exit.`);
}

it("runs the packaged CLI and detached recorder end to end", async () => {
  const root = await mkdtemp(join(tmpdir(), "blackbox-packaged-e2e-"));
  const observations: {
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
  }[] = [];
  const upstream = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      observations.push({ headers: request.headers, body });
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "set-cookie": "provider=e2e; HttpOnly",
        "x-e2e-upstream": "packaged",
      });
      response.write("fixture:");
      setImmediate(() => response.end(body));
    });
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", () => resolve());
  });
  const upstreamAddress = upstream.address() as AddressInfo;
  const upstreamOrigin = `http://127.0.0.1:${upstreamAddress.port}`;
  let startAttempted = false;

  try {
    const initialized = await runCli(["init", "--home", root]);
    expect(initialized.stderr).toBe("");
    const token = (await readFile(join(root, "control.token"), "utf8")).trim();
    expect(initialized.stdout).not.toContain(token);

    startAttempted = true;
    const started = await runCli([
      "start",
      "--home",
      root,
      "--upstream",
      upstreamOrigin,
      "--proxy-port",
      "0",
      "--control-port",
      "0",
    ]);
    expect(started.stderr).toBe("");
    expect(started.stdout).not.toContain(token);

    const statusResult = await runCli(["status", "--home", root, "--json"]);
    const status = JSON.parse(statusResult.stdout) as {
      pid: number;
      state: string;
      proxyOrigin: string;
      proxy: { requestsCompleted: number };
    };
    expect(status).toMatchObject({
      state: "ready",
      proxy: { requestsCompleted: 0 },
    });

    const body = Buffer.from('{"input":"packaged-e2e"}', "utf8");
    const secret = "Bearer sk-packaged-e2e-never-persist";
    const cookie = "session=packaged-e2e-never-persist";
    const direct = await requestBytes(upstreamOrigin, body, secret, cookie);
    const recorded = await requestBytes(
      status.proxyOrigin,
      body,
      secret,
      cookie,
    );
    expect(recorded.status).toBe(direct.status);
    expect(recorded.body).toEqual(direct.body);
    expect(recorded.headers["x-e2e-upstream"]).toBe("packaged");
    expect(recorded.headers["set-cookie"]).toEqual(["provider=e2e; HttpOnly"]);
    expect(observations.at(-1)?.headers.authorization).toBe(secret);
    expect(observations.at(-1)?.headers.cookie).toBe(cookie);

    const doctor = await runCli([
      "doctor",
      "--home",
      root,
      "--upstream",
      upstreamOrigin,
      "--proxy-port",
      "0",
      "--control-port",
      "0",
      "--json",
    ]);
    const doctorReport = JSON.parse(doctor.stdout) as {
      ok: boolean;
      checks: { id: string; status: string }[];
    };
    expect(doctorReport.ok).toBe(true);
    expect(doctorReport.checks).toContainEqual(
      expect.objectContaining({ id: "websocket-transport", status: "warn" }),
    );

    const afterRequest = JSON.parse(
      (await runCli(["status", "--home", root, "--json"])).stdout,
    ) as { proxy: { requestsCompleted: number } };
    expect(afterRequest.proxy.requestsCompleted).toBe(1);

    const stopped = await runCli(["stop", "--home", root]);
    expect(stopped.stderr).toBe("");
    expect(stopped.stdout).toContain("daemon stopped");
    await eventuallyStopped(status.pid);
    await expect(stat(join(root, "daemon.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const storage = await openBlackBoxStorage({
      databasePath: join(root, "blackbox.sqlite"),
      dataDirectory: join(root, "data"),
      recoverIncompleteExchanges: false,
    });
    try {
      const row = storage.unsafeDatabase
        .prepare(
          "SELECT id FROM raw_exchanges ORDER BY created_at DESC LIMIT 1",
        )
        .get() as { id: string };
      const raw = storage.rawExchanges.getRequired(row.id);
      expect(raw.outcome).toBe("completed");
      expect(raw.requestHeaders.authorization).toBeUndefined();
      expect(raw.requestHeaders.cookie).toBeUndefined();
      expect(raw.responseHeaders?.["set-cookie"]).toBeUndefined();
      expect(
        Buffer.from(await storage.blobs.get(raw.requestBodyRef?.id as string)),
      ).toEqual(body);
      expect(
        Buffer.from(await storage.blobs.get(raw.responseBodyRef?.id as string)),
      ).toEqual(recorded.body);

      storage.checkpoint("TRUNCATE");
      const database = await readFile(storage.databasePath);
      for (const forbidden of [secret, cookie, token]) {
        expect(database.includes(Buffer.from(forbidden))).toBe(false);
      }
      const blobIds = storage.unsafeDatabase
        .prepare("SELECT id FROM blobs ORDER BY id")
        .all() as { id: string }[];
      for (const { id } of blobIds) {
        const blob = Buffer.from(await storage.blobs.get(id));
        for (const forbidden of [secret, cookie, token]) {
          expect(blob.includes(Buffer.from(forbidden))).toBe(false);
        }
      }
    } finally {
      storage.close();
    }

    const daemonLog = await readFile(join(root, "logs", "daemon.log"), "utf8");
    expect(daemonLog).not.toContain(secret);
    expect(daemonLog).not.toContain(cookie);
    expect(daemonLog).not.toContain(token);
    expect(daemonLog).not.toContain("sk-environment-must-not-reach-daemon");
  } finally {
    if (startAttempted) {
      await runCli(["stop", "--home", root, "--timeout-ms", "2000"]).catch(
        () => undefined,
      );
    }
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
