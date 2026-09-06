import { readdir, realpath, readFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findNpmCli } from "./skill-cli-install";
import type { SystemCli } from "./system-cli-types";
const execute = promisify(execFile);

async function npmContext() {
  const cli = await findNpmCli();
  const options = { cwd: homedir(), timeout: 15_000, maxBuffer: 1024 * 1024 };
  const [rootResult, prefixResult] = await Promise.all([
    execute(process.execPath, [cli, "root", "--global"], options),
    execute(process.execPath, [cli, "prefix", "--global"], options),
  ]);
  return { cli, root: rootResult.stdout.trim(), prefix: prefixResult.stdout.trim() };
}

function manifestCommands(pkg: Record<string, unknown>, packageName: string): string[] {
  const bins = typeof pkg.bin === "string" ? { [packageName.split("/").pop()!]: pkg.bin }
    : pkg.bin && typeof pkg.bin === "object" && !Array.isArray(pkg.bin) ? pkg.bin : {};
  return Object.entries(bins).filter(([name, target]) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) && typeof target === "string" && target.length > 0).map(([name]) => name).sort();
}

async function bundledExtensionClis(packageDir: string, pkg: Record<string, unknown>): Promise<NonNullable<SystemCli["bundledClis"]>> {
  // Extension packages can expose their own CLI dependency through the session PATH.
  // Inspect declared runtime dependencies only, not transitive build tools or peers.
  const pi = pkg.pi;
  if (!pi || typeof pi !== "object" || !("extensions" in pi) || !Array.isArray(pi.extensions) || !pi.extensions.length) return [];
  const names = new Set<string>();
  for (const dependencies of [pkg.dependencies, pkg.optionalDependencies]) {
    if (dependencies && typeof dependencies === "object" && !Array.isArray(dependencies)) {
      for (const name of Object.keys(dependencies)) names.add(name);
    }
  }
  const result: NonNullable<SystemCli["bundledClis"]> = [];
  for (const name of names) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)) continue;
    try {
      const dependency = JSON.parse(await readFile(path.join(packageDir, "node_modules", name, "package.json"), "utf8")) as Record<string, unknown>;
      if (dependency.name !== name) continue;
      const commands = manifestCommands(dependency, name);
      if (commands.length) result.push({ packageName: name, version: typeof dependency.version === "string" ? dependency.version : undefined, commands });
    } catch { /* Optional dependencies may not be installed on this platform. */ }
  }
  return result;
}

// Read npm's global package inventory, including scoped and npm-link packages.
// One row per owning global package, including CLIs bundled by Pi extensions.
export async function scanNpmCliPackages(root: string): Promise<SystemCli[]> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      try {
        for (const child of await readdir(path.join(root, entry.name))) names.push(`${entry.name}/${child}`);
      } catch { /* Ignore a scope that disappeared while scanning. */ }
    } else names.push(entry.name);
  }
  const result: SystemCli[] = [];
  for (const packageName of names) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(packageName)) continue;
    const packageDir = path.join(root, packageName);
    try {
      const pkg = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8")) as Record<string, unknown>;
      if (pkg.name !== packageName) continue;
      const ownCommands = manifestCommands(pkg, packageName);
      const bundledClis = await bundledExtensionClis(packageDir, pkg);
      const commands = [...new Set([...ownCommands, ...bundledClis.flatMap((cli) => cli.commands)])].sort();
      if (!commands.length) continue;
      const removable = !["npm", "corepack", "deerhux"].includes(packageName);
      result.push({
        path: packageDir, realPath: await realpath(packageDir), name: commands[0], source: "npm",
        packageName, version: typeof pkg.version === "string" ? pkg.version : undefined, commands, removable, bundledClis: bundledClis.length ? bundledClis : undefined,
        reason: removable ? undefined : "DeerHux 的运行与安装工具，不支持在此删除。",
      });
    } catch { /* Ignore incomplete packages while npm is installing or removing. */ }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listSystemClis(): Promise<SystemCli[]> {
  const npm = await npmContext();
  return scanNpmCliPackages(npm.root);
}

async function removeSystemCliNow(file: string, expectedRealPath: string, expectedPackage?: string): Promise<string> {
  const npm = await npmContext();
  const items = await scanNpmCliPackages(npm.root);
  const item = items.find((entry) => entry.path === file);
  if (!item?.removable || item.realPath !== expectedRealPath || item.packageName !== expectedPackage) {
    throw new Error("CLI 已变化或不允许删除，请刷新列表后重试。");
  }
  const result = await execute(process.execPath, [npm.cli, "uninstall", "--global", "--prefix", npm.prefix, item.packageName], { cwd: homedir(), timeout: 300_000, maxBuffer: 2 * 1024 * 1024 });
  return result.stdout + result.stderr;
}

const removalState = globalThis as typeof globalThis & { deerhuxCliRemovalPending?: boolean };
export async function removeSystemCli(file: string, expectedRealPath: string, expectedPackage?: string): Promise<string> {
  if (removalState.deerhuxCliRemovalPending) throw new Error("另一个 CLI 正在删除，请稍后重试。");
  removalState.deerhuxCliRemovalPending = true;
  try { return await removeSystemCliNow(file, expectedRealPath, expectedPackage); }
  finally { removalState.deerhuxCliRemovalPending = false; }
}
