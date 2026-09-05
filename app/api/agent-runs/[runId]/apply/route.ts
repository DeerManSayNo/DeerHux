import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  CollaborationApplyRequestError,
  applyCollaborationPatches,
  getCollaborationRun,
} from "@/lib/parallel-agent/collaboration-orchestrator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REQUEST_KEYS = new Set(["workerIds", "workerNames", "files", "idempotencyKey", "transactionId"]);

function errorResponse(requestId: string, status: number, code: string, error: string): NextResponse {
  return NextResponse.json({ requestId, code, error }, { status });
}

function validStringArray(value: unknown, options: { maxItems: number; maxLength: number; trimmed?: boolean }): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= options.maxItems
    && value.every((item) => typeof item === "string"
      && item.length > 0
      && item.length <= options.maxLength
      && (!options.trimmed || item === item.trim()))
    && new Set(value).size === value.length;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const requestId = randomUUID();
  const { runId } = await params;
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid body");
    body = parsed as Record<string, unknown>;
  } catch {
    return errorResponse(requestId, 400, "APPLY_INVALID_JSON", "Request body must be a JSON object");
  }
  if (Object.keys(body).some((key) => !REQUEST_KEYS.has(key))) {
    return errorResponse(requestId, 400, "APPLY_UNKNOWN_FIELD", "Request contains an unknown field");
  }
  if (body.workerIds !== undefined && body.workerNames !== undefined) {
    return errorResponse(requestId, 400, "APPLY_AMBIGUOUS_WORKERS", "workerIds and workerNames cannot be combined");
  }
  if (body.idempotencyKey !== undefined && body.transactionId !== undefined) {
    return errorResponse(requestId, 400, "APPLY_AMBIGUOUS_IDEMPOTENCY", "idempotencyKey and transactionId cannot be combined");
  }
  const state = getCollaborationRun(runId);
  if (!state) return errorResponse(requestId, 404, "APPLY_RUN_NOT_FOUND", "Run not found");

  let workerIds: string[];
  if (validStringArray(body.workerIds, { maxItems: 5, maxLength: 160, trimmed: true })) {
    workerIds = body.workerIds;
  } else if (validStringArray(body.workerNames, { maxItems: 5, maxLength: 120, trimmed: true })) {
    workerIds = [];
    for (const name of body.workerNames) {
      const matches = state.workers.filter((worker) => worker.name === name);
      if (matches.length !== 1) {
        return errorResponse(requestId, 400, "APPLY_WORKER_NAME_AMBIGUOUS", "A worker name is unknown or ambiguous");
      }
      workerIds.push(matches[0].workerId);
    }
    if (new Set(workerIds).size !== workerIds.length) {
      return errorResponse(requestId, 400, "APPLY_WORKER_DUPLICATE", "Worker selection contains a duplicate");
    }
  } else {
    return errorResponse(requestId, 400, "APPLY_WORKERS_INVALID", "workerIds must be a non-empty unique array");
  }

  let files: string[] | undefined;
  if (body.files !== undefined) {
    if (!validStringArray(body.files, { maxItems: 10_000, maxLength: 4_096 })) {
      return errorResponse(requestId, 400, "APPLY_FILES_INVALID", "files must be a non-empty unique array");
    }
    files = body.files;
  }
  const hasIdempotencyKey = Object.hasOwn(body, "idempotencyKey");
  const hasTransactionId = Object.hasOwn(body, "transactionId");
  const suppliedKey = hasIdempotencyKey ? body.idempotencyKey : hasTransactionId ? body.transactionId : undefined;
  if (suppliedKey !== undefined && (typeof suppliedKey !== "string" || suppliedKey.length === 0 || suppliedKey.length > 160 || suppliedKey !== suppliedKey.trim())) {
    return errorResponse(requestId, 400, "APPLY_IDEMPOTENCY_INVALID", "idempotencyKey must be a non-empty string of at most 160 characters");
  }
  const transactionId = typeof suppliedKey === "string" ? suppliedKey : randomUUID();

  try {
    const result = await applyCollaborationPatches(runId, workerIds, files, transactionId);
    const finalState = getCollaborationRun(runId);
    const status = result.outcome === "conflict" || result.outcome === "no_changes" ? 409
      : result.outcome === "precondition_failed" ? 412
        : result.outcome === "recovery_required" ? 409
          : result.outcome === "error" ? 500 : 200;
    return NextResponse.json({ requestId, ...result, runVersion: finalState?.version }, { status });
  } catch (error) {
    if (error instanceof CollaborationApplyRequestError) {
      return errorResponse(requestId, error.status, error.code, error.publicMessage);
    }
    return errorResponse(requestId, 500, "APPLY_INTERNAL", "Apply failed due to an internal error");
  }
}
