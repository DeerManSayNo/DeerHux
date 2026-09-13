const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, 'verify-message-css.js'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../app/globals.css'), 'utf8');
const selectors = [
  '.user-message-prompt-icon', '.user-message-time', '.assistant-message-meta',
  '.user-message[data-hovered]', '.assistant-message[data-hovered]', '.assistant-message[data-streaming]',
].map(selector => `${selector}{display:block}`).join('\n');
function verify(theme) {
  vm.runInNewContext(script, {
    __dirname,
    console: { log() {} },
    require(name) {
      if (name === 'node:fs') return {
        readdirSync: () => [{ name: 'theme.css', isDirectory: () => false }],
        readFileSync: file => file.endsWith('globals.css') ? source : selectors + theme,
      };
      return require(name);
    },
  });
}
assert.doesNotThrow(() => verify(':root{--accent:#b94708}html.dark{--accent:#ff9a5c}'));
assert.throws(() => verify(':root{--accent:#2563eb}html.dark{--accent:#60a5fa}'), /accent is stale/);
assert.throws(() => verify(':root{--accent:#b94708}'), /missing light\/dark/);
assert.throws(() => verify(':root{--accent:#b94708}html.dark{--accent:#ff9a5c}html.dark{--accent:#60a5fa}'), /accent is stale/);
console.log('Production theme gate: current, stale, missing and mixed CSS fixtures passed.');
