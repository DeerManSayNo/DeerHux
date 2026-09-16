import { LiveIslandWindow } from "@/components/LiveIslandWindow";

export const dynamic = "force-dynamic";

/**
 * Route rendered inside the transparent, always-on-top 灵动岛 window.
 * The Tauri host navigates this webview here once the backend is ready.
 */
export default function LiveIslandPage() {
  return <LiveIslandWindow />;
}
