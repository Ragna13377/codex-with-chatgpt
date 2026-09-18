import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractFinalAgentMessage,
  extractThreadId,
  resolveCodexLaunch,
} from "../src/control/codex-task-executor.js";

describe("Codex task executor", () => {
  it("prefers the standalone Codex executable under CODEX_HOME", () => {
    const codexHome =
      "C:\\Users\\tester\\.codex-custom";

    const standalone = path.join(
      codexHome,
      "packages",
      "standalone",
      "current",
      "bin",
      "codex.exe"
    );

    const pathCodex = path.join(
      "C:\\tools",
      "codex.exe"
    );

    const launch = resolveCodexLaunch({
      platform: "win32",
      env: {
        CODEX_HOME: codexHome,
        USERPROFILE: "C:\\Users\\tester",
        PATH: "C:\\tools",
      },
      existsSync: (candidate) =>
        candidate === standalone ||
        candidate === pathCodex,
    });

    expect(launch).toEqual({
      command: standalone,
      args: ["exec", "--json", "-"],
    });
  });

  it("uses USERPROFILE for the default standalone location", () => {
    const userProfile = "C:\\Users\\tester";

    const standalone = path.join(
      userProfile,
      ".codex",
      "packages",
      "standalone",
      "current",
      "bin",
      "codex.exe"
    );

    const launch = resolveCodexLaunch({
      platform: "win32",
      env: {
        USERPROFILE: userProfile,
        PATH: "",
      },
      existsSync: (candidate) =>
        candidate === standalone,
    });

    expect(launch.command).toBe(standalone);

    expect(launch.args).toEqual([
      "exec",
      "--json",
      "-",
    ]);
  });

  it("extracts thread id from Codex JSONL", () => {
    const output = [
      JSON.stringify({
        type: "item.completed",
        item: { type: "reasoning" },
      }),
      JSON.stringify({
        type: "thread.started",
        thread_id:
          "0199f00d-dead-beef-8000-123456789abc",
      }),
      JSON.stringify({
        type: "turn.completed",
      }),
    ].join("\n");

    expect(extractThreadId(output)).toBe(
      "0199f00d-dead-beef-8000-123456789abc"
    );
  });

  it("extracts the final completed agent message", () => {
    const output = [
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: "first response",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "reasoning",
          text: "internal reasoning",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: "final response",
        },
      }),
      JSON.stringify({
        type: "turn.completed",
      }),
    ].join("\n");

    expect(
      extractFinalAgentMessage(output)
    ).toBe("final response");
  });

  it("returns undefined when no agent message exists", () => {
    const output = [
      JSON.stringify({
        type: "thread.started",
        thread_id: "thread-1",
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "reasoning",
          text: "reasoning only",
        },
      }),
      JSON.stringify({
        type: "turn.completed",
      }),
    ].join("\n");

    expect(
      extractFinalAgentMessage(output)
    ).toBeUndefined();
  });
});