// ============================================================================
// Node.js-only instrumentation implementation
// - Migrates scheduler config before scheduler startup
// - Defers session/config migration, bundled skills, and orphan cleanup
// - Sets DeerHux agent dir to ~/.deerhux/agent so the runtime uses DeerHux paths
// - Registers the scheduler engine for cron-based task execution
// ============================================================================

type InstrumentationGlobal = typeof globalThis & {
  __deerhuxMaintenanceByHome?: Map<string, Promise<void>>;
};

function startBackgroundMaintenance(home: string): Promise<void> {
  const globals = globalThis as InstrumentationGlobal;
  const maintenanceByHome = globals.__deerhuxMaintenanceByHome ??= new Map();
  const existing = maintenanceByHome.get(home);
  if (existing) return existing;

  // Keep the settled promise on globalThis so Next.js HMR cannot repeat the
  // filesystem scan/cleanup. Convert every failure to a resolved promise to
  // avoid an unhandled rejection from fire-and-forget maintenance.
  const maintenance = (async () => {
    try {
      const { migratePiAgentDir } = await import("./lib/legacy-migration");
      migratePiAgentDir(home);
    } catch (error) {
      console.error("[init] Legacy data migration failed:", error);
    }

    try {
      const fs = await import("fs");
      const path = await import("path");
      const targetDir = path.join(home, ".deerhux", "agent", "skills");
      fs.mkdirSync(targetDir, { recursive: true });

      // In production (Tauri), skills are bundled at app/standalone/skills/.
      // In dev, process.cwd() is the project root where skills/ lives.
      const skillsDir = path.join(process.cwd(), "skills");
      if (fs.existsSync(skillsDir)) {
        for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

          const srcSkillMd = path.join(skillsDir, entry.name, "SKILL.md");
          const destDir = path.join(targetDir, entry.name);
          const destSkillMd = path.join(destDir, "SKILL.md");
          if (!fs.existsSync(srcSkillMd) || fs.existsSync(destSkillMd)) continue;

          fs.mkdirSync(destDir, { recursive: true });
          try {
            fs.copyFileSync(srcSkillMd, destSkillMd, fs.constants.COPYFILE_EXCL);
            console.log(`[init] Installed default skill: ${entry.name}`);
          } catch (error: unknown) {
            const code = error && typeof error === "object" && "code" in error
              ? (error as { code?: unknown }).code
              : undefined;
            if (code !== "EEXIST") throw error;
          }
        }
      }
    } catch (error) {
      console.error("[init] Default skill installation failed:", error);
    }

    try {
      const fs = await import("fs");
      const os = await import("os");
      const { getIsolatedRunsRoot } = await import("./lib/parallel-agent/worktree");
      const { getGitProcessStartMarker } = await import("./lib/parallel-agent/git-lock");
      const { reconcileRuns } = await import("./lib/parallel-agent/worktree-reconciler");
      const runsRoot = getIsolatedRunsRoot();
      if (fs.existsSync(runsRoot)) {
        const result = await reconcileRuns({
          runsRoot,
          instanceId: `startup-${process.pid}`,
          processStartIdentity: getGitProcessStartMarker(),
          isProcessAlive(pid, identity) {
            try {
              process.kill(pid, 0);
              return fs.readFileSync(`${os.tmpdir()}/deerhux-git-${pid}.start`, "utf8") === identity;
            } catch {
              return false;
            }
          },
        });
        if (result.recovered.length > 0 || result.issues.length > 0) {
          console.warn(`[init] Coordinated ${result.recovered.length} subagent run(s); ${result.issues.length} item(s) require manual review`);
        }
      }
    } catch {
      console.error("[init] Subagent recovery inspection failed (WORKTREE_RECOVERY_FAILED)");
    }
  })().catch((error) => {
    // Defensive final handler: individual maintenance steps already isolate
    // their own failures, but this guarantees the detached promise is handled.
    console.error("[init] Background maintenance failed:", error);
  });
  maintenanceByHome.set(home, maintenance);
  return maintenance;
}

export async function registerNodeInstrumentation(): Promise<void> {
  const path = await import("path");
  const home = process.env.HOME || process.env.USERPROFILE;

  if (home) {
    // Set this before importing scheduler modules: getAgentDir() may cache it.
    const deerhuxAgentDir = path.join(home, ".deerhux", "agent");
    if (!process.env.DEERHUX_CODING_AGENT_DIR) {
      process.env.DEERHUX_CODING_AGENT_DIR = deerhuxAgentDir;
    }
    // Backward-compatible fallback for unpatched pi-coding-agent builds.
    if (!process.env.PI_CODING_AGENT_DIR) {
      process.env.PI_CODING_AGENT_DIR = deerhuxAgentDir;
    }

    // Scheduler config is the only migration on the startup barrier. The
    // exclusive copy cannot overwrite a file concurrently created by the app.
    const { migratePiSchedulerConfig } = await import("./lib/legacy-migration");
    if (migratePiSchedulerConfig(home)) {
      console.log("[init] Migrated legacy scheduler config");
    }
  }

  // Keep the scheduler implementation lazy, but never let it observe the store
  // before the scheduler-specific migration barrier above has completed.
  const { startScheduler } = await import("./lib/scheduler/engine");
  startScheduler();

  if (home) await startBackgroundMaintenance(home);
}
