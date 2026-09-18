import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const file = fileURLToPath(new URL("../components/LazyCodeHighlighter.tsx", import.meta.url));
const source = readFileSync(file, "utf8");
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
for (const statement of ast.statements) {
  if (ts.isImportDeclaration(statement) && statement.moduleSpecifier.text.startsWith("react-syntax-highlighter")) {
    assert.ok(statement.importClause?.isTypeOnly, "Highlighter must not enter the static import graph");
  }
}
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 },
}).outputText;
const compiledModule = new Module(file);
const require = createRequire(file);
compiledModule.filename = file;
compiledModule.require = (id) => {
  if (id === "@/hooks/useTheme") return { useTheme: () => ({ isDark: true }) };
  assert.ok(!id.startsWith("react-syntax-highlighter"), "Server fallback must not load the highlighter");
  return require(id);
};
compiledModule._compile(compiled, file);
const { DeferredCodeBlock } = compiledModule.exports;
const html = renderToStaticMarkup(React.createElement(DeferredCodeBlock, {
  code: "<script>\nsecond line\n",
  language: "text",
  showLineNumbers: true,
  wrapLines: true,
  lineProps: (n) => ({ "data-search-line": String(n) }),
  customStyle: { fontSize: 13, backgroundColor: "var(--bg)" },
}));
assert.match(html, /&lt;script&gt;/);
assert.match(html, /second line/);
assert.match(html, /data-search-line="2"/);
assert.equal((html.match(/aria-hidden="true"/g) ?? []).length, 3);
assert.match(html, /font-size:13px/);
const plain = renderToStaticMarkup(React.createElement(DeferredCodeBlock, {
  code: "one", language: "text", lineProps: { className: "chat-code-line" },
}));
assert.match(plain, /class="chat-code-line"/);
assert.doesNotMatch(plain, /aria-hidden/);
console.log("lazy highlighter fallback and static import tests passed");
