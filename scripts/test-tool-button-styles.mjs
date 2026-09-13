import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';

const css = readFileSync(new URL('../components/tool-buttons.css', import.meta.url), 'utf8');
const root = postcss.parse(css);
for (const [property, expected] of [['background', 'transparent'], ['border', '0'], ['box-shadow', 'none']]) {
  let found = false;
  root.walkDecls(property, declaration => {
    found = true;
    assert.equal(declaration.value, expected);
    assert.equal(declaration.important, true);
  });
  assert.ok(found, `${property} reset missing`);
}
assert.ok(css.includes('[aria-pressed="true"]'));
assert.ok(css.includes('[aria-expanded="true"]'));
assert.ok(css.includes(':active:not(:disabled)'));
assert.ok(css.includes(':focus-visible'));
assert.ok(!css.includes('.sidebar-session-item'));
assert.ok(!css.includes('.window-controls'));
const app = readFileSync(new URL('../components/AppShell.tsx', import.meta.url), 'utf8');
assert.ok(app.includes('import "./tool-buttons.css"'));
const send = readFileSync(new URL('../components/SendIconButton.tsx', import.meta.url), 'utf8');
assert.ok(send.includes('data-active={hasContent}'));
assert.ok(send.includes('background: "transparent"'));
console.log('Tool buttons: transparent surfaces, semantic states, focus and scoped adoption passed.');
