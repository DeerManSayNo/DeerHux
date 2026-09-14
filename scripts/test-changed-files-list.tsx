import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ChangedFilesList } from "../components/ChangedFilesList";

const files = Array.from({ length: 7 }, (_, index) => `/workspace/src/file-${index + 1}.ts`);
const html = renderToStaticMarkup(<ChangedFilesList files={files} cwd="/workspace" />);

assert.match(html, /7 个文件被修改/);
assert.match(html, /file-5\.ts/);
assert.doesNotMatch(html, /file-6\.ts/);
assert.doesNotMatch(html, /file-7\.ts/);
assert.match(html, /查看更多/);
assert.match(html, /data-app-icon="more"/);

const shortHtml = renderToStaticMarkup(<ChangedFilesList files={files.slice(0, 5)} cwd="/workspace" />);
assert.match(shortHtml, /file-5\.ts/);
assert.doesNotMatch(shortHtml, /查看更多/);

console.log("changed files list rendering tests passed");
