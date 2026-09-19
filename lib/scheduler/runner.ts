// ============================================================================
// Task runner — executes scheduled prompt tasks via AI agent
// ============================================================================

import fs from "fs";
import path from "path";
import { getAgentDir as getCodingAgentDir } from "@earendil-works/pi-coding-agent";
import type { ScheduledTask, PromptTaskConfig, TaskLog } from "./types";
import { updateTask, appendTaskLog, getTask } from "./store";
import { cacheSessionPath, forceRefreshSessionList } from "../session-reader";
import { withProviderProxy } from "../provider-proxy";

const TASK_RUN_LOCK_TTL_MS = 2 * 60 * 60 * 1000;

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getTaskRunLockPath(taskId: string): string {
  const dir = path.join(getCodingAgentDir(), "scheduler-run-locks");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${encodeURIComponent(taskId)}.lock`);
}

function acquireTaskRunLock(taskId: string): (() => void) | null {
  const lockPath = getTaskRunLockPath(taskId);
  const payload = JSON.stringify({ pid: process.pid, startedAt: Date.now() });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, payload, { flag: "wx" });
      return () => {
        try {
          const raw = fs.readFileSync(lockPath, "utf-8");
          const parsed = JSON.parse(raw) as { pid?: unknown };
          if (parsed.pid === process.pid) fs.unlinkSync(lockPath);
        } catch {
          // Ignore cleanup races.
        }
      };
    } catch (err: unknown) {
      const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
      if (code !== "EEXIST") throw err;

      try {
        const raw = fs.readFileSync(lockPath, "utf-8");
        const parsed = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown };
        const pid = typeof parsed.pid === "number" ? parsed.pid : null;
        const startedAt = typeof parsed.startedAt === "number" ? parsed.startedAt : 0;
        const stale = !pid || !isProcessAlive(pid) || Date.now() - startedAt > TASK_RUN_LOCK_TTL_MS;
        if (stale) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        try {
          fs.unlinkSync(lockPath);
          continue;
        } catch {
          // Another process may own it now.
        }
      }

      return null;
    }
  }

  return null;
}

function recordResult(taskId: string, result: "success" | "error", output?: string, error?: string, durationMs?: number, sessionId?: string, sessionFile?: string): void {
  updateTask(taskId, {
    lastRunAt: new Date().toISOString(),
    lastResult: result,
    lastError: error,
  });

  const log: TaskLog = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    result,
    error,
    output: output?.slice(0, 500),
    durationMs: durationMs ?? 0,
    sessionId,
    sessionFile,
  };
  appendTaskLog(taskId, log);
}

async function runPromptTask(task: ScheduledTask, config: PromptTaskConfig): Promise<void> {
  const startTime = Date.now();
  let capturedOutput: string | undefined;
  let scheduledSessionId: string | undefined;
  let scheduledSessionFile: string | undefined;

  try {
    const { createAgentSession, SessionManager, getAgentDir } = await import("@earendil-works/pi-coding-agent");

    const agentDir = getAgentDir();
    const sessionManager = SessionManager.create(config.cwd, undefined);

    let toolNames: string[] | undefined;
    if (config.toolNames) {
      toolNames = config.toolNames;
    } else {
      // Default: enable all coding tools
      toolNames = ["read", "bash", "edit", "write", "grep", "find", "ls"];
    }

    const { session } = await createAgentSession({
      cwd: config.cwd,
      agentDir,
      sessionManager,
      tools: toolNames,
    });
    scheduledSessionId = session.sessionId;
    scheduledSessionFile = session.sessionFile;
    if (scheduledSessionId && scheduledSessionFile) cacheSessionPath(scheduledSessionId, scheduledSessionFile);
    forceRefreshSessionList();

    if (config.model) {
      try {
        const model = session.modelRegistry.find(config.model.provider, config.model.modelId);
        if (model) {
          await session.setModel(model);
        }
      } catch {
        // Use default model if specified model not found
      }
    }

    // Wait for the prompt to complete
    const maxWaitMs = 30 * 60 * 1000; // 30 minutes max

    let agentError: string | undefined;

    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const execStartTime = Date.now();

      const unsubscribe = session.subscribe((event) => {
        if (finished) return;

        // agent_end signals the full run is complete
        if (event.type === "agent_end") {
          finished = true;
          unsubscribe();

          const agentEndEvent = event as { messages?: Array<{ role?: string; content?: unknown; errorMessage?: string }> };
          const messages = agentEndEvent.messages;
          if (messages) {
            // Capture last assistant message as output
            for (let i = messages.length - 1; i >= 0; i--) {
              const msg = messages[i];
              if (msg.role === "assistant" && msg.content) {
                capturedOutput = typeof msg.content === "string"
                  ? msg.content
                  : JSON.stringify(msg.content);
                break;
              }
            }
            // Check for error messages
            for (const msg of messages) {
              if (msg.errorMessage) {
                agentError = msg.errorMessage;
                break;
              }
            }
          }
          resolve();
          return;
        }

        // Timeout check
        if (Date.now() - execStartTime > maxWaitMs) {
          finished = true;
          unsubscribe();
          reject(new Error("Prompt execution timed out (30 minutes)"));
        }
      });

      // Send the prompt
      const provider = config.model?.provider ?? session.model?.provider ?? "";
      withProviderProxy(provider, () => session.prompt(config.message)).catch((err: unknown) => {
        if (!finished) {
          finished = true;
          unsubscribe();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });

    const durationMs = Date.now() - startTime;

    if (agentError) {
      recordResult(task.id, "error", capturedOutput, agentError, durationMs, scheduledSessionId, scheduledSessionFile);
      console.error(`[scheduler] Prompt task "${task.name}" failed: ${agentError}`);
      return;
    }

    recordResult(task.id, "success", capturedOutput, undefined, durationMs, scheduledSessionId, scheduledSessionFile);
    console.log(`[scheduler] Prompt task "${task.name}" completed successfully (${durationMs}ms)`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startTime;
    recordResult(task.id, "error", capturedOutput, message, durationMs, scheduledSessionId, scheduledSessionFile);
    console.error(`[scheduler] Prompt task "${task.name}" failed: ${message}`);
  }
}

export async function executeTask(task: ScheduledTask): Promise<void> {
  const releaseLock = acquireTaskRunLock(task.id);
  if (!releaseLock) {
    console.log(`[scheduler] Task "${task.name}" (${task.id}) is already running; skipping duplicate trigger`);
    return;
  }

  try {
    console.log(`[scheduler] Executing task: "${task.name}" (${task.id})`);

    // Increment run count from the latest store value. Cron callbacks keep the
    // original task object in memory, so using task.runCount here becomes stale.
    const latestTask = getTask(task.id);
    updateTask(task.id, {
      runCount: ((latestTask?.runCount ?? task.runCount) || 0) + 1,
    });

    await runPromptTask(task, task.config as PromptTaskConfig);
  } finally {
    releaseLock();
  }
}
