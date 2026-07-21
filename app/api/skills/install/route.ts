import { NextResponse } from "next/server";
import { homedir } from "os";
import { runNpx } from "@/lib/npx";
import { syncSkillsFromPiToDeerhux } from "@/lib/legacy-migration";

export const dynamic = "force-dynamic";

const ANSI_RE = /\x1B\[[0-9;]*m/g;

// POST /api/skills/install  body: { package: string; scope: "global" | "project"; cwd?: string }
export async function POST(req: Request) {
  try {
    const { package: pkg, scope, cwd } = await req.json() as { package?: string; scope?: string; cwd?: string };
    if (!pkg?.trim()) return NextResponse.json({ error: "package required" }, { status: 400 });

    const isGlobal = scope !== "project";
    // skills CLI only knows the legacy "pi" agent id; installs land under .pi paths.
    const args = ["skills", "add", pkg.trim(), "-y", "--agent", "pi"];
    if (isGlobal) args.push("-g");

    console.log(`[skills/install] running: npx ${args.join(" ")}`);
    const { stdout, stderr } = await runNpx(args, {
      timeout: 60000,
      cwd: !isGlobal && cwd ? cwd : undefined,
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    const output = (stdout + stderr).replace(ANSI_RE, "");
    const success = /Installation complete|Installed \d+ skill/.test(output);
    if (!success) {
      console.error("[skills/install] install failed, full output:", output);
      return NextResponse.json({ error: output.slice(-100) || "Install failed" }, { status: 500 });
    }

    const synced = syncSkillsFromPiToDeerhux(homedir(), {
      isGlobal,
      cwd: !isGlobal && cwd ? cwd : undefined,
    });
    if (synced > 0) {
      console.log(`[skills/install] relocated ${synced} skill(s) from .pi → .deerhux`);
    }

    return NextResponse.json({ success: true, output, synced });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const output = ((err.stdout ?? "") + (err.stderr ?? "")).replace(ANSI_RE, "");
    console.error("[api/skills/install] error:", e, "output:", output);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
