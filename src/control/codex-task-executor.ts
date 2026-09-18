import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type CodexTaskExecutionResult =
  | {
  success: true;
  exitCode: 0;
  threadId: string;
  finalMessage: string;
}
  | {
  success: false;
  exitCode: number | null;
  error:
    | "INVALID_INSTRUCTION"
    | "CODEX_NOT_FOUND"
    | "CODEX_START_FAILED"
    | "CODEX_EXITED_NONZERO"
    | "THREAD_STARTED_MISSING"
    | "FINAL_MESSAGE_MISSING";
  threadId?: string;
  diagnostic?: string;
};

export type CodexCliLaunch = {
  command: string;
  args: string[];
};

const CODEX_ARGS = ["exec", "--json", "-"];
const DIAGNOSTIC_STREAM_LIMIT = 1_500;

interface ResolveCodexOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  existsSync?: typeof fs.existsSync;
}

/**
 * Resolve the Codex CLI.
 *
 * The task instruction is intentionally NOT part of argv.
 * `codex exec --json -` reads the instruction from stdin.
 */
export function resolveCodexLaunch(
  options: ResolveCodexOptions = {}
): CodexCliLaunch {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? fs.existsSync;

  if (platform !== "win32") {
    return {
      command: "codex",
      args: [...CODEX_ARGS],
    };
  }

  const configuredHome = env.CODEX_HOME?.trim();
  const codexHome =
    configuredHome ||
    (env.USERPROFILE
      ? path.join(env.USERPROFILE, ".codex")
      : undefined);

  if (codexHome) {
    const standalone = path.join(
      codexHome,
      "packages",
      "standalone",
      "current",
      "bin",
      "codex.exe"
    );

    if (existsSync(standalone)) {
      return {
        command: standalone,
        args: [...CODEX_ARGS],
      };
    }
  }

  const pathEntries = (env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.replace(/^"|"$/g, ""))
    .filter(Boolean);

  for (const entry of pathEntries) {
    const executable = path.join(entry, "codex.exe");

    if (existsSync(executable)) {
      return {
        command: executable,
        args: [...CODEX_ARGS],
      };
    }

    const commandFile = path.join(entry, "codex.cmd");

    if (existsSync(commandFile)) {
      return {
        command: env.ComSpec ?? "cmd.exe",
        args: [
          "/d",
          "/s",
          "/c",
          `""${commandFile}" exec --json -"`,
        ],
      };
    }
  }

  return {
    command: "codex.exe",
    args: [...CODEX_ARGS],
  };
}

export function extractThreadId(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;

    try {
      const event = JSON.parse(line) as {
        type?: unknown;
        thread_id?: unknown;
      };

      if (
        event.type === "thread.started" &&
        typeof event.thread_id === "string" &&
        event.thread_id.length > 0
      ) {
        return event.thread_id;
      }
    } catch {
      // Ignore non-JSON diagnostics.
    }
  }

  return undefined;
}

/**
 * Codex can emit more than one agent_message during a run.
 * The last completed agent message is treated as the final answer.
 */
export function extractFinalAgentMessage(
  output: string
): string | undefined {
  let finalMessage: string | undefined;

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;

    try {
      const event = JSON.parse(line) as {
        type?: unknown;
        item?: {
          type?: unknown;
          text?: unknown;
        };
      };

      if (
        event.type === "item.completed" &&
        event.item?.type === "agent_message" &&
        typeof event.item.text === "string"
      ) {
        finalMessage = event.item.text;
      }
    } catch {
      // Ignore non-JSON diagnostics.
    }
  }

  return finalMessage;
}

function appendBounded(
  current: string,
  chunk: Buffer | string
): string {
  const combined = current + chunk.toString();

  return combined.length <= DIAGNOSTIC_STREAM_LIMIT
    ? combined
    : combined.slice(-DIAGNOSTIC_STREAM_LIMIT);
}

function sanitizedDiagnostic(
  stdout: string,
  stderr: string,
  workspaceRoot: string
): string | undefined {
  const replacements = [
    workspaceRoot,
    process.env.CODEX_HOME,
    process.env.USERPROFILE,
  ].filter((value): value is string => Boolean(value));

  const sanitize = (value: string): string => {
    let result = value
      .replace(
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
        ""
      )
      .trim();

    for (const sensitivePath of replacements) {
      result = result.replaceAll(sensitivePath, "<path>");
    }

    return result;
  };

  const parts = [
    stdout.trim() ? `stdout: ${sanitize(stdout)}` : "",
    stderr.trim() ? `stderr: ${sanitize(stderr)}` : "",
  ].filter(Boolean);

  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Execute one fresh Codex task and return its final agent message.
 *
 * The instruction is written to stdin. It is never interpolated into
 * a shell command or command-line argument.
 */
export function executeCodexTask(
  workspaceRoot: string,
  instruction: string
): Promise<CodexTaskExecutionResult> {
  if (!instruction.trim()) {
    return Promise.resolve({
      success: false,
      exitCode: null,
      error: "INVALID_INSTRUCTION",
    });
  }

  const launch = resolveCodexLaunch();

  return new Promise((resolve) => {
    let settled = false;

    let diagnosticStdout = "";
    let stderr = "";
    let pendingLine = "";

    let threadId: string | undefined;
    let finalMessage: string | undefined;

    const finish = (
      result: CodexTaskExecutionResult
    ): void => {
      if (settled) return;

      settled = true;
      resolve(result);
    };

    const consumeOutput = (output: string): void => {
      threadId ??= extractThreadId(output);

      const message = extractFinalAgentMessage(output);

      if (message !== undefined) {
        finalMessage = message;
      }
    };

    const child = spawn(launch.command, launch.args, {
      cwd: workspaceRoot,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stdout.on("data", (chunk: Buffer) => {
      diagnosticStdout = appendBounded(
        diagnosticStdout,
        chunk
      );

      pendingLine += chunk.toString();

      const lines = pendingLine.split(/\r?\n/);
      pendingLine = lines.pop() ?? "";

      consumeOutput(lines.join("\n"));
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
    });

    child.stdin.on("error", () => {
      // Process close/error is authoritative.
    });

    child.once(
      "error",
      (error: NodeJS.ErrnoException) => {
        finish({
          success: false,
          exitCode: null,
          error:
            error.code === "ENOENT"
              ? "CODEX_NOT_FOUND"
              : "CODEX_START_FAILED",
          diagnostic: sanitizedDiagnostic(
            "",
            error.message,
            workspaceRoot
          ),
        });
      }
    );

    child.once("close", (exitCode) => {
      consumeOutput(pendingLine);

      const diagnostic = sanitizedDiagnostic(
        diagnosticStdout,
        stderr,
        workspaceRoot
      );

      if (exitCode !== 0) {
        finish({
          success: false,
          exitCode,
          error: "CODEX_EXITED_NONZERO",
          threadId,
          diagnostic,
        });

        return;
      }

      if (!threadId) {
        finish({
          success: false,
          exitCode: 0,
          error: "THREAD_STARTED_MISSING",
          diagnostic,
        });

        return;
      }

      if (finalMessage === undefined) {
        finish({
          success: false,
          exitCode: 0,
          error: "FINAL_MESSAGE_MISSING",
          threadId,
          diagnostic,
        });

        return;
      }

      finish({
        success: true,
        exitCode: 0,
        threadId,
        finalMessage,
      });
    });

    child.stdin.end(instruction, "utf8");
  });
}