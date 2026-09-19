"use client";

import { useEffect } from "react";

export function DisableTabNavigation() {
  useEffect(() => {
    const preventTabNavigation = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    window.addEventListener("keydown", preventTabNavigation, true);
    return () => window.removeEventListener("keydown", preventTabNavigation, true);
  }, []);

  return null;
}
