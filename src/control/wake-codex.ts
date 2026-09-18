import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type WakeCodexResult =
  | { success: true; exitCode: 0 }
  | { success: false; exitCode: number | null; error: "CODEX_NOT_FOUND" | "CODEX_START_FAILED" | "CODEX_EXITED_NONZERO" };

type CodexLaunch = { command: string; args: string[] };

const CODEX_ARGS = ["exec", "resume", "--last", "hello"];

function windowsCodexLaunch(): CodexLaunch {
  const pathEntries = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.replace(/^"|"$/g, ""))
    .filter(Boolean);

  for (const entry of pathEntries) {
    const executable = path.join(entry, "codex.exe");
    if (fs.existsSync(executable)) return { command: executable, args: CODEX_ARGS };

    const commandFile = path.join(entry, "codex.cmd");
    if (fs.existsSync(commandFile)) {
      return {
        command: process.env.ComSpec ?? "cmd.exe",
        args: ["/d", "/s", "/c", `""${commandFile}" exec resume --last hello"`],
      };
    }
  }

  return { command: "codex.exe", args: CODEX_ARGS };
}

/** Start a new turn in the most recent Codex thread for this workspace. */
export function wakeCodexHello(workspaceRoot: string): Promise<WakeCodexResult> {
  const launch = process.platform === "win32" ? windowsCodexLaunch() : { command: "codex", args: CODEX_ARGS };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: WakeCodexResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const child = spawn(launch.command, launch.args, {
      cwd: workspaceRoot,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });

    child.once("error", (error: NodeJS.ErrnoException) => {
      finish({
        success: false,
        exitCode: null,
        error: error.code === "ENOENT" ? "CODEX_NOT_FOUND" : "CODEX_START_FAILED",
      });
    });
    child.once("close", (exitCode) => {
      if (exitCode === 0) {
        finish({ success: true, exitCode: 0 });
      } else {
        finish({ success: false, exitCode, error: "CODEX_EXITED_NONZERO" });
      }
    });
  });
}
