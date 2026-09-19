import { hostEventBus, type AiBackgroundProcess } from "../host-event-bus";
import { registerShutdownCleanup } from "../process-shutdown";

const REVEAL_AFTER_MS = 10_000;
const POLL_INTERVAL_MS = 1_000;

type TrackedProcess = AiBackgroundProcess & {
  revealed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

function processGroupIsAlive(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

class BackgroundProcessMonitor {
  private readonly processes = new Map<string, TrackedProcess>();

  track(processInfo: AiBackgroundProcess): void {
    if (this.processes.has(processInfo.processId) || !processGroupIsAlive(processInfo.pid)) return;
    const process: TrackedProcess = { ...processInfo, revealed: false, timer: null };
    this.processes.set(process.processId, process);
    this.check(process.processId);
  }

  /** 会话销毁或应用退出时停止跟踪，避免残留定时器与内存。 */
  clear(): void {
    for (const process of this.processes.values()) {
      if (process.timer) clearTimeout(process.timer);
    }
    this.processes.clear();
    this.emit();
  }

  private check(processId: string): void {
    const process = this.processes.get(processId);
    if (!process) return;
    if (!processGroupIsAlive(process.pid)) {
      this.processes.delete(processId);
      if (process.revealed) this.emit();
      return;
    }
    if (!process.revealed && Date.now() - process.startedAt >= REVEAL_AFTER_MS) {
      process.revealed = true;
      this.emit();
    }
    process.timer = setTimeout(() => this.check(processId), POLL_INTERVAL_MS);
    process.timer.unref?.();
  }

  private emit(): void {
    hostEventBus.emit({
      type: "ai_background_processes_snapshot",
      processes: [...this.processes.values()]
        .filter((process) => process.revealed)
        .map(({ revealed: _revealed, timer: _timer, ...process }) => process),
      updatedAt: Date.now(),
    });
  }
}

declare global {
  var __deerhuxBackgroundProcessMonitor: BackgroundProcessMonitor | undefined;
}

export const backgroundProcessMonitor = globalThis.__deerhuxBackgroundProcessMonitor ??= new BackgroundProcessMonitor();

// 应用退出时必须释放轮询定时器；进程组本身由各工具的终止语义负责。
registerShutdownCleanup(() => backgroundProcessMonitor.clear());

