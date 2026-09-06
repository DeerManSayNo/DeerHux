import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { SkillCliDependency } from "./skill-cli-types";

import { cliInstallCommand } from "./skill-cli-installers.ts";

function installationUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch { return undefined; }
}

// Inspect executable files only. Skill metadata must never become shell code.
export async function hasCli(command: string, env: Readonly<Record<string, string | undefined>> = process.env, platform = process.platform): Promise<boolean> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(command)) return false;
  const win = platform === "win32";
  const pathApi = win ? path.win32 : path;
  const searchPath = env.PATH ?? env.Path ?? "";
  const dirs = searchPath.split(win ? ";" : ":").filter((dir) => pathApi.isAbsolute(dir));
  // Tavily and other per-user CLIs commonly use this directory explicitly in skills.
  if (!win) dirs.push(path.join(homedir(), ".local", "bin"));
  const extensions = win ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => /^\.[a-zA-Z0-9]+$/.test(ext)) : [""];
  const names = win && pathApi.extname(command) ? [command] : extensions.map((ext) => command + ext);
  const found = await Promise.all(dirs.map(async (dir) => {
    for (const name of names) {
      const candidate = pathApi.join(dir, name);
      try {
        if (!(await stat(candidate)).isFile()) continue;
        await access(candidate, win ? constants.F_OK : constants.X_OK);
        return true;
      } catch { /* Continue searching PATH. */ }
    }
    return false;
  }));
  return found.some(Boolean);
}

export async function readSkillCliDependencies(filePath: string): Promise<SkillCliDependency[]> {
  try {
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(await readFile(filePath, "utf8"));
    const entries = frontmatter["cli-dependencies"];
    if (!Array.isArray(entries)) return [];
    const dependencies = entries.slice(0, 20).flatMap((entry) => {
      const value = typeof entry === "string" ? { command: entry } : entry;
      if (!value || typeof value !== "object" || typeof value.command !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.command)) return [];
      return [{ command: value.command as string, installUrl: installationUrl(value["install-url"]), platforms: value.platforms as unknown }];
    });
    return await Promise.all(dependencies.map(async ({ command, installUrl, platforms }) => ({
      command,
      installUrl,
      installCommand: cliInstallCommand(command),
      status: Array.isArray(platforms) && !platforms.includes(process.platform)
        ? "unsupported" as const
        : await hasCli(command) ? "available" as const : "missing" as const,
    })));
  } catch { return []; }
}
