import { Readable } from "node:stream";
import {
  MAX_INLINE_DIFF_BYTES,
  verifyWorktreeDiff,
  WorktreeDiffError,
} from "@/lib/parallel-agent/worktree-diff";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

function errorResponse(error: WorktreeDiffError): Response {
  return Response.json({ error: error.code }, { status: error.status, headers: NO_STORE_HEADERS });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { runId } = await params;
  const url = new URL(request.url);
  const workerId = url.searchParams.get("workerId") ?? "";
  const requestedFormat = url.searchParams.get("format") ?? "summary";
  const format = url.searchParams.get("download") === "1" ? "download" : requestedFormat;
  if (!workerId || !["summary", "patch", "download"].includes(format)) {
    return errorResponse(new WorktreeDiffError("DIFF_INVALID_REQUEST", 400));
  }

  try {
    const verified = await verifyWorktreeDiff(runId, workerId, format !== "summary");
    if (format === "summary") return Response.json(verified.summary, { headers: NO_STORE_HEADERS });
    if (verified.handle === null || verified.artifactPath === null || !verified.summary.artifact?.available) {
      return errorResponse(new WorktreeDiffError("DIFF_NOT_CAPTURED", 409));
    }
    if (format === "patch" && verified.summary.artifact.bytes > MAX_INLINE_DIFF_BYTES) {
      await verified.handle.close();
      return errorResponse(new WorktreeDiffError("DIFF_TOO_LARGE", 413));
    }

    const disposition = format === "download" ? "attachment" : "inline";
    const fileName = `deerhux-${verified.summary.artifact.sha256.slice(0, 16)}.patch`;
    const responseHeaders = {
      ...NO_STORE_HEADERS,
      "Content-Type": "text/x-diff; charset=utf-8",
      "Content-Length": String(verified.summary.artifact.bytes),
      "Content-Disposition": `${disposition}; filename="${fileName}"`,
      "X-Content-Type-Options": "nosniff",
    };
    if (verified.summary.artifact.bytes === 0) {
      await verified.handle.close();
      return new Response(new Uint8Array(0), { headers: responseHeaders });
    }
    const nodeStream = verified.handle.createReadStream({
      autoClose: true,
      start: 0,
      end: verified.summary.artifact.bytes - 1,
    });
    return new Response(Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>, {
      headers: responseHeaders,
    });
  } catch (error) {
    if (error instanceof WorktreeDiffError) return errorResponse(error);
    return errorResponse(new WorktreeDiffError("DIFF_ARTIFACT_REJECTED", 409));
  }
}
