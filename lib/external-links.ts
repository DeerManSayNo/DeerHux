"use client";

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const WINDOWS_ABSOLUTE_PATH_RE = /^[a-zA-Z]:[\\/]/;
const COMMON_POSIX_ROOT_RE = /^\/(?:Users|home|Volumes|private|tmp|workspace|mnt)(?:\/|$)/;

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function normalizeExternalHref(href: string): string | null {
  if (typeof window === "undefined") return null;

  const trimmed = href.trim();
  // A leading slash is a filesystem path in agent output, but `new URL()` would
  // otherwise turn it into http://<deerhux-host>/<path>.
  if (!/^(?:https?:|mailto:|tel:|\/\/)/i.test(trimmed)) return null;

  try {
    const url = new URL(trimmed, window.location.href);
    return EXTERNAL_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function normalizeLocalFileHref(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;

  // Also recover links that were copied after an older DeerHux version had
  // already resolved `/Users/...` against the app origin.
  if (/^https?:\/\//i.test(trimmed) && typeof window !== "undefined") {
    try {
      const url = new URL(trimmed);
      if (url.origin === window.location.origin && COMMON_POSIX_ROOT_RE.test(url.pathname)) {
        return decodeURIComponent(url.pathname);
      }
    } catch {
      return null;
    }
  }

  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    try {
      return decodeURIComponent(trimmed);
    } catch {
      return trimmed;
    }
  }

  if (WINDOWS_ABSOLUTE_PATH_RE.test(trimmed) || trimmed.startsWith("\\\\")) {
    return trimmed;
  }

  if (/^file:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.protocol !== "file:") return null;
      const decodedPath = decodeURIComponent(url.pathname);
      if (/^\/[a-zA-Z]:\//.test(decodedPath)) return decodedPath.slice(1);
      return url.host ? `//${url.host}${decodedPath}` : decodedPath;
    } catch {
      return null;
    }
  }

  return null;
}

export async function openLocalFileLink(href: string): Promise<boolean> {
  const filePath = normalizeLocalFileHref(href);
  if (!filePath) return false;

  try {
    const response = await fetch("/api/files/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return true;
  } catch (error) {
    console.warn("Failed to open local file with the default app:", error);
    return false;
  }
}

export async function openExternalLink(href: string): Promise<boolean> {
  const target = normalizeExternalHref(href);
  if (!target || typeof window === "undefined") return false;

  if (window.__TAURI_INTERNALS__) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("plugin:shell|open", { path: target });
      return true;
    } catch (error) {
      console.warn("Failed to open external link via Tauri shell:", error);
    }
  }

  const opened = window.open(target, "_blank", "noopener,noreferrer");
  if (opened) opened.opener = null;
  return true;
}
