import assert from "node:assert/strict";
import {
  commitMinDisplay,
  createMinDisplayState,
  reduceMinDisplay,
} from "../lib/min-display.ts";

const MIN = 800;

// 首次取值立即生效，不引入启动延迟。
{
  const state = createMinDisplayState("正在思考...");
  assert.equal(state.display, "正在思考...");
  // 与当前展示值相同的输入不触发提交。
  const same = reduceMinDisplay(state, "正在思考...", MIN, 100);
  assert.equal(same.commit, false);
  assert.equal(same.scheduleMs, null);
}

// 超过最小时长后的变化立即提交，不排队。
{
  let state = createMinDisplayState("A");
  // 模拟一次已生效的切换：lastSwitchAt=1000。
  state = reduceMinDisplay(state, "B", MIN, 1000).next;
  assert.equal(state.display, "B");

  // now=2000，距离上次切换已 1000ms > 800ms，应立即提交。
  const decision = reduceMinDisplay(state, "C", MIN, 2000);
  assert.equal(decision.commit, true);
  assert.equal(decision.next.display, "C");
  assert.equal(decision.scheduleMs, null);
}

// 最小时长窗口内的连续变化只保留最新值，窗口结束时跳到最新值。
{
  let state = createMinDisplayState("A");
  state = reduceMinDisplay(state, "B", MIN, 1000).next; // 立即提交 B
  assert.equal(state.display, "B");

  // t=1100：窗口内，挂起 C。
  const d1 = reduceMinDisplay(state, "C", MIN, 1100);
  assert.equal(d1.commit, false);
  assert.equal(d1.next.display, "B", "窗口内不得立即切换");
  assert.equal(d1.scheduleMs, 700);

  // t=1200：窗口内再次变化，覆盖 pending，展示值仍为 B。
  state = d1.next;
  const d2 = reduceMinDisplay(state, "D", MIN, 1200);
  assert.equal(d2.commit, false);
  assert.equal(d2.next.pending, "D");
  assert.equal(d2.next.display, "B");

  // 窗口结束：直接提交最新值 D，不播放中间值 C。
  const committed = commitMinDisplay(d2.next, 1800);
  assert.equal(committed.commit, true);
  assert.equal(committed.next.display, "D");
}

// 值回到当前展示值时丢弃挂起切换，避免无意义渲染。
{
  let state = createMinDisplayState("A");
  state = reduceMinDisplay(state, "B", MIN, 1000).next;
  assert.equal(state.display, "B");

  const pending = reduceMinDisplay(state, "C", MIN, 1100);
  assert.equal(pending.next.hasPending, true);

  const reverted = reduceMinDisplay(pending.next, "B", MIN, 1200);
  assert.equal(reverted.next.hasPending, false);
  assert.equal(reverted.scheduleMs, null, "回到当前值应取消计时器");

  const committed = commitMinDisplay(reverted.next, 1900);
  assert.equal(committed.commit, false, "回退后不得产生多余提交");
  assert.equal(committed.next.display, "B");
}

// pending 为 null / undefined 时仍能正确判定，不被当作“无挂起”。
{
  let state = createMinDisplayState<string | null>("A");
  state = reduceMinDisplay(state, "B", MIN, 1000).next;
  const d = reduceMinDisplay(state, null, MIN, 1100);
  assert.equal(d.commit, false);
  assert.equal(d.next.hasPending, true, "null 值必须仍标记为有挂起");
  assert.equal(d.next.pending, null);

  const committed = commitMinDisplay(d.next, 1800);
  assert.equal(committed.commit, true);
  assert.equal(committed.next.display, null);
}

// 计时器触发但无挂起值时不得提交。
{
  const state = createMinDisplayState("A");
  const committed = commitMinDisplay(state, 2000);
  assert.equal(committed.commit, false);
  assert.equal(committed.next.display, "A");
}

console.log("test-min-display: all assertions passed");
