import { useEffect, useRef, useState } from "react";
import {
  commitMinDisplay,
  createMinDisplayState,
  reduceMinDisplay,
  type MinDisplayState,
} from "@/lib/min-display";

/**
 * 为高频变化的展示值提供最小显示时长，避免文案闪烁。
 *
 * 首次立即生效，不引入启动延迟。逻辑见 lib/min-display.ts。
 */
export function useMinDisplayValue<T>(value: T, minDurationMs: number): T {
  const [displayValue, setDisplayValue] = useState(value);
  const stateRef = useRef<MinDisplayState<T>>(createMinDisplayState(value));
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const decision = reduceMinDisplay(stateRef.current, value, minDurationMs, Date.now());
    stateRef.current = decision.next;

    if (decision.scheduleMs === null) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    } else if (timerRef.current === null) {
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        const committed = commitMinDisplay(stateRef.current, Date.now());
        stateRef.current = committed.next;
        if (committed.commit) setDisplayValue(committed.next.display);
      }, decision.scheduleMs);
    }

    if (decision.commit) setDisplayValue(decision.next.display);
  }, [value, minDurationMs]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  return displayValue;
}
