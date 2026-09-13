import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import postcss from "postcss";
import { getChatMessageScrollTop } from "../lib/chat-message-scroll.ts";

function targetTop({ scrollTop = 500, containerTop = 120, messageTop = 320,
  clientTop = 1, scrollHeight = 2000, clientHeight = 600, belongs = true } = {}) {
  const container = {
    scrollTop, clientTop, scrollHeight, clientHeight,
    contains: () => belongs,
    getBoundingClientRect: () => ({ top: containerTop }),
  } as unknown as HTMLElement;
  const message = { getBoundingClientRect: () => ({ top: messageTop }) } as HTMLElement;
  return getChatMessageScrollTop(container, message);
}
assert.equal(targetTop(), 701);
assert.equal(targetTop({ containerTop: -100, messageTop: 100 }), 701);
assert.equal(targetTop({ messageTop: -700 }), 0);
assert.equal(targetTop({ messageTop: 5000 }), 1400);
assert.equal(targetTop({ scrollHeight: 300 }), 0);
assert.equal(targetTop({ belongs: false }), null);

// A short final response cannot reach start alignment: move up, never add space or stay clamped.
assert.equal(targetTop({ scrollTop: 1400, messageTop: 150 }), 1398);
assert.equal(targetTop({ scrollTop: 1399, messageTop: 150 }), 1397);
assert.equal(targetTop({ scrollTop: 1500, messageTop: 150 }), 1398);
assert.equal(targetTop({ scrollTop: 1, scrollHeight: 601, messageTop: 150 }), 0);
// Away from the end, use the reachable limit; reachable targets retain normal alignment.
assert.equal(targetTop({ scrollTop: 900, messageTop: 900 }), 1400);
assert.equal(targetTop({ scrollTop: 1400, messageTop: 100 }), 1381);

// Landing must cross the existing viewport threshold, even after pixel rounding.
for (const scrollTop of [0, 500, 1000]) {
  for (const messageTop of [319.4, 320, 320.6]) {
    const top = targetTop({ scrollTop, messageTop })!;
    const landedTop = messageTop - (Math.round(top) - scrollTop);
    assert.ok(landedTop < 121, "prompt must move past the inner viewport top");
    assert.ok(landedTop + 40 > 121, "prompt body must remain visible for backward traversal");
  }
}
const chat = readFileSync(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
const callback = chat.slice(chat.indexOf("const scrollToPinnedUserMsg ="), chat.indexOf("const isNearBottom ="));
assert.ok(callback.includes("getChatMessageScrollTop(container, message)"));
assert.ok(callback.includes("setAutoScroll(false)"));
assert.ok(callback.includes("prevScrollTopRef.current = container.scrollTop"));
assert.ok(callback.includes('window.matchMedia("(prefers-reduced-motion: reduce)").matches'));
assert.ok(callback.includes('animatePromptScroll(container, top,'));
assert.ok(callback.includes('cancelPromptScroll();'));
assert.ok(!callback.includes("setPinnedUserMsgIdx"), "click must not force a prompt change");
assert.ok(!callback.includes(".scrollIntoView("));
assert.ok(!chat.includes("promptNavigationActiveRef"));
assert.ok(!chat.includes("getPromptNavigationStep"));
assert.ok(chat.includes("isContentMovingDown && !shouldAutoScrollRef.current"));
assert.ok(chat.includes("if (nearBottom && !isPausedBackwardScroll)"));
const css = postcss.parse(readFileSync(new URL("../components/workbench.css", import.meta.url), "utf8"));
let decorationRules = 0;
css.walkRules(rule => {
  if (![".deer-workbench::before", ".deer-workbench > .sidebar-container::before"].includes(rule.selector)) return;
  const declarations = new Map<string, string>();
  rule.walkDecls(decl => { declarations.set(decl.prop, decl.value); });
  assert.equal(declarations.get("max-height"), "100%");
  assert.equal(declarations.get("background-size"), "360px 900px");
  decorationRules++;
});
assert.equal(decorationRules, 2);
console.log("Message navigation: viewport threshold, rounding, bounds, scroll-only clicks and clipped decoration passed.");
