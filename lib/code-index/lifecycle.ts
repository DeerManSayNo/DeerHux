import { watch, type FSWatcher } from "fs";
import path from "path";
import { refreshIndex } from "./indexer";
import { DEFAULT_IGNORES, IGNORED_EXTENSIONS } from "./config";

interface ProjectIndex {
  cwd: string;
  listeners: Set<() => void>;
  watcher?: FSWatcher;
  poll: ReturnType<typeof setInterval>;
  debounce?: ReturnType<typeof setTimeout>;
  running?: Promise<void>;
  dirty: boolean;
  closed: boolean;
  error?: string;
}

/** One watcher and one scan at a time per open project, shared by all sessions. */
export class CodeIndexLifecycle {
  private projects = new Map<string, ProjectIndex>();
  private warm = new Map<string, { release: () => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly timings = { debounceMs: 750, pollMs: 30_000, warmMs: 90_000 }) {}

  acquire(cwd: string, onReady: () => void = () => {}) {
    const root = path.resolve(cwd);
    let entry = this.projects.get(root);
    if (!entry) {
      const poll = setInterval(() => { void this.run(entry!); }, this.timings.pollMs);
      poll.unref();
      entry = { cwd: root, listeners: new Set(), poll, dirty: false, closed: false };
      this.projects.set(root, entry);
      const project = entry;
      try {
        project.watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
          const relative = filename?.toString().replace(/\\/g, "/");
          if (relative && (relative.split("/").some(part => DEFAULT_IGNORES.has(part))
            || IGNORED_EXTENSIONS.has(path.extname(relative).toLowerCase()))) return;
          // Bounded debounce: continuous edits cannot postpone a refresh forever.
          if (!project.debounce) {
            project.debounce = setTimeout(() => {
              project.debounce = undefined;
              void this.run(project);
            }, this.timings.debounceMs);
            project.debounce.unref();
          }
        });
        project.watcher.on("error", () => {
          project.watcher?.close();
          project.watcher = undefined; // Polling also covers platforms without recursive watch.
        });
      } catch { /* Periodic reconciliation remains available. */ }
      queueMicrotask(() => { void this.run(project); });
    }
    const project = entry;
    // A wrapper callback is unique even when callers supply the same listener.
    const listener = () => onReady();
    project.listeners.add(listener);
    let released = false;
    return {
      refresh: () => this.run(project),
      release: () => {
        if (released) return;
        released = true;
        project.listeners.delete(listener);
        if (project.listeners.size) return;
        project.closed = true;
        clearInterval(project.poll);
        clearTimeout(project.debounce);
        project.watcher?.close();
        this.projects.delete(root);
      },
    };
  }

  /** Short renewable lease for a project selected in the UI before a session exists. */
  touch(cwd: string): void {
    const root = path.resolve(cwd);
    const existing = this.warm.get(root);
    if (existing) clearTimeout(existing.timer);
    const release = existing?.release ?? this.acquire(root).release;
    const timer = setTimeout(() => { this.warm.delete(root); release(); }, this.timings.warmMs);
    timer.unref();
    this.warm.set(root, { release, timer });
  }

  private run(project: ProjectIndex): Promise<void> {
    if (project.closed) return Promise.resolve();
    project.dirty = true;
    if (project.running) return project.running;
    project.running = (async () => {
      while (project.dirty && !project.closed) {
        project.dirty = false;
        try {
          await refreshIndex(project.cwd);
          project.error = undefined;
          if (!project.closed) for (const listener of project.listeners) {
            try { listener(); } catch (error) { console.warn("[code-index] tool refresh failed", error); }
          }
        } catch (error) {
          const message = String(error);
          if (message !== project.error) console.warn(`[code-index] ${project.cwd}: ${message}`);
          project.error = message; // Keep the last valid index; retry on the next event/poll.
        }
      }
    })().finally(() => { project.running = undefined; });
    return project.running;
  }
}

declare global {
  var __deerhuxCodeIndexLifecycle: CodeIndexLifecycle | undefined;
}
export function codeIndexLifecycle(): CodeIndexLifecycle {
  return globalThis.__deerhuxCodeIndexLifecycle ??= new CodeIndexLifecycle();
}
