import { NextResponse } from "next/server";
import { existsSync, readdirSync, rmSync, unlinkSync } from "fs";
import { dirname } from "path";
import {
  listAllSessions,
  forceRefreshSessionList,
  invalidateSessionPathCache,
} from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import { readProjectMeta, writeProjectMeta } from "@/lib/project-meta";

// POST /api/projects/clear-sessions  body: { cwd }
//
// Permanently deletes ALL session files belonging to a project cwd and cleans
// up the now-empty encoded directory. This is destructive and cannot be undone
// — unlike "删除项目引入" which only hides the project.
//
// Also strips the cwd from project-meta (hidden/pinned/custom/notes) since a
// project with zero sessions will naturally disappear from the sidebar.
export async function POST(req: Request) {
  try {
    const { cwd } = (await req.json()) as { cwd?: string };
    if (typeof cwd !== "string" || !cwd.trim()) {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }

    const all = await listAllSessions();
    const targets = all.filter((s) => s.cwd === cwd);

    const deletedIds: string[] = [];
    const deletedDirs = new Set<string>();

    for (const s of targets) {
      try {
        getRpcSession(s.id)?.destroy();
      } catch {
        /* ignore wrapper cleanup errors */
      }
      try {
        unlinkSync(s.path);
        deletedIds.push(s.id);
        deletedDirs.add(dirname(s.path));
        invalidateSessionPathCache(s.id);
        try {
          const { deleteContextArchive } = await import("@/lib/engine/context-archive");
          deleteContextArchive(s.id);
        } catch {
          /* ignore archive cleanup */
        }
      } catch {
        /* ignore missing file */
      }
    }

    // Remove encoded-cwd directories that are now empty (no remaining .jsonl).
    for (const dir of deletedDirs) {
      try {
        if (!existsSync(dir)) continue;
        const remaining = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
        if (remaining.length === 0) {
          rmSync(dir, { recursive: true, force: true });
        }
      } catch {
        /* ignore */
      }
    }

    forceRefreshSessionList();

    // Drop the cwd from project-meta so it doesn't linger as a stale entry.
    try {
      const meta = readProjectMeta();
      writeProjectMeta({
        ...meta,
        hiddenCwds: meta.hiddenCwds.filter((c) => c !== cwd),
        pinnedCwds: meta.pinnedCwds.filter((c) => c !== cwd),
        customCwds: meta.customCwds.filter((c) => c !== cwd),
        notes: Object.fromEntries(
          Object.entries(meta.notes).filter(([c]) => c !== cwd)
        ),
      });
    } catch {
      /* ignore meta cleanup errors */
    }

    return NextResponse.json({
      ok: true,
      deletedCount: deletedIds.length,
      deletedIds,
    });
  } catch (error) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
