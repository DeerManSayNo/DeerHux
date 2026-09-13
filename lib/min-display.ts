/**
 * 最小显示时长状态机（纯函数，供 useMinDisplayValue 驱动与测试）。
 *
 * 背景：agentPhase 由 SSE 事件（毫秒级）驱动，serverStatus 由 2s 轮询驱动，
 * 两者节奏不一致导致阶段文案在语义相近的取值间高频互跳，视觉上表现为闪烁。
 * 本状态机只约束“文案何时被替换”，不改变真实状态。
 */

export interface MinDisplayState<T> {
  /** 当前展示值 */
  display: T;
  /** 已就绪但被最小时长推迟的待展示值 */
  pending: T;
  /** pending 是否有效（支持 T 本身为 null/undefined） */
  hasPending: boolean;
  /** 上一次真正切换展示值的时刻（ms） */
  lastSwitchAt: number;
}

export interface MinDisplayDecision<T> {
  next: MinDisplayState<T>;
  /** 需要更新展示值 */
  commit: boolean;
  /** 需要安排的延迟提交（ms）；null 表示无需计时器 */
  scheduleMs: number | null;
}

export function createMinDisplayState<T>(value: T): MinDisplayState<T> {
  return { display: value, pending: value, hasPending: false, lastSwitchAt: 0 };
}

/**
 * 处理一次输入值变化。
 *
 * - 与当前展示值相同：丢弃挂起值并取消计时器。
 * - 已超过最小时长：立即提交。
 * - 未超过：记录最新值，安排 remaining 后提交；期间后续变化只覆盖 pending，
 *   窗口结束时直接跳到最新值，不排队播放中间值。
 */
export function reduceMinDisplay<T>(
  state: MinDisplayState<T>,
  value: T,
  minDurationMs: number,
  now: number,
): MinDisplayDecision<T> {
  if (Object.is(value, state.display)) {
    return {
      next: { ...state, pending: value, hasPending: false },
      commit: false,
      scheduleMs: null,
    };
  }

  const remaining = minDurationMs - (now - state.lastSwitchAt);
  if (remaining <= 0) {
    return {
      next: { display: value, pending: value, hasPending: false, lastSwitchAt: now },
      commit: true,
      scheduleMs: null,
    };
  }

  return {
    next: { ...state, pending: value, hasPending: true },
    commit: false,
    scheduleMs: remaining,
  };
}

/** 计时器触发时决定是否提交挂起值。 */
export function commitMinDisplay<T>(
  state: MinDisplayState<T>,
  now: number,
): { next: MinDisplayState<T>; commit: boolean } {
  if (!state.hasPending || Object.is(state.pending, state.display)) {
    return { next: { ...state, hasPending: false }, commit: false };
  }
  return {
    next: { display: state.pending, pending: state.pending, hasPending: false, lastSwitchAt: now },
    commit: true,
  };
}
