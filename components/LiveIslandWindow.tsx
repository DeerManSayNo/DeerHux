"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { subscribeLiveIslandEvents } from "@/lib/agent-event-client";
import {
  dismissLiveIslandRow,
  pushLiveIslandEvents,
  focusLiveIslandRow,
  listenLiveIslandHover,
  listenLiveIslandLayout,
  listenLiveIslandSnapshot,
  markLiveIslandReady,
  setLiveIslandDrawerHeight,
  type LiveIslandRow,
  type LiveIslandRowStatus,
  type LiveIslandSnapshot,
} from "@/lib/live-island-window";
import styles from "./LiveIslandWindow.module.css";

const EMPTY_SNAPSHOT: LiveIslandSnapshot = {
  rows: [],
  scale: "medium",
  layout: { hasNotch: false, notchWidth: 0 },
  enabled: true,
};

const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const SPINNING_STATUS = new Set<LiveIslandRowStatus>([
  "thinking",
  "reading",
  "editing",
  "writing",
  "running",
  "searching",
  "waiting",
]);

const STATUS_LABEL: Record<LiveIslandRowStatus, string> = {
  thinking: "思考中",
  reading: "读取",
  editing: "编辑",
  writing: "写入",
  running: "执行",
  searching: "检索",
  done: "完成",
  interrupted: "已中断",
  error: "出错",
  waiting: "等待",
};

/** Formats elapsed ms as m:ss, matching the compact pill. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Elapsed time is derived from absolute timestamps rather than a server-pushed
 * counter, so many concurrent sessions stay accurate without extra IPC.
 *
 * The clock reading lives in state so render stays pure; the interval only
 * re-reads it while the row is still running.
 */
function useElapsed(row: LiveIslandRow): string {
  const frozen = row.frozenElapsed;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (frozen != null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [frozen, row.startedAt]);

  const elapsed = frozen != null ? frozen : now - row.startedAt;
  return formatElapsed(elapsed);
}

function StatusGlyph({
  row,
  frame,
}: {
  row: LiveIslandRow;
  frame: number;
}) {
  return (
    <span className={styles.braille} data-status={row.status} aria-hidden="true">
      {SPINNING_STATUS.has(row.status) ? BRAILLE[frame] : "●"}
    </span>
  );
}

function RowElapsed({ row }: { row: LiveIslandRow }) {
  const elapsed = useElapsed(row);

  return (
    <span className={styles.elapsed} data-done={row.status === "done" || undefined}>
      {elapsed}
    </span>
  );
}

function CompactSession({
  row,
  frame,
  onFocus,
}: {
  row: LiveIslandRow;
  frame: number;
  onFocus: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className={styles.compactSession}
      data-status={row.status}
      onClick={() => onFocus(row.id)}
      title={row.detail || row.prompt || row.project}
    >
      <span className={styles.compactMain}>
        <StatusGlyph row={row} frame={frame} />
        <span className={styles.project}>{row.project}</span>
      </span>
      <RowElapsed row={row} />
    </button>
  );
}

function RowCard({
  row,
  onDismiss,
  onFocus,
}: {
  row: LiveIslandRow;
  onDismiss: (id: string) => void;
  onFocus: (id: string) => void;
}) {
  const elapsed = useElapsed(row);
  const statusLabel = STATUS_LABEL[row.status] ?? row.status;

  return (
    <button
      type="button"
      className={styles.card}
      onClick={() => onFocus(row.id)}
      title="切换到 DeerHux"
    >
      <div className={styles.cardHeader}>
        <span className={styles.indicator} data-status={row.status} aria-hidden="true" />
        <span className={styles.cardProject}>{row.project}</span>
        <span className={styles.cardStatus} data-status={row.status}>
          {statusLabel}
        </span>
        <span className={styles.cardElapsed} data-done={row.status === "done" || undefined}>
          {elapsed}
        </span>
        <span
          className={styles.dismiss}
          role="button"
          tabIndex={0}
          aria-label="从灵动岛移除"
          onClick={(event) => {
            event.stopPropagation();
            onDismiss(row.id);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              onDismiss(row.id);
            }
          }}
        >
          ✕
        </span>
      </div>
      {row.prompt ? <div className={styles.cardPrompt}>{row.prompt}</div> : null}
      {row.detail ? <div className={styles.cardDetail}>{row.detail}</div> : null}
    </button>
  );
}

/**
 * DeerHux 灵动岛 overlay.
 *
 * Rendered in a transparent, always-on-top Tauri window anchored under the
 * macOS menu bar / camera housing. Collapsed it shows one pill per session
 * (many concurrent sessions collapse into pairs); hovering expands a drawer
 * listing every session.
 */
