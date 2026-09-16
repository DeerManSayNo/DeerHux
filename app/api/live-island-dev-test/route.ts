import { hostEventBus } from "@/lib/host-event-bus";

const DEV_ROWS = ["dev-alpha", "dev-beta"] as const;

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== "development") {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const now = Date.now();
  const action = new URL(request.url).searchParams.get("action") ?? "start";

  if (action === "clear") {
    hostEventBus.emit({
      type: "live_island_events",
      updatedAt: now,
      events: DEV_ROWS.map((id) => ({ id, type: "remove" as const })),
    });
    return Response.json({ ok: true, action });
  }

  if (action === "finish") {
    hostEventBus.emit({
      type: "live_island_events",
      updatedAt: now,
      events: DEV_ROWS.map((id) => ({
        id,
        type: "done-retract" as const,
        delayMs: 1_000,
      })),
    });
    return Response.json({ ok: true, action });
  }

  hostEventBus.emit({ type: "live_island_events", updatedAt: now, events: [
    { id: "dev-alpha", type: "update", project: "DeerHux", status: "thinking", detail: "Thinking · DeerHux", prompt: "验证灵动岛", startedAt: now, lastActiveAt: now, detailStartedAt: now },
    { id: "dev-beta", type: "update", project: "并发会话", status: "reading", detail: "Read · AppShell.tsx", prompt: "验证多 session", startedAt: now - 5000, lastActiveAt: now, detailStartedAt: now }
  ] });
  return Response.json({ ok: true, action });
}
