import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { readRecentMessages, DEFAULT_PAGE_LIMIT } from "@/lib/session/session-messages";
import { isSessionTraceEnabled } from "@/lib/session/session-trace";

/**
 * GET /api/sessions/:id/messages?limit=100
 *
 * First-paint pagination (remediation plan §5.4 / TODO 3). Returns only the
 * most recent N messages so opening a large session is cheap; the caller can
 * then fetch the full history via the legacy GET /api/sessions/:id.
 *
 * Gated by `DEERHUX_SESSION_PAGING=1`: when disabled the caller should fall
 * back to the full GET /api/sessions/:id payload. This route still works
 * regardless of the flag, but the flag is what tells the frontend which path
 * to take.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const start = Date.now();
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const url = new URL(req.url);
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit ? Number(rawLimit) : DEFAULT_PAGE_LIMIT;

    const result = readRecentMessages(id, filePath, Number.isFinite(limit) ? limit : DEFAULT_PAGE_LIMIT);

    if (isSessionTraceEnabled()) {
      console.log(
        `[session-trace] sessionMessages id=${id} total=${Date.now() - start}ms returned=${result.page.returned} totalMessages=${result.totalCount} hasMore=${result.page.hasMoreBefore}`,
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[/api/sessions/:id/messages]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

