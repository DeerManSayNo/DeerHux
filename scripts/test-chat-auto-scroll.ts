import assert from "node:assert/strict";
import {
  getChatAutoScrollUpdate,
  type ChatAutoScrollState,
} from "../hooks/agent-session/chatAutoScrollPolicy.ts";

const initial: ChatAutoScrollState = {
  pendingScrollToUser: false,
  initialScrollDone: false,
};

// 空消息列表不得读取或改变滚动状态。
{
  const result = getChatAutoScrollUpdate(0, initial, false);
  assert.equal(result.action, null);
  assert.deepEqual(result.state, initial);
}

// 发送用户消息优先于首次加载定位，且会完成首次滚动标记。
{
  const result = getChatAutoScrollUpdate(1, {
    pendingScrollToUser: true,
    initialScrollDone: false,
  }, true);
  assert.equal(result.action, "user-message");
  assert.deepEqual(result.state, {
    pendingScrollToUser: false,
    initialScrollDone: true,
  });
}

// 首次载入历史消息必须立即到底部，不使用平滑动画。
{
  const result = getChatAutoScrollUpdate(1, initial, false);
  assert.equal(result.action, "bottom-instant");
  assert.deepEqual(result.state, {
    pendingScrollToUser: false,
    initialScrollDone: true,
  });
}

// 后续消息变更（尤其流结束时从流式 bubble 换成完成消息）不应再由
// Session Hook 对同一滚动容器调用 scrollIntoView；实时跟随由 ChatWindow 独占。
{
  const state: ChatAutoScrollState = {
    pendingScrollToUser: false,
    initialScrollDone: true,
  };
  const result = getChatAutoScrollUpdate(2, state, false);
  assert.equal(result.action, null);
  assert.deepEqual(result.state, state);
}

// 运行中的消息变动不由 Session Hook 额外滚动，继续交给 ChatWindow 的实时滚动逻辑。
{
  const state: ChatAutoScrollState = {
    pendingScrollToUser: false,
    initialScrollDone: true,
  };
  const result = getChatAutoScrollUpdate(2, state, true);
  assert.equal(result.action, null);
  assert.deepEqual(result.state, state);
}

console.log("chat auto-scroll tests passed");
