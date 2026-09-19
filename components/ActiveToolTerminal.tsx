"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentPhaseTool, ToolTerminalEntry } from "@/hooks/useAgentSession";
import { AppIcon } from "./AppIcon";
import styles from "./ActiveToolTerminal.module.css";

function textFromResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";

  const content = (value as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (!block || typeof block !== "object") return "";
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function formatArguments(tool: AgentPhaseTool): string {
  if (tool.name === "bash" && tool.args && typeof tool.args === "object") {
    const command = (tool.args as { command?: unknown }).command;
    if (typeof command === "string" && command.trim()) return `$ ${command}`;
  }

  if (typeof tool.args === "string") return tool.args;
  if (tool.args === undefined || tool.args === null) return tool.name;
  try {
    return `${tool.name} ${JSON.stringify(tool.args, null, 2)}`;
  } catch {
    return tool.name;
  }
}

function formatHeaderCommand(tool: AgentPhaseTool | undefined): string {
  if (!tool) return "AI 输出中...";
  if (typeof tool.args === "string") return `${tool.name} ${tool.args}`.replace(/\s+/g, " ").trim();
  if (!tool.args || typeof tool.args !== "object" || Array.isArray(tool.args)) return tool.name;

  const args = tool.args as Record<string, unknown>;
  if (tool.name === "bash" && typeof args.command === "string") {
    return `$ ${args.command}`.replace(/\s+/g, " ").trim();
  }

  const values = ["action", "symbol", "query", "pattern", "filePath", "file_path", "path"]
    .map((key) => args[key])
    .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
    .map(String);
  return values.length > 0 ? `${tool.name} ${values.join(" ")}` : tool.name;
}

export function getActiveToolTerminalContent(tool: AgentPhaseTool): string {
  const rawOutput = textFromResult(tool.partialResult).trim();
  const output = rawOutput.length > 12_000
    ? `[earlier output omitted]\n${rawOutput.slice(-12_000)}`
    : rawOutput;
  const invocation = formatArguments(tool);
  return output ? `${invocation}\n\n${output}` : invocation;
}

const MIN_ENTRY_DWELL_MS = 2_000;
const MIN_SCROLL_DURATION_MS = 1_000;
const MAX_SCROLL_DURATION_MS = 1_400;

export function ActiveToolTerminal({ entries, visible, finalResponseStarted, maxWidth, sidePadding }: {
  entries: ToolTerminalEntry[];
  visible: boolean;
  finalResponseStarted: boolean;
  maxWidth: number;
  sidePadding: number;
}) {
  const outputRef = useRef<HTMLDivElement>(null);
  const lastReleaseAtRef = useRef(0);
  const previousScrollKeyRef = useRef("");
  const scrollAnimationRef = useRef<number | null>(null);
  const [releasedCount, setReleasedCount] = useState(0);
  const [exitReady, setExitReady] = useState(true);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (visible) setExitReady(false);

    if (releasedCount < entries.length) {
      const delay = releasedCount === 0
        ? 0
        : Math.max(0, MIN_ENTRY_DWELL_MS - (Date.now() - lastReleaseAtRef.current));
      timer = setTimeout(() => {
        lastReleaseAtRef.current = Date.now();
        setReleasedCount((count) => Math.min(count + 1, entries.length));
      }, delay);
    } else if (!visible) {
      const delay = entries.length === 0
        ? 0
        : Math.max(0, MIN_ENTRY_DWELL_MS - (Date.now() - lastReleaseAtRef.current));
      timer = setTimeout(() => setExitReady(true), delay);
    }

    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [entries.length, releasedCount, visible]);

  // The first tool is visible in the same render that receives tool_execution_start;
  // later tools still pass through the timed release queue.
  const displayedCount = entries.length === 0 ? 0 : Math.max(1, releasedCount);
  const shownEntries = useMemo(() => entries.slice(0, displayedCount), [displayedCount, entries]);
  const allToolsComplete = entries.length > 0 && entries.every((entry) => entry.status === "complete");
  const terminalVisible = (visible || !exitReady) && !dismissed;
  const showAiOutput = terminalVisible && displayedCount >= entries.length && allToolsComplete;
  const latestShown = shownEntries.at(-1);
  const headerCommand = formatHeaderCommand(latestShown);
  const status = latestShown?.status === "running" ? "执行中" : showAiOutput ? "输出中" : "等待中";
  const scrollKey = `${displayedCount}:${showAiOutput}`;

  useEffect(() => {
    if (!visible) return;
    if (!allToolsComplete) {
      setDismissed(false);
      return;
    }
    if (finalResponseStarted) setDismissed(true);
  }, [allToolsComplete, finalResponseStarted, visible]);

  useEffect(() => {
    const output = outputRef.current;
    if (!output) return;
    const shouldAnimate = terminalVisible && previousScrollKeyRef.current !== scrollKey;
    if (!shouldAnimate) {
      if (scrollAnimationRef.current === null) output.scrollTop = output.scrollHeight;
      return;
    }
    previousScrollKeyRef.current = scrollKey;
    if (scrollAnimationRef.current !== null) cancelAnimationFrame(scrollAnimationRef.current);

    const startTop = output.scrollTop;
    const initialTarget = Math.max(0, output.scrollHeight - output.clientHeight);
    const distance = Math.abs(initialTarget - startTop);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion || distance < 1) {
      output.scrollTop = initialTarget;
      scrollAnimationRef.current = null;
      return;
    }

    const duration = Math.min(
      MAX_SCROLL_DURATION_MS,
      Math.max(MIN_SCROLL_DURATION_MS, distance * 3),
    );
    const startedAt = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const currentTarget = Math.max(0, output.scrollHeight - output.clientHeight);
      output.scrollTop = startTop + (currentTarget - startTop) * progress;
      if (progress < 1) {
        scrollAnimationRef.current = requestAnimationFrame(step);
      } else {
        output.scrollTop = currentTarget;
        scrollAnimationRef.current = null;
      }
    };
    scrollAnimationRef.current = requestAnimationFrame(step);
  }, [entries, scrollKey, terminalVisible]);

  useEffect(() => () => {
    if (scrollAnimationRef.current !== null) cancelAnimationFrame(scrollAnimationRef.current);
  }, []);

  return (
    <div
      className={styles.wrap}
      data-visible={terminalVisible ? "true" : "false"}
      aria-hidden={!terminalVisible}
      style={{ maxWidth, width: `calc(100% - ${sidePadding * 2}px)` }}
    >
      <section className={styles.panel} aria-label="工具调用终端">
        <header className={styles.header}>
          <AppIcon name="terminal" size="inline" />
          <span className={styles.title}>终端</span>
          <code className={styles.command} title={headerCommand}>{headerCommand}</code>
          <span className={styles.status} role="status">
            <span className={styles.pulse} aria-hidden="true" />
            {status}
          </span>
        </header>
        <div ref={outputRef} className={styles.output} aria-live="polite">
          {shownEntries.map((entry) => (
            <pre className={styles.entry} key={entry.id}>{getActiveToolTerminalContent(entry)}</pre>
          ))}
          {showAiOutput && (
            <div className={styles.aiOutput} aria-label="AI 输出中...">
              <span>AI 输出中</span>
              <span className={styles.dots} aria-hidden="true">
                <span>.</span><span>.</span><span>.</span>
              </span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
