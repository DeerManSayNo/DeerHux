/**
 * Renderer-side API for the DeerHux 灵动岛 window.
 *
 * The island runs in its own Tauri webview. This module wraps the host commands
 * and event listeners so the component stays free of IPC details.
 *
 * The row/snapshot types mirror `src-tauri/src/live_island.rs`.
 */

import type { LiveIslandRow, LiveIslandRowStatus, LiveIslandScale } from "./live-island-client";
import type { LiveIslandTransportEvent } from "./host-event-bus";

export type { LiveIslandRow, LiveIslandRowStatus, LiveIslandScale };

export interface LiveIslandLayout {
  hasNotch: boolean;
  notchWidth: number;
}

export interface LiveIslandSnapshot {
  rows: LiveIslandRow[];
  scale: LiveIslandScale;
  layout: LiveIslandLayout;
  enabled: boolean;
}

export interface LiveIslandHoverPayload {
  inside: boolean;
  x: number;
  y: number;
}

export const LIVE_ISLAND_SNAPSHOT_EVENT = "live-island-snapshot-changed";
export const LIVE_ISLAND_HOVER_EVENT = "live-island-hover-changed";
export const LIVE_ISLAND_LAYOUT_EVENT = "live-island-layout-changed";
export const LIVE_ISLAND_SETTINGS_EVENT = "live-island-settings-changed";

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return null;
  try {
    const { invoke: call } = await import("@tauri-apps/api/core");
    return await call<T>(cmd, args);
  } catch {
    return null;
  }
}

/** Fire-and-forget variant for commands whose result is unused. */
async function send(cmd: string, args?: Record<string, unknown>): Promise<void> {
  await invoke(cmd, args);
}

async function listen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return () => {};
  }
  try {
    const { listen: register } = await import("@tauri-apps/api/event");
    const unlisten = await register<T>(event, (message) => handler(message.payload));
    return unlisten;
  } catch {
    return () => {};
  }
}

export function pushLiveIslandEvents(events: LiveIslandTransportEvent[]): Promise<void> {
  return send("live_island_push_events", { events });
}

export function markLiveIslandReady(): Promise<void> {
  return send("mark_live_island_ready");
}

export function listenLiveIslandSnapshot(
  handler: (snapshot: LiveIslandSnapshot) => void,
): Promise<() => void> {
  return listen<LiveIslandSnapshot>(LIVE_ISLAND_SNAPSHOT_EVENT, handler);
}

export function listenLiveIslandHover(
  handler: (payload: LiveIslandHoverPayload) => void,
): Promise<() => void> {
  return listen<LiveIslandHoverPayload>(LIVE_ISLAND_HOVER_EVENT, handler);
}

export function listenLiveIslandLayout(
  handler: (layout: LiveIslandLayout) => void,
): Promise<() => void> {
  return listen<LiveIslandLayout>(LIVE_ISLAND_LAYOUT_EVENT, handler);
}

export function setLiveIslandDrawerHeight(height: number): Promise<void> {
  return send("set_live_island_drawer_height", { drawerHeight: height });
}

export function dismissLiveIslandRow(rowId: string): Promise<void> {
  return send("dismiss_live_island_row", { rowId });
}

export function focusLiveIslandRow(rowId: string): Promise<void> {
  return send("focus_live_island_row", { rowId });
}

// ---------------------------------------------------------------------------
// Settings (used by the main window's settings menu)
// ---------------------------------------------------------------------------

export async function getLiveIslandEnabled(): Promise<boolean> {
  const value = await invoke<boolean>("get_live_island_setting_command");
  return value ?? false;
}

export function setLiveIslandEnabled(enabled: boolean): Promise<void> {
  return send("set_live_island_setting", { enabled });
}

export async function getLiveIslandScale(): Promise<LiveIslandScale> {
  const value = await invoke<LiveIslandScale>("get_live_island_scale_command");
  return value ?? "medium";
}

export function setLiveIslandScale(scale: LiveIslandScale): Promise<void> {
  return send("set_live_island_scale", { scale });
}
