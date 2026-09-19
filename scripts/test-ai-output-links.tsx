import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { NextRequest } from "next/server";
import { AiOutputLink, aiOutputUrlTransform } from "../components/AiOutputLink";
import { normalizeExternalHref, resolveLocalFileHref } from "../lib/external-links";
import { getRelativeFilePath } from "../lib/file-paths";
import { isLocalPathCandidate, remarkLocalFileLinks } from "../lib/remark-local-file-links";
import { POST } from "../app/api/files/validate-links/route";

for (const href of ["", "https:", "https:/example.com", "https:///example.com", "javascript:alert(1)", "data:text/html,hi", "https://exa mple.com", "https://user:pass@example.com", "https://example.com/%ZZ", "mailto:", "tel:"]) {
  assert.equal(normalizeExternalHref(href), null, href);
}
assert.equal(normalizeExternalHref("https://example.com/a?q=1#part"), "https://example.com/a?q=1#part");
assert.equal(normalizeExternalHref("//example.com/a"), "https://example.com/a");
assert.equal(resolveLocalFileHref("src/main.ts", "C:\\work\\repo"), "C:/work/repo/src/main.ts");
assert.equal(getRelativeFilePath("/workspace/project", "/workspace/project"), ".");
for (const href of ["C:/work/report.md", "file:///C:/work/report.md", "./report.md"]) {
  assert.equal(aiOutputUrlTransform(href, "href"), href);
}
assert.equal(aiOutputUrlTransform("javascript:alert(1)", "href"), "");
assert.equal(aiOutputUrlTransform("file:///secret.png", "src"), "file:///secret.png");
const markup = renderToStaticMarkup(<ReactMarkdown urlTransform={aiOutputUrlTransform} components={{ a: AiOutputLink }}>{"[empty]() [bad](javascript:alert) [web](https://example.com) [unchecked](C:/missing.md)"}</ReactMarkdown>);
assert.equal((markup.match(/<a /g) ?? []).length, 1, markup);
assert.match(markup, /<span>empty<\/span>/);
assert.match(markup, /<span>bad<\/span>/);
assert.match(markup, /<span>unchecked<\/span>/);

const autoLinkMarkup = renderToStaticMarkup(
  <ReactMarkdown
    remarkPlugins={[remarkLocalFileLinks]}
    urlTransform={aiOutputUrlTransform}
  >
    {"Read src/main.ts:12, bin/deerhux, `docs/my file.md`, and package.json. Do not link `const value = 1` or:\n\n```ts\nsrc/inside-code-block.ts\n```"}
  </ReactMarkdown>,
);
assert.match(autoLinkMarkup, /href="src\/main.ts:12"/);
assert.match(autoLinkMarkup, /href="bin\/deerhux"/);
assert.match(autoLinkMarkup, /href="docs\/my%20file.md"><code>docs\/my file.md<\/code><\/a>/);
assert.match(autoLinkMarkup, /href="package.json"/);
assert.doesNotMatch(autoLinkMarkup, /href="const value = 1"/);
assert.doesNotMatch(autoLinkMarkup, /href="src\/inside-code-block.ts"/);
assert.equal(isLocalPathCandidate("DeerHux/"), true);
assert.equal(isLocalPathCandidate("/Users/deerman/project/DeerHux"), true);
assert.equal(isLocalPathCandidate("const value = 1"), false);

const root = await fs.mkdtemp(path.join(os.tmpdir(), "deerhux-link-test-"));
const allowed = path.join(root, "allowed");
await fs.mkdir(allowed);
const file = path.join(allowed, "hello.md");
const outside = path.join(root, "outside.md");
await fs.writeFile(file, "hello");
await fs.writeFile(outside, "private");
const oldCache = globalThis.__deerhuxAllowedRootsCache;
globalThis.__deerhuxAllowedRootsCache = { roots: new Set([await fs.realpath(allowed)]), expiresAt: Date.now() + 60_000 };
const request = (paths: unknown) => new NextRequest("http://localhost/api/files/validate-links", { method: "POST", body: JSON.stringify({ paths }) });
try {
  const response = await POST(request([file, path.join(allowed, "missing.md"), outside, allowed, "relative.md", "C:/missing.md"]));
  assert.deepEqual(await response.json(), {
    valid: [true, false, false, true, false, false],
    directories: [false, false, false, true, false, false],
  });
  await fs.symlink(outside, path.join(allowed, "escape.md"));
  assert.deepEqual(await (await POST(request([path.join(allowed, "escape.md")]))).json(), { valid: [false], directories: [false] });
  assert.equal((await POST(request(Array(65).fill(file)))).status, 400);
  assert.equal((await POST(request([42]))).status, 400);
} finally {
  globalThis.__deerhuxAllowedRootsCache = oldCache;
  await fs.rm(root, { recursive: true, force: true });
}
console.log("AI link validation, Markdown rendering and file access tests passed");
