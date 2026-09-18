#!/usr/bin/env node

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

// Tauri validates production bundle resource paths even in dev mode.
for (const directory of [".next/standalone", ".next/static"]) {
  mkdirSync(resolve(root, directory), { recursive: true });
}
