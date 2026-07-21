import { NextResponse } from "next/server";

/**
 * Safe 5xx error helper for API routes.
 *
 * Returns a generic error message to the client (never leaks internal
 * paths, stack traces, or error details) while logging the full error
 * server-side with a context tag for diagnosis.
 *
 * Usage:
 *   } catch (error) {
 *     return apiError("sessions/[id] GET", error);
 *   }
 *
 * For known business errors (4xx), keep returning explicit messages.
 */
export function apiError(context: string, error: unknown, status = 500): NextResponse {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(`[api] ${context}:`, detail);
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  return NextResponse.json(
    { error: status >= 500 ? "Internal server error" : "Request failed" },
    { status },
  );
}

/**
 * Safely stringify an error for server-side logging only.
 */
export function errorDetail(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
