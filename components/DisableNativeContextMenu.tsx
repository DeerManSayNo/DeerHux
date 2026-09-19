"use client";

import { useEffect } from "react";

export function DisableNativeContextMenu() {
  useEffect(() => {
    const preventNativeContextMenu = (event: MouseEvent) => event.preventDefault();

    window.addEventListener("contextmenu", preventNativeContextMenu, true);
    return () => window.removeEventListener("contextmenu", preventNativeContextMenu, true);
  }, []);

  return null;
}
