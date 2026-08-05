import { copyFileSync, cpSync, existsSync, linkSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";

const MIGRATION_MARKER = ".migrated-from-pi";
const SCHEDULER_CONFIG = "scheduled-tasks.json";

function copyFileIfMissing(src: string, dest: string): boolean {
  if (!existsSync(src)) return false;
  mkdirSync(dirname(dest), { recursive: true });
  const temp = `${dest}.migrate-${process.pid}-${crypto.randomUUID()}.tmp`;
  try {
    // Copy fully to a private file, then atomically publish it with a hard link.
    // EEXIST therefore means another complete destination already won; readers
    // can never observe a partially copied JSON/session file.
    copyFileSync(src, temp);
    try {
      linkSync(temp, dest);
      return true;
    } catch (error: unknown) {
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code === "EEXIST") return false;
      throw error;
    }
  } finally {
    try { unlinkSync(temp); } catch { /* best effort */ }
  }
}

/**
 * Migrate only the scheduler store before the scheduler reads it.
 * This stays on the startup critical path, but is a single atomic file copy.
 */
export function migratePiSchedulerConfig(home: string): boolean {
  return copyFileIfMissing(
    join(home, ".pi", "agent", SCHEDULER_CONFIG),
    join(home, ".deerhux", "agent", SCHEDULER_CONFIG),
  );
}

function mergeSessionFiles(srcDir: string, destDir: string): number {
  if (!existsSync(srcDir)) return 0;
  mkdirSync(destDir, { recursive: true });
  let copied = 0;
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const srcSub = join(srcDir, entry.name);
    const destSub = join(destDir, entry.name);
    mkdirSync(destSub, { recursive: true });
    for (const file of readdirSync(srcSub)) {
      if (!file.endsWith(".jsonl")) continue;
      const srcFile = join(srcSub, file);
      const destFile = join(destSub, file);
      if (copyFileIfMissing(srcFile, destFile)) copied++;
    }
  }
  return copied;
}

/** Merge skill directories from a legacy .pi skills path into .deerhux. */
export function syncSkillDir(src: string, dest: string): number {
  if (!existsSync(src)) return 0;
  mkdirSync(dest, { recursive: true });
  let synced = 0;
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const srcSkill = join(src, entry.name, "SKILL.md");
    if (!existsSync(srcSkill)) continue;
    const destDir = join(dest, entry.name);
    const destSkill = join(destDir, "SKILL.md");
    const shouldCopy = !existsSync(destSkill)
      || statSync(srcSkill).mtimeMs > statSync(destSkill).mtimeMs;
    if (shouldCopy) {
      cpSync(join(src, entry.name), destDir, { recursive: true });
      synced++;
    }
  }
  return synced;
}

/** After `npx skills --agent pi`, relocate installs into DeerHux paths. */
export function syncSkillsFromPiToDeerhux(home: string, opts: { cwd?: string; isGlobal: boolean }): number {
  let synced = 0;
  if (opts.isGlobal) {
    synced += syncSkillDir(
      join(home, ".pi", "agent", "skills"),
      join(home, ".deerhux", "agent", "skills"),
    );
  }
  if (opts.cwd) {
    synced += syncSkillDir(
      join(opts.cwd, ".pi", "skills"),
      join(opts.cwd, ".deerhux", "skills"),
    );
  }
  return synced;
}

/**
 * One-time (plus incremental sessions) migration from ~/.pi/agent to ~/.deerhux/agent.
 * Config JSON files are only copied on the first run when the destination file is missing.
 *
 * Important: skills are no longer silently synced during startup/read flows.
 * The skills install API still calls syncSkillsFromPiToDeerhux() explicitly because
 * the upstream skills CLI currently installs to .pi when using --agent pi.
 */
export function migratePiAgentDir(home: string): void {
  const oldDir = join(home, ".pi", "agent");
  const newDir = join(home, ".deerhux", "agent");
  if (!existsSync(oldDir)) return;

  mkdirSync(newDir, { recursive: true });
  const firstRun = !existsSync(join(newDir, MIGRATION_MARKER));

  let sessionsCopied = 0;
  let configsCopied = 0;

  sessionsCopied += mergeSessionFiles(
    join(oldDir, "sessions"),
    join(newDir, "sessions"),
  );

  if (firstRun) {
    for (const entry of readdirSync(oldDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      // The scheduler store is migrated synchronously before scheduler startup.
      if (entry.name === SCHEDULER_CONFIG) continue;
      // MCP is now read as a separate compatible source by the extension facade;
      // do not silently copy it into DeerHux and change precedence.
      if (entry.name === "mcp.json") continue;
      if (copyFileIfMissing(join(oldDir, entry.name), join(newDir, entry.name))) {
        configsCopied++;
      }
    }
    writeFileSync(join(newDir, MIGRATION_MARKER), new Date().toISOString(), "utf8");
  }

  if (sessionsCopied > 0 || configsCopied > 0) {
    console.log(
      `[init] Migrated legacy ~/.pi/agent → ~/.deerhux/agent`
      + ` (sessions: ${sessionsCopied}, configs: ${configsCopied})`,
    );
  } else if (firstRun) {
    console.log("[init] Recorded ~/.pi/agent migration marker (no new files to copy)");
  }
}

/**
 * Migrate legacy project-level `.agents/` config into `.deerhux/`.
 * Safe to call on every read — only copies missing role files.
 *
 * Skills are intentionally not copied here anymore. They should be displayed as
 * compatible/import-only sources by the extensions facade instead of being
 * silently duplicated into .deerhux during read flows.
 */
export function migrateProjectAgentsDir(cwd: string): { rolesCopied: boolean; skillsSynced: number } {
  const trimmed = cwd.trim();
  if (!trimmed) return { rolesCopied: false, skillsSynced: 0 };

  const agentsDir = join(trimmed, ".agents");
  if (!existsSync(agentsDir)) return { rolesCopied: false, skillsSynced: 0 };

  const deerhuxDir = join(trimmed, ".deerhux");
  mkdirSync(deerhuxDir, { recursive: true });

  const rolesCopied = copyFileIfMissing(
    join(agentsDir, "roles.json"),
    join(deerhuxDir, "roles.json"),
  );
  const skillsSynced = 0;

  if (rolesCopied) {
    console.log(
      `[init] Migrated legacy ${trimmed}/.agents → .deerhux`
      + ` (roles: ${rolesCopied ? 1 : 0})`,
    );
  }

  return { rolesCopied, skillsSynced };
}

/** Encode a cwd path the same way SessionManager stores session directories. */
export function encodeCwdForSessionDir(cwd: string): string {
  return `--${cwd.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`;
}
