import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const file = new URL("../components/AppIcon.tsx", import.meta.url);
const source = readFileSync(file, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
}).outputText;
const exports = {};
runInNewContext(compiled, { exports, require: createRequire(file) });
const { AppIcon, APP_ICON_SIZES } = exports;
const ast = ts.createSourceFile("AppIcon.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let names = [];
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "icons") {
    names = node.initializer.expression.properties.map(property => property.name.text);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(names.length >= 30);
for (const name of names) {
  for (const [size, pixels] of Object.entries(APP_ICON_SIZES)) {
    const html = renderToStaticMarkup(React.createElement(AppIcon, { name, size }));
    assert.ok(html.includes(`width="${pixels}"`) && html.includes(`height="${pixels}"`), `${name}: size`);
    assert.ok(html.includes('viewBox="0 0 24 24"'), `${name}: viewBox`);
    assert.ok(html.includes('stroke-width="1.75"'), `${name}: stroke`);
    assert.ok(html.includes('aria-hidden="true"'), `${name}: decorative semantics`);
    assert.ok(html.includes('focusable="false"'), `${name}: focus`);
  }
}
const status = renderToStaticMarkup(React.createElement(AppIcon, { name: "pin", label: "Pinned" }));
assert.ok(status.includes('role="img"') && status.includes('aria-label="Pinned"'));
assert.ok(!status.includes('aria-hidden="true"'));
for (const name of ["AppShell", "SessionSidebar", "ChatInput", "ChatWorkspace", "WorkspaceExplorer", "SendIconButton", "WindowWeChatButton"]) {
  const text = readFileSync(new URL(`../components/${name}.tsx`, import.meta.url), "utf8");
  assert.ok(!/<svg\b/.test(text), `${name}: use AppIcon for interface icons`);
}
console.log(`${names.length} icons x 4 sizes passed; standalone semantics and 7 migrated modules passed`);
