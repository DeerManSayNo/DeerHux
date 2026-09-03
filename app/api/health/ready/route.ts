import {
  checkRuntimeReadiness,
  getReadinessErrorPayload,
} from "@/lib/runtime-readiness";

export const dynamic = "force-dynamic";

const READINESS_HEADERS = {
  "Cache-Control": "no-store",
  "X-DeerHux-Ready": "1",
};

export async function GET() {
  try {
    const result = await checkRuntimeReadiness();
    return Response.json(result, { headers: READINESS_HEADERS });
  } catch (error) {
    const payload = getReadinessErrorPayload(error);
    console.error("[/api/health/ready] runtime self-check failed:", error);
    return Response.json(payload, {
      status: 503,
      headers: {
        ...READINESS_HEADERS,
        "X-DeerHux-Readiness-Code": payload.code,
      },
    });
  }
}
