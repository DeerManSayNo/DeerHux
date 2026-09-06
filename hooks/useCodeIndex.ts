"use client";

import { useEffect } from "react";

/** Start indexing when a project is opened, including unsent draft sessions. */
export function useCodeIndex(cwd: string | null | undefined): void {
  useEffect(() => {
    if (!cwd) return;
    const controller = new AbortController();
    const ensure = () => {
      void fetch("/api/index/ensure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd }),
        signal: controller.signal,
      }).catch(() => { /* A later heartbeat or session startup retries. */ });
    };
    ensure();
    const heartbeat = setInterval(ensure, 60_000);
    return () => { clearInterval(heartbeat); controller.abort(); };
  }, [cwd]);
}
