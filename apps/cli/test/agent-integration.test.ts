import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_UPSTREAM_ORIGIN,
  CliUsageError,
  defaultUpstreamForAgent,
  prepareAgentLaunch,
  resolveAgentIntegration,
} from "../src/index.js";

describe("agent integrations", () => {
  it("auto-detects Codex and Claude without misclassifying other clients", () => {
    expect(resolveAgentIntegration(undefined, "/usr/local/bin/codex")).toBe(
      "codex",
    );
    expect(resolveAgentIntegration("auto", "C:\\tools\\claude.exe")).toBe(
      process.platform === "win32" ? "claude" : "openai-compatible",
    );
    expect(resolveAgentIntegration("auto", "/usr/local/bin/claude")).toBe(
      "claude",
    );
    expect(resolveAgentIntegration("auto", "custom-agent")).toBe(
      "openai-compatible",
    );
  });

  it("validates explicit agent selections", () => {
    expect(resolveAgentIntegration("claude", "anything")).toBe("claude");
    expect(() => resolveAgentIntegration("future-agent", "anything")).toThrow(
      CliUsageError,
    );
  });

  it("launches Codex with a one-run config override and OpenAI base URL", () => {
    const prepared = prepareAgentLaunch(
      "codex",
      ["exec", "inspect this project"],
      "http://127.0.0.1:4141/.blackbox/session/c2Vzc2lvbg",
    );

    expect(prepared.arguments).toEqual([
      "--config",
      'openai_base_url="http://127.0.0.1:4141/.blackbox/session/c2Vzc2lvbg/v1"',
      "exec",
      "inspect this project",
    ]);
    expect(prepared.environment).toEqual({
      BLACKBOX_AGENT: "codex",
      OPENAI_BASE_URL: "http://127.0.0.1:4141/.blackbox/session/c2Vzc2lvbg/v1",
    });
  });

  it("launches Claude with its native base URL and provider default", () => {
    const prepared = prepareAgentLaunch(
      "claude",
      ["-p", "inspect this project"],
      "http://127.0.0.1:4141/.blackbox/session/c2Vzc2lvbg",
    );

    expect(defaultUpstreamForAgent("claude")).toBe(ANTHROPIC_UPSTREAM_ORIGIN);
    expect(prepared).toEqual({
      arguments: ["-p", "inspect this project"],
      environment: {
        BLACKBOX_AGENT: "claude",
        ANTHROPIC_BASE_URL:
          "http://127.0.0.1:4141/.blackbox/session/c2Vzc2lvbg",
      },
    });
    expect(prepared.environment).not.toHaveProperty("OPENAI_BASE_URL");
  });
});
