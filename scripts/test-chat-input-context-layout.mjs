import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const input = readFileSync(new URL("../components/ChatInput.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../components/chat-surface.css", import.meta.url), "utf8");

for (const marker of [
  "data-chat-input",
  "data-chat-skill-row",
  "data-chat-project-skills",
  "data-chat-file-references",
  "data-chat-context-chip",
]) {
  assert.match(input, new RegExp(marker));
}

assert.match(input, /containerType: "inline-size"/);
assert.match(input, /containerName: "chat-input"/);
assert.match(styles, /@container chat-input \(max-width: 620px\)/);
assert.match(styles, /\[data-chat-skill-row\][\s\S]*?flex-direction: column !important/);
assert.match(styles, /\[data-chat-file-references\][\s\S]*?overflow-x: auto !important/);
assert.match(styles, /\[data-chat-file-references\][\s\S]*?flex-direction: row !important/);

const previewSource = input.slice(
  input.indexOf("function attachedImagePreviewSource"),
  input.indexOf("interface ModelOption"),
);
assert.ok(previewSource.indexOf("image.fileUrl") < previewSource.indexOf("image.data"));
assert.ok(previewSource.indexOf("image.data") < previewSource.indexOf("image.previewUrl"));
assert.match(previewSource, /previewUrl\.startsWith\("blob:"\)/);
assert.match(input, /previewUrl: "", filePath: result\.path, fileUrl: result\.url/);

console.log("chat input context layout tests passed");
