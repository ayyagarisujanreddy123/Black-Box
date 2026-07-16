import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { ensurePrivateDirectory } from "./private-files.js";

export interface DaemonPaths {
  readonly homeDirectory: string;
  readonly tokenPath: string;
  readonly lockPath: string;
  readonly databasePath: string;
  readonly dataDirectory: string;
  readonly logDirectory: string;
  readonly logPath: string;
}

export interface DefaultHomeOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly userHome?: string;
}

export function defaultBlackBoxHome(options: DefaultHomeOptions = {}): string {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const userHome = options.userHome ?? homedir();

  if (environment.BLACKBOX_HOME !== undefined) {
    return resolve(environment.BLACKBOX_HOME);
  }
  if (platform === "darwin") {
    return join(userHome, "Library", "Application Support", "BlackBox");
  }
  if (platform === "win32") {
    return resolve(
      environment.LOCALAPPDATA ?? join(userHome, "AppData", "Local"),
      "BlackBox",
    );
  }
  const xdgDataHome = environment.XDG_DATA_HOME;
  return join(
    xdgDataHome !== undefined && isAbsolute(xdgDataHome)
      ? xdgDataHome
      : join(userHome, ".local", "share"),
    "blackbox",
  );
}

export function resolveDaemonPaths(homeDirectory?: string): DaemonPaths {
  const resolvedHome = resolve(homeDirectory ?? defaultBlackBoxHome());
  const logDirectory = join(resolvedHome, "logs");
  return {
    homeDirectory: resolvedHome,
    tokenPath: join(resolvedHome, "control.token"),
    lockPath: join(resolvedHome, "daemon.lock"),
    databasePath: join(resolvedHome, "blackbox.sqlite"),
    dataDirectory: join(resolvedHome, "data"),
    logDirectory,
    logPath: join(logDirectory, "daemon.log"),
  };
}

export async function ensureInstallLayout(paths: DaemonPaths): Promise<void> {
  await ensurePrivateDirectory(paths.homeDirectory);
  await ensurePrivateDirectory(paths.dataDirectory);
  await ensurePrivateDirectory(paths.logDirectory);
}
