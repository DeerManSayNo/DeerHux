type ShutdownCleanup = () => void | Promise<void>;

interface ShutdownState {
  cleanups: Set<ShutdownCleanup>;
  installed: boolean;
  shuttingDown: boolean;
}

declare global {
  var __deerhuxShutdownState: ShutdownState | undefined;
}

function state(): ShutdownState {
  return globalThis.__deerhuxShutdownState ??= {
    cleanups: new Set(),
    installed: false,
    shuttingDown: false,
  };
}

export function registerShutdownCleanup(cleanup: ShutdownCleanup): () => void {
  const current = state();
  if (current.shuttingDown) {
    try { void cleanup(); } catch { /* shutdown is already in progress */ }
    return () => {};
  }
  current.cleanups.add(cleanup);
  installHandlers(current);
  return () => current.cleanups.delete(cleanup);
}

function installHandlers(current: ShutdownState): void {
  if (current.installed) return;
  current.installed = true;
  process.once("exit", () => {
    for (const cleanup of takeCleanups(current)) {
      try { void cleanup(); } catch { /* process is exiting */ }
    }
  });
  process.once("SIGINT", () => { void shutdown(current, 130); });
  process.once("SIGTERM", () => { void shutdown(current, 143); });
}

function takeCleanups(current: ShutdownState): ShutdownCleanup[] {
  const cleanups = [...current.cleanups];
  current.cleanups.clear();
  return cleanups;
}

async function shutdown(current: ShutdownState, exitCode: number): Promise<void> {
  if (current.shuttingDown) return;
  current.shuttingDown = true;
  const cleanup = Promise.allSettled(takeCleanups(current).map((fn) => Promise.resolve().then(fn)));
  await Promise.race([
    cleanup,
    new Promise<void>((resolve) => setTimeout(resolve, 3_500)),
  ]);
  process.exit(exitCode);
}
