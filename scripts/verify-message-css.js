#!/usr/bin/env node
// Fail before packaging when production CSS and MessageView have drifted.
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..", process.env.DEERHUX_BUILD_DIR || ".next", "static");
function collect(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? collect(file) : file.endsWith(".css") ? [fs.readFileSync(file, "utf8")] : [];
  });
}
const css = collect(root).join("\n");
for (const selector of [
  ".user-message-prompt-icon",
  ".user-message-time",
  ".assistant-message-meta",
  ".user-message[data-hovered]",
  ".assistant-message[data-hovered]",
  ".assistant-message[data-streaming]",
]) {
  if (!css.includes(selector)) throw new Error(`Production message CSS missing: ${selector}`);
}
const postcss = require("postcss");
const expectedTheme = new Map();
postcss.parse(fs.readFileSync(path.resolve(__dirname, "../app/globals.css"), "utf8")).walkRules(rule => {
  if (rule.selector !== ":root" && rule.selector !== "html.dark") return;
  rule.nodes.forEach(node => {
    if (node.type === "decl" && node.prop === "--accent") expectedTheme.set(rule.selector, node.value.toLowerCase());
  });
});
const found = new Set();
postcss.parse(css).walkRules(rule => {
  for (const [selector, value] of expectedTheme) {
    if (!rule.selector.split(",").map(part => part.trim()).includes(selector)) continue;
    rule.nodes.forEach(node => {
      if (node.type !== "decl" || node.prop !== "--accent") return;
      if (node.value.toLowerCase() !== value) throw new Error(`Production ${selector} accent is stale: ${node.value}, expected ${value}`);
      found.add(selector);
    });
  }
});
if (found.size !== 2) throw new Error("Production CSS missing light/dark accent tokens");
console.log("Production message CSS and theme accents verified.");
