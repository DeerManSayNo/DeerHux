import { NextResponse } from "next/server";
import { appendFileSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { randomUUID } from "node:crypto";
import { join } from "path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  resolveSessionPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
  invalidateSessionFileCache,
  isLikelySubagentSession,
  forceRefreshSessionList,
  readSessionFileCached,
} from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import { updateSessionIndexName } from "@/lib/session/session-index";
import { getWorkerOrigin } from "@/lib/parallel-agent/subagent-registry";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Cached read: avoids re-parsing the entire .jsonl and re-running the
    // CPU-intensive buildSessionContext on every concurrent background
    // refresh (agent_end, polling, watchdog). Cache is keyed on
    // (path, mtimeMs, size) so any append invalidates it automatically.
    const { context, leafId, header, sessionName } = readSessionFileCached(filePath);

    let modified = header?.timestamp ?? new Date().toISOString();
    try { modified = statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
    const workerOrigin = await getWorkerOrigin(id);
    let parentSessionId: string | undefined = workerOrigin?.parentSessionId;
    let projectCwd: string | undefined;
    try {
      const firstLine = readFileSync(filePath, "utf8").split("\n", 1)[0];
      const currentHeader = JSON.parse(firstLine) as { type?: string; parentSession?: string };
      if (currentHeader.type === "session" && currentHeader.parentSession) {
        const parentFirstLine = readFileSync(currentHeader.parentSession, "utf8").split("\n", 1)[0];
        const parentHeader = JSON.parse(parentFirstLine) as { type?: string; id?: string; cwd?: string };
        if (parentHeader.type === "session" && typeof parentHeader.id === "string") {
          parentSessionId ??= parentHeader.id;
          if (workerOrigin && typeof parentHeader.cwd === "string") projectCwd = parentHeader.cwd;
        }
      }
    } catch { /* parent metadata is optional */ }
    if (workerOrigin?.parentSessionId && !projectCwd) {
      try {
        const parentPath = await resolveSessionPath(workerOrigin.parentSessionId);
        if (parentPath) {
          const parentFirstLine = readFileSync(parentPath, "utf8").split("\n", 1)[0];
          const parentHeader = JSON.parse(parentFirstLine) as { type?: string; cwd?: string };
          if (parentHeader.type === "session" && typeof parentHeader.cwd === "string") projectCwd = parentHeader.cwd;
        }
      } catch { /* display project metadata is optional */ }
    }
    const firstMessage = context.messages.find((message) => message.role === "user")
      ? (() => {
          const message = context.messages.find((item) => item.role === "user")!;
          const content = (message as { content: unknown }).content;
          return typeof content === "string"
            ? content
            : (Array.isArray(content) ? (content.find((block: { type: string }) => block.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
        })()
      : "(no messages)";
    const isSubagent = Boolean(workerOrigin) || isLikelySubagentSession({ firstMessage, cwd: header?.cwd });
    const info = header ? {
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      ...(projectCwd ? { projectCwd } : {}),
      name: sessionName,
      created: header.timestamp,
      modified,
      messageCount: context.messages.length,
      firstMessage,
      parentSessionId,
      ...(isSubagent ? { isSubagent: true } : {}),
    } : null;

    const url = new URL(req.url);
    let agentState: { running: boolean; state?: unknown } | undefined;
    if (url.searchParams.has("includeState")) {
      const rpc = getRpcSession(id);
      if (rpc?.isAlive()) {
        const state = await rpc.send({ type: "get_state" });
        agentState = { running: true, state };
      } else {
        agentState = { running: false };
      }
    }

    return NextResponse.json({
      sessionId: id,
      filePath,
      info,
      leafId,
      context,
      ...(agentState !== undefined ? { agentState } : {}),
    });
  } catch (error) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const { name } = await req.json() as { name?: string };
    if (typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const sm = SessionManager.open(filePath);
    // Metadata must persist even before the first assistant message; Pi defers it.
    appendFileSync(filePath, `${JSON.stringify({
      type: "session_info", id: randomUUID(), parentId: sm.getLeafId(),
      timestamp: new Date().toISOString(), name: name.trim(),
    })}\n`);
    invalidateSessionListCache();
    invalidateSessionFileCache(filePath);
    await updateSessionIndexName(id, name.trim());
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/sessions/[id]
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Read header before deleting to get parentSession path
    const firstLine = readFileSync(filePath, "utf8").split("\n")[0];
    let parentSessionPath: string | undefined;
    try {
      const header = JSON.parse(firstLine) as { type?: string; parentSession?: string };
      if (header.type === "session") parentSessionPath = header.parentSession;
    } catch { /* ignore */ }

    // Re-attach all direct children to this session's parent (cascade re-parent)
    // Scan sibling files in the same directory
    const dir = filePath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
    try {
      const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl") && join(dir, f) !== filePath);
      for (const file of files) {
        const childPath = join(dir, file);
        try {
          const content = readFileSync(childPath, "utf8");
          const lines = content.split("\n");
          const header = JSON.parse(lines[0]) as { type?: string; parentSession?: string };
          if (header.type === "session" && header.parentSession === filePath) {
            // Rewrite header with new parentSession
            header.parentSession = parentSessionPath;
            lines[0] = JSON.stringify(header);
            writeFileSync(childPath, lines.join("\n"));
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* skip if dir unreadable */ }

    getRpcSession(id)?.destroy();
    unlinkSync(filePath);
    try {
      const { deleteContextArchive } = await import("@/lib/engine/context-archive");
      deleteContextArchive(id);
    } catch {
      /* ignore archive cleanup errors */
    }
    invalidateSessionPathCache(id);
    invalidateSessionFileCache(filePath);
    forceRefreshSessionList();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
