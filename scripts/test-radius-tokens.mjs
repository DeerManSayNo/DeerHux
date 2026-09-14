import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import ts from 'typescript';

const tokens = new Map();
postcss.parse(readFileSync(new URL('../app/design-tokens.css', import.meta.url), 'utf8')).walkDecls(d => {
  if (d.prop.startsWith('--radius-')) tokens.set(d.prop, d.value);
});
assert.deepEqual(Object.fromEntries(tokens), {
  '--radius-small': '4px', '--radius-control': '6px', '--radius-panel': '8px',
  '--radius-composer': '12px',
  '--radius-window': '16px', '--radius-circle': '50%',
  '--radius-window-inner': 'calc(var(--radius-window) - 1px)',
});
const layout = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8');
assert.ok(layout.includes('import "./design-tokens.css"'));
const names = ['AppShell', 'ChatInput', 'ChatWindow', 'ChatWorkspace', 'SessionSidebar', 'MessageView', 'SendIconButton', 'ProjectBranch', 'ChangedFilesList'];
let checked = 0;
for (const name of names) {
  const source = readFileSync(new URL(`../components/${name}.tsx`, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(`${name}.tsx`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function visit(node) {
    if (ts.isPropertyAssignment(node) && /^border(?:TopLeft|TopRight|BottomLeft|BottomRight)?Radius$/.test(node.name.getText(ast))) {
      function check(value) {
        if (ts.isConditionalExpression(value)) { check(value.whenTrue); check(value.whenFalse); return; }
        const text = ts.isStringLiteral(value) || ts.isNumericLiteral(value) ? value.text : value.getText(ast);
        const match = /^var\((--radius-[a-z-]+)\)$/.exec(text);
        assert.ok(text === '0' || match && tokens.has(match[1]) || name === 'AppShell' && text === 'calc(18px / 2)', `${name}: unregistered radius ${text}`);
        checked++;
      }
      check(node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(!/\brounded(?:-(?:sm|md|lg|xl|2xl|full))?\b/.test(source), `${name}: use radius tokens instead of independent utility scales`);
}
for (const file of ['workbench.css', 'workspace-panel.css', 'inline-code.css', 'window-wechat.module.css', 'AiFileLinkMenu.module.css', 'MessageImagePreview.module.css', 'ui/Button.module.css', 'ui/Modal.module.css', 'ui/Form.module.css', 'MemoryConfig.module.css', 'CompactionConfirmModal.module.css']) {
  postcss.parse(readFileSync(new URL(`../components/${file}`, import.meta.url), 'utf8')).walkDecls(d => {
    if (!/^border(?:-[a-z]+)*-radius$/.test(d.prop)) return;
    const match = /^var\((--radius-[a-z-]+)\)$/.exec(d.value);
    assert.ok(match && tokens.has(match[1]), `${file}: unregistered radius ${d.value}`);
    checked++;
  });
}
const composer = readFileSync(new URL('../components/ChatInput.tsx', import.meta.url), 'utf8');
assert.match(composer, /data-chat-composer[\s\S]*?borderRadius: "var\(--radius-composer\)"/);
console.log(`Radius system: ${tokens.size} tokens and ${checked} component declarations passed.`);
