import assert from 'node:assert/strict';
import fs from 'node:fs';
import postcss from 'postcss';

const root = postcss.parse(['../app/globals.css', '../components/inline-code.css']
  .map(file => fs.readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n'));
const themes = new Map();
root.walkRules(rule => {
  if (![':root', 'html.dark'].includes(rule.selector)) return;
  const tokens = themes.get(rule.selector) ?? {};
  rule.walkDecls(decl => { tokens[decl.prop] = decl.value; });
  themes.set(rule.selector, tokens);
});
function luminance(color) {
  const rgb = color.startsWith('#')
    ? color.slice(1).match(/../g).map(value => parseInt(value, 16))
    : color.match(/[\d.]+/g).map(Number);
  return rgb.map(value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}
assert.equal(themes.size, 2);
for (const [theme, tokens] of themes) {
  const pairs = [['text', 'inline-code-bg']];
  for (const text of ['text', 'text-muted', 'text-dim', 'accent']) {
    for (const surface of ['bg', 'bg-panel', 'bg-selected']) pairs.push([text, surface]);
  }
  pairs.push(['accent-foreground', 'accent'], ['accent-foreground', 'accent-hover'], ['action-foreground', 'action'], ['action-foreground', 'action-hover']);
  for (const status of ['success', 'warning', 'danger', 'info']) pairs.push([status, `${status}-bg`]);
  for (const [foreground, background] of pairs) {
    const a = luminance(tokens[`--${foreground}`]);
    const b = luminance(tokens[`--${background}`]);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    assert.ok(ratio >= 4.5, `${theme} ${foreground}/${background}: ${ratio.toFixed(2)}`);
  }
  console.log(`${theme}: ${pairs.length} color pairs meet 4.5:1`);
}