export function LiveIslandWindow() {
  useTheme();
  const [snapshot, setSnapshot] = useState<LiveIslandSnapshot>(EMPTY_SNAPSHOT);
  const [hovered, setHovered] = useState(false);
  const [brailleFrame, setBrailleFrame] = useState(0);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const lastReportedHeight = useRef(-1);

  useEffect(() => {
    let active = true;
    const unlisten: Array<() => void> = [];
    void Promise.all([
      listenLiveIslandSnapshot((next) => {
        if (active) setSnapshot(next);
      }),
      listenLiveIslandHover((payload) => {
        if (active) setHovered(payload.inside);
      }),
      listenLiveIslandLayout(() => {
        // Layout changes only affect notch padding; the snapshot carries it too.
      }),
    ]).then((hostUnlisten) => {
      if (!active) {
        for (const fn of hostUnlisten) fn();
        return;
      }
      unlisten.push(...hostUnlisten);

      // Register host listeners before opening the Node event stream. A fresh
      // SSE connection can synchronously replay its live-island baseline, and
      // that push immediately emits the first host snapshot.
      unlisten.push(subscribeLiveIslandEvents((frame) => {
        void pushLiveIslandEvents(frame.events);
      }));
      void markLiveIslandReady();
    });

    return () => {
      active = false;
      for (const fn of unlisten) fn();
    };
  }, []);

  useEffect(() => {
    if (!snapshot.rows.some((row) => SPINNING_STATUS.has(row.status))) return;
    const timer = window.setInterval(() => {
      setBrailleFrame((frame) => (frame + 1) % BRAILLE.length);
    }, 80);
    return () => window.clearInterval(timer);
  }, [snapshot.rows]);

  // Tell the host how tall the expanded drawer is so the window can grow.
  useEffect(() => {
    if (!hovered || snapshot.rows.length === 0) {
      if (lastReportedHeight.current !== 0) {
        lastReportedHeight.current = 0;
        void setLiveIslandDrawerHeight(0);
      }
      return;
    }
    const element = drawerRef.current;
    if (!element) return;
    const measure = () => {
      const height = Math.ceil(element.getBoundingClientRect().height);
      if (height > 0 && height !== lastReportedHeight.current) {
        lastReportedHeight.current = height;
        void setLiveIslandDrawerHeight(height);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hovered, snapshot.rows.length]);

  const pillRows = useMemo(() => {
    const paired: Array<[LiveIslandRow, LiveIslandRow?]> = [];
    for (let i = 0; i < snapshot.rows.length; i += 2) {
      paired.push([snapshot.rows[i], snapshot.rows[i + 1]]);
    }
    return paired;
  }, [snapshot.rows]);

  const hasNotch = snapshot.layout.hasNotch && snapshot.layout.notchWidth > 0;
  const notchWidth = hasNotch ? snapshot.layout.notchWidth : 0;

  return (
    <div
      className={styles.root}
      data-live-island-root=""
      data-scale={snapshot.scale}
      data-expanded={hovered || undefined}
      data-has-notch={hasNotch || undefined}
      style={{ ["--notch-width" as string]: `${notchWidth}px` }}
    >
      <div className={styles.pillStack} data-has-notch={hasNotch || undefined}>
        {snapshot.rows.length === 1 ? (
          <div
            className={styles.pillRow}
            data-has-notch={hasNotch || undefined}
            data-status={snapshot.rows[0].status}
          >
            <button
              type="button"
              className={`${styles.segment} ${styles.segmentLeft}`}
              onClick={() => { void focusLiveIslandRow(snapshot.rows[0].id); }}
              title={snapshot.rows[0].detail || snapshot.rows[0].prompt}
            >
              <StatusGlyph row={snapshot.rows[0]} frame={brailleFrame} />
              <span className={styles.project}>{snapshot.rows[0].project}</span>
            </button>
            {hasNotch ? <span className={styles.notchFill} aria-hidden="true" /> : null}
            <button
              type="button"
              className={`${styles.segment} ${styles.segmentRight}`}
              onClick={() => { void focusLiveIslandRow(snapshot.rows[0].id); }}
              title={snapshot.rows[0].detail || snapshot.rows[0].prompt}
            >
              <span className={styles.status}>
                {STATUS_LABEL[snapshot.rows[0].status] ?? snapshot.rows[0].status}
              </span>
              <RowElapsed row={snapshot.rows[0]} />
            </button>
          </div>
        ) : (
          pillRows.map(([left, right], index) => (
            <div
              className={styles.pillRow}
              data-has-notch={hasNotch || undefined}
              data-compact="true"
              data-last={index === pillRows.length - 1 || undefined}
              key={`${left.id}:${right?.id ?? "empty"}`}
            >
              <div className={`${styles.segment} ${styles.segmentLeft}`}>
                <CompactSession
                  row={left}
                  frame={brailleFrame}
                  onFocus={(id) => { void focusLiveIslandRow(id); }}
                />
              </div>
              {hasNotch ? <span className={styles.notchFill} aria-hidden="true" /> : null}
              <div className={`${styles.segment} ${styles.segmentRight}`}>
                {right ? (
                  <CompactSession
                    row={right}
                    frame={brailleFrame}
                    onFocus={(id) => { void focusLiveIslandRow(id); }}
                  />
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
      {hovered && snapshot.rows.length > 0 ? (
        <div className={styles.drawer} ref={drawerRef}>
          {snapshot.rows.map((row) => (
            <RowCard
              key={row.id}
              row={row}
              onDismiss={(id) => { void dismissLiveIslandRow(id); }}
              onFocus={(id) => { void focusLiveIslandRow(id); }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
