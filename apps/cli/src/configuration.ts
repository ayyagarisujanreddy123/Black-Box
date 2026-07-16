import {
  DEFAULT_UPSTREAM_ORIGIN,
  isLoopbackHost,
  resolveDaemonPaths,
  resolveProxyConfiguration,
  type DaemonPaths,
  type ProxyConfiguration,
} from "@blackbox/daemon";

export type CliCommand = "init" | "start" | "stop" | "status" | "doctor";

export interface ParsedCliArguments {
  readonly command?: CliCommand;
  readonly help: boolean;
  readonly flags: ReadonlyMap<string, string | true>;
}

export interface ResolvedStartConfiguration {
  readonly paths: DaemonPaths;
  readonly proxy: ProxyConfiguration;
  readonly controlHost: string;
  readonly controlPort: number;
  readonly shutdownGraceMilliseconds: number;
  readonly readinessTimeoutMilliseconds: number;
}

const COMMANDS = new Set<CliCommand>([
  "init",
  "start",
  "stop",
  "status",
  "doctor",
]);

const VALUE_FLAGS = new Set([
  "home",
  "upstream",
  "proxy-host",
  "proxy-port",
  "control-host",
  "control-port",
  "capture-queue-max-bytes",
  "max-request-body-bytes",
  "max-response-body-bytes",
  "max-chunk-manifest-entries",
  "upstream-timeout-ms",
  "shutdown-grace-ms",
  "timeout-ms",
]);

const BOOLEAN_FLAGS = new Set(["allow-non-loopback", "json", "websocket"]);

const ALLOWED_FLAGS: Record<CliCommand, ReadonlySet<string>> = {
  init: new Set(["home"]),
  start: new Set([
    "home",
    "upstream",
    "proxy-host",
    "proxy-port",
    "control-host",
    "control-port",
    "capture-queue-max-bytes",
    "max-request-body-bytes",
    "max-response-body-bytes",
    "max-chunk-manifest-entries",
    "upstream-timeout-ms",
    "shutdown-grace-ms",
    "timeout-ms",
    "allow-non-loopback",
  ]),
  stop: new Set(["home", "timeout-ms", "json"]),
  status: new Set(["home", "timeout-ms", "json"]),
  doctor: new Set([
    "home",
    "upstream",
    "proxy-host",
    "proxy-port",
    "control-host",
    "control-port",
    "capture-queue-max-bytes",
    "max-request-body-bytes",
    "max-response-body-bytes",
    "max-chunk-manifest-entries",
    "upstream-timeout-ms",
    "allow-non-loopback",
    "json",
    "websocket",
  ]),
};

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export function parseCliArguments(
  arguments_: readonly string[],
): ParsedCliArguments {
  if (
    arguments_.length === 0 ||
    arguments_[0] === "--help" ||
    arguments_[0] === "-h"
  ) {
    return { help: true, flags: new Map() };
  }

  const commandValue = arguments_[0];
  if (!COMMANDS.has(commandValue as CliCommand)) {
    throw new CliUsageError(`Unknown command '${commandValue}'.`);
  }
  const command = commandValue as CliCommand;
  const flags = new Map<string, string | true>();
  let help = false;

  for (let index = 1; index < arguments_.length; index += 1) {
    const token = arguments_[index] as string;
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (!token.startsWith("--")) {
      throw new CliUsageError(`Unexpected positional argument '${token}'.`);
    }
    const equals = token.indexOf("=");
    const name = token.slice(2, equals === -1 ? undefined : equals);
    if (flags.has(name)) {
      throw new CliUsageError(`Flag --${name} may only be provided once.`);
    }
    if (BOOLEAN_FLAGS.has(name)) {
      if (equals !== -1) {
        throw new CliUsageError(`Flag --${name} does not take a value.`);
      }
      flags.set(name, true);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
      throw new CliUsageError(`Unknown flag --${name}.`);
    }
    const value =
      equals === -1 ? arguments_[index + 1] : token.slice(equals + 1);
    if (
      value === undefined ||
      value.length === 0 ||
      (equals === -1 && value.startsWith("--"))
    ) {
      throw new CliUsageError(`Flag --${name} requires a value.`);
    }
    if (equals === -1) {
      index += 1;
    }
    flags.set(name, value);
  }

  for (const name of flags.keys()) {
    if (!ALLOWED_FLAGS[command].has(name)) {
      throw new CliUsageError(`Flag --${name} is not valid for ${command}.`);
    }
  }
  return { command, help, flags };
}

export function stringFlag(
  flags: ReadonlyMap<string, string | true>,
  name: string,
): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function integerFlag(
  flags: ReadonlyMap<string, string | true>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = stringFlag(flags, name);
  if (raw === undefined) {
    return fallback;
  }
  if (!/^\d+$/u.test(raw)) {
    throw new CliUsageError(`Flag --${name} must be an integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CliUsageError(
      `Flag --${name} must be between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

export function pathsFromFlags(
  flags: ReadonlyMap<string, string | true>,
): DaemonPaths {
  return resolveDaemonPaths(stringFlag(flags, "home"));
}

export function resolveStartConfiguration(
  flags: ReadonlyMap<string, string | true>,
  environment: NodeJS.ProcessEnv = process.env,
): ResolvedStartConfiguration {
  const paths = pathsFromFlags(flags);
  const proxy = resolveProxyConfiguration({
    upstream:
      stringFlag(flags, "upstream") ??
      environment.BLACKBOX_UPSTREAM_URL ??
      DEFAULT_UPSTREAM_ORIGIN,
    listenHost: stringFlag(flags, "proxy-host") ?? "127.0.0.1",
    listenPort: integerFlag(flags, "proxy-port", 4141, 0, 65_535),
    allowNonLoopback: flags.has("allow-non-loopback"),
    captureQueueMaxBytes: integerFlag(
      flags,
      "capture-queue-max-bytes",
      96 * 1024 * 1024,
      1,
      1024 * 1024 * 1024,
    ),
    maxRequestBodyBytes: integerFlag(
      flags,
      "max-request-body-bytes",
      16 * 1024 * 1024,
      1,
      1024 * 1024 * 1024,
    ),
    maxResponseBodyBytes: integerFlag(
      flags,
      "max-response-body-bytes",
      64 * 1024 * 1024,
      1,
      1024 * 1024 * 1024,
    ),
    maxChunkManifestEntries: integerFlag(
      flags,
      "max-chunk-manifest-entries",
      100_000,
      1,
      1_000_000,
    ),
    ...(stringFlag(flags, "upstream-timeout-ms") === undefined
      ? {}
      : {
          upstreamTimeoutMs: integerFlag(
            flags,
            "upstream-timeout-ms",
            1,
            1,
            24 * 60 * 60 * 1000,
          ),
        }),
  });
  const controlHost = stringFlag(flags, "control-host") ?? "127.0.0.1";
  if (!isLoopbackHost(controlHost)) {
    throw new CliUsageError("The control API host must be loopback.");
  }
  return {
    paths,
    proxy,
    controlHost,
    controlPort: integerFlag(flags, "control-port", 4142, 0, 65_535),
    shutdownGraceMilliseconds: integerFlag(
      flags,
      "shutdown-grace-ms",
      5_000,
      1,
      60_000,
    ),
    readinessTimeoutMilliseconds: integerFlag(
      flags,
      "timeout-ms",
      10_000,
      100,
      120_000,
    ),
  };
}
