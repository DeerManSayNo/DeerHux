import { NextResponse, type NextRequest } from "next/server";

/**
 * CSRF / cross-origin protection for state-changing API routes.
 *
 * - Applies only to POST / PUT / PATCH / DELETE on /api/**.
 * - GET / HEAD / OPTIONS / SSE (GET) are not affected.
 * - If `Sec-Fetch-Site: cross-site` → reject (browser cross-site request).
 * - If `Origin` header present → must match the request's own scheme + host.
 * - If no `Origin` header → allow (desktop WebView, CLI, local automation
 *   typically omit Origin; DeerHux is a local-first tool without cookie auth).
 *
 * Limitations: This is NOT a full CSRF defense based on tokens or auth.
 * It blocks clearly cross-origin browser requests. If the API later adopts
 * cookie-based authentication, switch to an explicit CSRF token or require
 * Origin unconditionally.
 */

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function middleware(req: NextRequest) {
  const method = req.method.toUpperCase();
  if (!STATE_CHANGING.has(method)) return NextResponse.next();

  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") {
    return new NextResponse("Forbidden: cross-site request", { status: 403 });
  }

  const origin = req.headers.get("origin");
  if (origin) {
    const forwardedProto = req.headers.get("x-forwarded-proto");
    const scheme = forwardedProto ?? (req.nextUrl.protocol.replace(":", ""));
    const expectedOrigin = `${scheme}://${req.headers.get("host")}`;
    if (origin !== expectedOrigin) {
      return new NextResponse("Forbidden: origin mismatch", { status: 403 });
    }
  }

  // No Origin header → allow (local desktop / CLI / WebView compatibility)
  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
