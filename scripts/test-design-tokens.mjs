/**
 * 设计令牌回归：校验字号、字重、行高、阴影、层级五类令牌的定义集合，
 * 并阻止已迁移的二级窗口模块重新引入裸数值。
 * 规范见 docs/design-system.md。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import ts from 'typescript';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const tokens = new Map();
postcss.parse(read('app/design-tokens.css')).walkDecls((d) => {
  if (/^--(text|weight|leading|z)-/.test(d.prop)) tokens.set(d.prop, d.value);
});

const expected = {
  '--text-2xs': '10px',
  '--text-xs': '11px',
  '--text-sm': '12px',
  '--text-base': '13px',
  '--text-lg': '15px',
  '--text-xl': '16px',
  '--leading-tight': '1.35',
  '--leading-normal': '1.55',
  '--leading-relaxed': '1.7',
};
for (const [prop, value] of Object.entries(expected)) {
  assert.equal(tokens.get(prop), value, `${prop} 档位被改动`);
}
assert.ok(tokens.has('--weight-regular') && tokens.has('--weight-semibold'), '字重令牌缺失');
assert.ok(tokens.has('--z-window') && tokens.has('--z-modal'), '层级令牌缺失');

// 阴影与遮罩令牌按主题成对定义。
const globals = read('app/globals.css');
for (const prop of ['--shadow-control', '--shadow-popover', '--shadow-modal', '--shadow-overlay']) {
  const hits = globals.match(new RegExp(`${prop}:`, 'g')) ?? [];
  assert.ok(hits.length >= 2, `${prop} 需要在 :root 与 html.dark 成对定义`);
}
assert.ok(globals.includes('--shadow-control: var(--shadow-control)'), '@theme 未映射阴影令牌');
assert.ok(globals.includes('.app-scrollbar'), '统一滚轮类缺失');

// 令牌必须通过 @theme 暴露为 Tailwind 语义类。
const theme = globals.slice(globals.indexOf('@theme'), globals.indexOf(':root'));
for (const prop of ['--text-2xs', '--text-sm', '--text-xl', '--shadow-modal']) {
  assert.ok(theme.includes(`${prop}: var(${prop})`), `@theme 缺少 ${prop} 映射`);
}

/**
 * 已迁移的二级窗口模块：禁止裸 fontSize / fontWeight / borderRadius / zIndex，
 * 禁止硬编码色值。允许 var(--*) 与 0、1 等结构性数值。
 */
const migrated = [
  ['MemoryConfig', 'tsx'],
  ['McpConfig', 'tsx'],
  ['CompactionConfirmModal', 'tsx'],
  ['ui/Button', 'tsx'],
  ['ui/Modal', 'tsx'],
];
const migratedCss = [
  'ui/Button.module.css',
  'ui/Modal.module.css',
  'ui/Form.module.css',
  'MemoryConfig.module.css',
  'CompactionConfirmModal.module.css',
];

let checked = 0;
for (const [name, ext] of migrated) {
  const source = read(`components/${name}.${ext}`);
  const ast = ts.createSourceFile(`${name}.${ext}`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node) => {
    if (ts.isPropertyAssignment(node)) {
      const key = node.name.getText(ast);
      if (['fontSize', 'fontWeight', 'borderRadius', 'zIndex'].includes(key)) {
        const init = node.initializer;
        const text = ts.isStringLiteral(init) || ts.isNumericLiteral(init) ? init.text : init.getText(ast);
        assert.ok(
          /^var\(--/.test(text) || /^[01]$/.test(text),
          `${name}: ${key} 使用裸数值 ${text}，请引用令牌`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(source.replace(/https?:\/\/\S+/g, '')), `${name}: 存在硬编码色值`);
  assert.ok(!/rgba?\(\s*\d/.test(source), `${name}: 存在硬编码 rgba 色值`);
  checked++;
}

for (const file of migratedCss) {
  const css = read(`components/${file}`);
  const offenders = [];
  postcss.parse(css).walkDecls((d) => {
    if (/^(font-size|font-weight|line-height|border-radius|z-index)$/.test(d.prop)) {
      const ok = /^var\(--/.test(d.value) || /^(0|1|inherit|none)$/.test(d.value);
      if (!ok) offenders.push(`${d.prop}: ${d.value}`);
    }
    if (/^(background|color|border|box-shadow)$/.test(d.prop) && /#[0-9a-fA-F]{3,8}\b/.test(d.value)) {
      offenders.push(`${d.prop}: ${d.value}`);
    }
    if (/^box-shadow$/.test(d.prop) && !/^var\(--shadow-/.test(d.value) && d.value !== 'none') {
      offenders.push(`box-shadow 未引用令牌: ${d.value}`);
    }
  });
  assert.deepEqual(offenders, [], `${file}: 存在未令牌化声明`);
  checked++;
}

console.log(`Design tokens: ${tokens.size} tokens and ${checked} migrated modules passed.`);
