import assert from "node:assert/strict";
import { animatePromptScroll, easeOutPromptScroll, getPromptScrollDuration } from "../lib/chat-scroll-animation.ts";

assert.equal(easeOutPromptScroll(0), 0);
assert.equal(easeOutPromptScroll(1), 1);
assert.equal(easeOutPromptScroll(-1), 0);
assert.equal(easeOutPromptScroll(2), 1);
const increments = [0.25, 0.5, 0.75, 1].map(t => easeOutPromptScroll(t) - easeOutPromptScroll(t - 0.25));
for (let i = 1; i < increments.length; i++) assert.ok(increments[i] < increments[i - 1]);
assert.equal(getPromptScrollDuration(0), 700);
assert.equal(getPromptScrollDuration(100000), 1200);
assert.equal(getPromptScrollDuration(-500), getPromptScrollDuration(500));

const originalRequest = globalThis.requestAnimationFrame;
const originalCancel = globalThis.cancelAnimationFrame;
const frames = new Map<number, FrameRequestCallback>();
let id = 0;
globalThis.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
globalThis.cancelAnimationFrame = key => { frames.delete(key); };
function tick(time: number) {
  const callbacks = [...frames.values()];
  frames.clear();
  callbacks.forEach(callback => callback(time));
}
const container = {
  scrollTop: 0,
  scrollTo(options: ScrollToOptions) {
    assert.equal(options.behavior, "instant");
    this.scrollTop = options.top ?? this.scrollTop;
  },
};
const element = container as unknown as HTMLElement;
try {
  animatePromptScroll(element, 800, false);
  const duration = getPromptScrollDuration(800);
  tick(0);
  tick(duration / 2);
  assert.equal(container.scrollTop, 700);
  tick(duration);
  assert.equal(container.scrollTop, 800);
  assert.equal(frames.size, 0);

  const cancel = animatePromptScroll(element, 0, false);
  tick(0);
  tick(100);
  const paused = container.scrollTop;
  const stale = [...frames.values()][0];
  cancel();
  stale(500);
  assert.equal(container.scrollTop, paused);
  assert.equal(frames.size, 0);

  animatePromptScroll(element, 200, true);
  assert.equal(container.scrollTop, 200);
  assert.equal(frames.size, 0);
  animatePromptScroll(element, 200, false);
  assert.equal(frames.size, 0);
  animatePromptScroll(element, 0, false);
  tick(0);
  tick(1200);
  assert.equal(container.scrollTop, 0);
} finally {
  globalThis.requestAnimationFrame = originalRequest;
  globalThis.cancelAnimationFrame = originalCancel;
}
console.log("Prompt animation: deceleration, duration, endpoints, cancellation and reduced motion passed.");
