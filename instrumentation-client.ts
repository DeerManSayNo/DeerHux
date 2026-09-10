import { installShareDevClient } from "./lib/sharing/dev-client";

// Next runs this entry before client bootstrap/hydration. No script elements
// are rendered through React, including during client navigation/Fast Refresh.
if (process.env.NODE_ENV === "development") installShareDevClient();

try {
  const theme = localStorage.getItem("deerhux-theme") || localStorage.getItem("pi-theme");
  document.documentElement.classList.toggle("dark", theme === "dark");
} catch { /* Storage may be disabled; use the default theme. */ }
