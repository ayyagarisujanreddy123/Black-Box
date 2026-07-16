import { spawn } from "node:child_process";
import { chmod, open } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { ResolvedStartConfiguration } from "./configuration.js";

export type DaemonLauncher = (
  configuration: ResolvedStartConfiguration,
) => Promise<number>;

export function daemonWorkerArguments(
  configuration: ResolvedStartConfiguration,
): string[] {
  const { paths, proxy } = configuration;
  return [
    "--home",
    paths.homeDirectory,
    "--upstream",
    proxy.upstream.origin,
    "--proxy-host",
    proxy.listenHost,
    "--proxy-port",
    String(proxy.listenPort),
    "--control-host",
    configuration.controlHost,
    "--control-port",
    String(configuration.controlPort),
    "--capture-queue-max-bytes",
    String(proxy.captureQueueMaxBytes),
    "--max-request-body-bytes",
    String(proxy.maxRequestBodyBytes),
    "--max-response-body-bytes",
    String(proxy.maxResponseBodyBytes),
    "--max-chunk-manifest-entries",
    String(proxy.maxChunkManifestEntries),
    "--shutdown-grace-ms",
    String(configuration.shutdownGraceMilliseconds),
    ...(proxy.allowNonLoopback ? ["--allow-non-loopback"] : []),
    ...(proxy.upstreamTimeoutMs === undefined
      ? []
      : ["--upstream-timeout-ms", String(proxy.upstreamTimeoutMs)]),
  ];
}

function daemonEnvironment(): NodeJS.ProcessEnv {
  const names = [
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "WINDIR",
    "LANG",
    "LC_ALL",
    "TZ",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ];
  const environment: NodeJS.ProcessEnv = { BLACKBOX_DAEMON_CHILD: "1" };
  for (const name of names) {
    if (process.env[name] !== undefined) {
      environment[name] = process.env[name];
    }
  }
  return environment;
}

export const launchDaemonProcess: DaemonLauncher = async (configuration) => {
  const logHandle = await open(configuration.paths.logPath, "a", 0o600);
  await chmod(configuration.paths.logPath, 0o600);
  try {
    const workerPath = fileURLToPath(
      new URL("./daemon-worker.js", import.meta.url),
    );
    const child = spawn(
      process.execPath,
      [workerPath, ...daemonWorkerArguments(configuration)],
      {
        cwd: configuration.paths.homeDirectory,
        detached: true,
        env: daemonEnvironment(),
        stdio: ["ignore", logHandle.fd, logHandle.fd],
        windowsHide: true,
      },
    );
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      child.once("error", onError);
      setImmediate(() => {
        child.off("error", onError);
        resolve();
      });
    });
    if (child.pid === undefined) {
      throw new Error("Daemon child did not receive a process ID.");
    }
    child.unref();
    return child.pid;
  } finally {
    await logHandle.close();
  }
};
