import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { listSessionsFromIndex } from "@/lib/session/session-index";
import { isSessionPagingEnabled } from "@/lib/session/session-messages";
import { isSessionTraceEnabled, timeSessionStep } from "@/lib/session/session-trace";

/**
 * GET /api/sessions
 *
 * Two paths (remediation plan §5.1):
 *  - `DEERHUX_SESSION_INDEX=0` → legacy: full scan via listAllSessions().
 *  - otherwise → read session-index.json (the UI query layer). A missing or
 *    stale index is returned immediately while a background rebuild runs; the
 *    UI must treat `rebuilding=true` as non-fatal.
 */
export async function GET() {
  const useLegacy = process.env.DEERHUX_SESSION_INDEX === "0";

  try {
    if (useLegacy) {
      const { value: sessions, ms } = await timeSessionStep("listSessions", () =>
        listAllSessions(),
      );
      if (isSessionTraceEnabled()) {
        console.log(
          `[session-trace] listSessions total=${ms}ms source=legacy count=${sessions.length}`,
        );
      }
      return NextResponse.json({ sessions, source: "legacy", pagingEnabled: isSessionPagingEnabled() });
    }

    const result = await listSessionsFromIndex();
    if (isSessionTraceEnabled()) {
      console.log(
        `[session-trace] listSessions total=?ms source=index count=${result.sessions.length} stale=${result.stale} rebuilding=${result.rebuilding}`,
      );
    }
    return NextResponse.json({
      sessions: result.sessions,
      stale: result.stale,
      rebuilding: result.rebuilding,
      pagingEnabled: isSessionPagingEnabled(),
      ...(result.warning ? { warning: result.warning } : {}),
      source: "index",
    });
  } catch (error) {
    // Catastrophic path: fall back to legacy scan so the sidebar still works.
    console.error("[/api/sessions] index path failed, falling back to legacy:", error);
    try {
      const sessions = await listAllSessions();
      return NextResponse.json({
        sessions,
        warning: "session index unavailable, showing legacy list",
        source: "legacy",
        pagingEnabled: isSessionPagingEnabled(),
      });
    } catch (fallbackError) {
      console.error("[/api/sessions] legacy fallback failed:", fallbackError);
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
  }
}
