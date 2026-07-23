import { basename } from "node:path";

import { CliUsageError } from "./configuration.js";

export const ANTHROPIC_UPSTREAM_ORIGIN = "https://api.anthropic.com";

export type AgentIntegration = "codex" | "claude" | "openai-compatible";

const SUPPORTED_AGENT_VALUES = new Set([
  "auto",
  "codex",
  "claude",
  "openai-compatible",
]);

function executableName(executable: string): string {
  return basename(executable)
    .toLowerCase()
    .replace(/\.exe$/u, "");
}

export function resolveAgentIntegration(
  requested: string | undefined,
  executable: string,
): AgentIntegration {
  const selected = requested ?? "auto";
  if (!SUPPORTED_AGENT_VALUES.has(selected)) {
    throw new CliUsageError(
      "--agent must be auto, codex, claude, or openai-compatible.",
    );
  }
  if (selected !== "auto") {
    return selected as AgentIntegration;
  }
  const name = executableName(executable);
  if (name === "codex") {
    return "codex";
  }
  if (name === "claude") {
    return "claude";
  }
  return "openai-compatible";
}

export function defaultUpstreamForAgent(
  agent: AgentIntegration,
): string | undefined {
  return agent === "claude" ? ANTHROPIC_UPSTREAM_ORIGIN : undefined;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export interface PreparedAgentLaunch {
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

export function prepareAgentLaunch(
  agent: AgentIntegration,
  arguments_: readonly string[],
  sessionProxyOrigin: string,
): PreparedAgentLaunch {
  const openAiBaseUrl = `${sessionProxyOrigin}/v1`;
  const common = {
    BLACKBOX_AGENT: agent,
  };
  if (agent === "claude") {
    return {
      arguments: [...arguments_],
      environment: {
        ...common,
        ANTHROPIC_BASE_URL: sessionProxyOrigin,
      },
    };
  }
  if (agent === "codex") {
    return {
      arguments: [
        "--config",
        `openai_base_url=${tomlString(openAiBaseUrl)}`,
        ...arguments_,
      ],
      environment: {
        ...common,
        OPENAI_BASE_URL: openAiBaseUrl,
      },
    };
  }
  return {
    arguments: [...arguments_],
    environment: {
      ...common,
      OPENAI_BASE_URL: openAiBaseUrl,
    },
  };
}
