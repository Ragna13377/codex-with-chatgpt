import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type WakeCodexResult =
  | { success: true; exitCode: 0; threadId: string; opened: true }
  | {
      success: false;
      exitCode: number | null;
      error:
        | "CODEX_NOT_FOUND"
        | "CODEX_START_FAILED"
        | "CODEX_EXITED_NONZERO"
        | "THREAD_STARTED_MISSING"
        | "CODEX_DESKTOP_OPEN_FAILED";
      diagnostic?: string;
    };

export type CodexLaunch = { command: string; args: string[] };

const CODEX_ARGS = ["exec", "--json", "hello"];
const DIAGNOSTIC_STREAM_LIMIT = 1_500;

interface ResolveCodexOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  existsSync?: typeof fs.existsSync;
}

/** Resolve the Codex CLI, preferring the version managed by Codex Desktop on Windows. */
export function resolveCodexLaunch(options: ResolveCodexOptions = {}): CodexLaunch {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? fs.existsSync;

  if (platform !== "win32") return { command: "codex", args: [...CODEX_ARGS] };

  const configuredHome = env.CODEX_HOME?.trim();
  const codexHome = configuredHome || (env.USERPROFILE ? path.join(env.USERPROFILE, ".codex") : undefined);
  if (codexHome) {
    const standalone = path.join(codexHome, "packages", "standalone", "current", "bin", "codex.exe");
    if (existsSync(standalone)) return { command: standalone, args: [...CODEX_ARGS] };
  }

  const pathEntries = (env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.replace(/^"|"$/g, ""))
    .filter(Boolean);

  for (const entry of pathEntries) {
    const executable = path.join(entry, "codex.exe");
    if (existsSync(executable)) return { command: executable, args: [...CODEX_ARGS] };

    const commandFile = path.join(entry, "codex.cmd");
    if (existsSync(commandFile)) {
      return {
        command: env.ComSpec ?? "cmd.exe",
        args: ["/d", "/s", "/c", `""${commandFile}" exec --json hello"`],
      };
    }
  }

  return { command: "codex.exe", args: [...CODEX_ARGS] };
}

/** Return the thread id from a Codex CLI NDJSON stream, if present. */
export function parseThreadStarted(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: unknown; thread_id?: unknown };
      if (event.type === "thread.started" && typeof event.thread_id === "string" && event.thread_id.length > 0) {
        return event.thread_id;
      }
    } catch {
      // Ignore non-JSON diagnostics and continue scanning NDJSON events.
    }
  }
  return undefined;
}

function appendBounded(current: string, chunk: Buffer | string): string {
  const combined = current + chunk.toString();
  return combined.length <= DIAGNOSTIC_STREAM_LIMIT ? combined : combined.slice(-DIAGNOSTIC_STREAM_LIMIT);
}

function sanitizedDiagnostic(stdout: string, stderr: string, workspaceRoot: string): string | undefined {
  const replacements = [workspaceRoot, process.env.CODEX_HOME, process.env.USERPROFILE].filter(
    (value): value is string => Boolean(value)
  );
  const sanitize = (value: string): string => {
    let result = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
    for (const sensitivePath of replacements) result = result.replaceAll(sensitivePath, "<path>");
    return result;
  };

  const parts = [
    stdout.trim() ? `stdout: ${sanitize(stdout)}` : "",
    stderr.trim() ? `stderr: ${sanitize(stderr)}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function openCodexThread(threadId: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]+$/.test(threadId)) return Promise.resolve(false);

  const uri = `codex://threads/${threadId}`;
  const launch =
    process.platform === "win32"
      ? { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", uri] }
      : process.platform === "darwin"
        ? { command: "open", args: [uri] }
        : { command: "xdg-open", args: [uri] };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (opened: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(opened);
    };
    const child = spawn(launch.command, launch.args, {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => finish(false));
    child.once("close", (exitCode) => finish(exitCode === 0));
  });
}

/** Start a fresh Codex thread with the fixed message "hello", then open it in Codex Desktop. */
export function wakeCodexHello(workspaceRoot: string): Promise<WakeCodexResult> {
  const launch = resolveCodexLaunch();

  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let pendingLine = "";
    let threadId: string | undefined;
    const finish = (result: WakeCodexResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const child = spawn(launch.command, launch.args, {
      cwd: workspaceRoot,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk);
      pendingLine += chunk.toString();
      const lines = pendingLine.split(/\r?\n/);
      pendingLine = lines.pop() ?? "";
      threadId ??= parseThreadStarted(lines.join("\n"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish({
        success: false,
        exitCode: null,
        error: error.code === "ENOENT" ? "CODEX_NOT_FOUND" : "CODEX_START_FAILED",
        diagnostic: sanitizedDiagnostic("", error.message, workspaceRoot),
      });
    });
    child.once("close", async (exitCode) => {
      threadId ??= parseThreadStarted(pendingLine);
      const diagnostic = sanitizedDiagnostic(stdout, stderr, workspaceRoot);
      if (exitCode !== 0) {
        finish({ success: false, exitCode, error: "CODEX_EXITED_NONZERO", diagnostic });
        return;
      }
      if (!threadId) {
        finish({ success: false, exitCode: 0, error: "THREAD_STARTED_MISSING", diagnostic });
        return;
      }

      const opened = await openCodexThread(threadId);
      if (!opened) {
        finish({ success: false, exitCode: 0, error: "CODEX_DESKTOP_OPEN_FAILED" });
        return;
      }
      finish({ success: true, exitCode: 0, threadId, opened: true });
    });
  });
}
