import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseThreadStarted, resolveCodexLaunch } from "../src/control/wake-codex.js";

describe("wake Codex hello", () => {
  it("prefers the standalone Codex executable under CODEX_HOME", () => {
    const codexHome = "C:\\Users\\tester\\.codex-custom";
    const standalone = path.join(codexHome, "packages", "standalone", "current", "bin", "codex.exe");
    const pathCodex = path.join("C:\\tools", "codex.exe");
    const launch = resolveCodexLaunch({
      platform: "win32",
      env: { CODEX_HOME: codexHome, USERPROFILE: "C:\\Users\\tester", PATH: "C:\\tools" },
      existsSync: (candidate) => candidate === standalone || candidate === pathCodex,
    });

    expect(launch).toEqual({ command: standalone, args: ["exec", "--json", "hello"] });
  });

  it("uses USERPROFILE for the default standalone location", () => {
    const userProfile = "C:\\Users\\tester";
    const standalone = path.join(userProfile, ".codex", "packages", "standalone", "current", "bin", "codex.exe");
    const launch = resolveCodexLaunch({
      platform: "win32",
      env: { USERPROFILE: userProfile, PATH: "" },
      existsSync: (candidate) => candidate === standalone,
    });

    expect(launch.command).toBe(standalone);
    expect(launch.args).toEqual(["exec", "--json", "hello"]);
  });

  it("parses thread.started from Codex NDJSON", () => {
    const output = [
      JSON.stringify({ type: "item.completed", item: { type: "reasoning" } }),
      JSON.stringify({ type: "thread.started", thread_id: "0199f00d-dead-beef-8000-123456789abc" }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");

    expect(parseThreadStarted(output)).toBe("0199f00d-dead-beef-8000-123456789abc");
  });
});
