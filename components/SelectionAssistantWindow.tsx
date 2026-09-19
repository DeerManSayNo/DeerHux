"use client";

import { useCallback, useEffect, useState, type PointerEvent } from "react";
import { useSearchParams } from "next/navigation";
import { AppIcon } from "@/components/AppIcon";
import { copyText, MessageMarkdown } from "@/components/MessageView";
import { useTheme } from "@/hooks/useTheme";
import {
  SELECTION_ASSISTANT_READY_EVENT,
  SELECTION_ASSISTANT_REQUEST_EVENT,
  selectionAssistantStorageKey,
  type SelectionAssistantRequest,
} from "@/lib/selection-assistant-window";
import styles from "./SelectionAssistantWindow.module.css";

type Status = "loading" | "streaming" | "done" | "error";

async function responseError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string };
    return body.error || "暂时无法回答";
  } catch {
    return "暂时无法回答";
  }
}

function readRequest(id: string | null): SelectionAssistantRequest | null {
  if (!id) return null;
  const key = selectionAssistantStorageKey(id);
  try {
    const raw = window.localStorage.getItem(key);
    window.localStorage.removeItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as SelectionAssistantRequest;
    return value?.sessionId && (value.mode === "ask" || value.mode === "explain") ? value : null;
  } catch {
    return null;
  }
}

export function SelectionAssistantWindow() {
  useTheme({ syncNative: false });
  const searchParams = useSearchParams();
  const requestId = searchParams.get("request");
  // Keep the server and the first client render identical; hydrate request data after mount.
  const [request, setRequest] = useState<SelectionAssistantRequest | null>(null);
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState<Status>("loading");
  const [copied, setCopied] = useState(false);

  const run = useCallback(async (signal: AbortSignal) => {
    if (!request) return;
    setContent("");
    setError("");
    setStatus("loading");
    try {
      const response = await fetch(`/api/agent/${encodeURIComponent(request.sessionId)}/explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal,
      });
      if (!response.ok) throw new Error(await responseError(response));
      if (!response.body) throw new Error("只读问答服务没有返回内容");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      let finished = false;
      while (!finished) {
        const chunk = await reader.read();
        finished = chunk.done;
        buffered += decoder.decode(chunk.value, { stream: !finished });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as { type?: string; text?: string; message?: string };
          if (event.type === "delta" && event.text) {
            setContent((current) => current + event.text);
            setStatus("streaming");
          } else if (event.type === "done") {
            setStatus("done");
          } else if (event.type === "error") {
            throw new Error(event.message || "暂时无法回答");
          }
        }
      }
      setStatus((current) => current === "done" ? current : "done");
    } catch (reason) {
      if (signal.aborted) return;
      setError(reason instanceof Error ? reason.message : "暂时无法回答");
      setStatus("error");
    }
  }, [request]);

  useEffect(() => {
    if (request || !requestId) {
      if (!requestId) {
        setError("请求内容已失效，请重新发起");
        setStatus("error");
      }
      return;
    }

    const storedRequest = readRequest(requestId);
    if (storedRequest) {
      setRequest(storedRequest);
      return;
    }

    if (!window.__TAURI_INTERNALS__) {
      setError("请求内容已失效，请重新发起");
      setStatus("error");
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(async ({ emit, listen }) => {
      unlisten = await listen<{ requestId?: string; request?: SelectionAssistantRequest }>(
        SELECTION_ASSISTANT_REQUEST_EVENT,
        (event) => {
          if (disposed || event.payload?.requestId !== requestId || !event.payload.request) return;
          setRequest(event.payload.request);
        },
      );
      if (!disposed) await emit(SELECTION_ASSISTANT_READY_EVENT, { requestId });
    }).catch(() => {
      if (!disposed) {
        setError("无法接收请求内容，请重新发起");
        setStatus("error");
      }
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [request, requestId]);

  useEffect(() => {
    const htmlBackground = document.documentElement.style.background;
    const bodyBackground = document.body.style.background;
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    return () => {
      document.documentElement.style.background = htmlBackground;
      document.body.style.background = bodyBackground;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void run(controller.signal);
    return () => controller.abort();
  }, [run]);

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let blurTimer: number | undefined;
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => {
        const appWindow = getCurrentWindow();
        return appWindow.onFocusChanged(({ payload: focused }) => {
          if (blurTimer) window.clearTimeout(blurTimer);
          blurTimer = undefined;
          if (focused) return;
          blurTimer = window.setTimeout(() => {
            blurTimer = undefined;
            void appWindow.isFocused()
              .then((stillFocused) => {
                if (!stillFocused && !disposed) void appWindow.close();
              })
              .catch(() => {
                if (!disposed) void appWindow.close();
              });
          }, 100);
        });
      })
      .then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      if (blurTimer) window.clearTimeout(blurTimer);
      unlisten?.();
    };
  }, []);

  const closeWindow = () => {
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().close())
      .catch(() => window.close());
  };

  const startDragging = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    event.preventDefault();
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().startDragging())
      .catch(() => {});
  };

  const label = request?.mode === "explain" ? `“${request.text}”` : request?.question ?? "只读问答";

  return (
    <main className={styles.root} data-selection-assistant-root>
      <section
        className={`${styles.window} adaptive-glass-surface`}
        aria-label={request ? (request.mode === "explain" ? "选中文字解释" : "上下文提问回答") : "只读问答"}
      >
        <div className={styles.header} onPointerDown={startDragging}>
          <span className={styles.question} title={label}>{label}</span>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.iconButton}
              disabled={!content}
              title={copied ? "已复制" : "复制回答"}
              aria-label={copied ? "回答已复制" : "复制回答"}
              onClick={() => void copyText(content).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              })}
            >
              <AppIcon name={copied ? "check" : "copy"} size="compact" />
            </button>
            <button type="button" className={styles.iconButton} title="关闭" aria-label="关闭" onClick={closeWindow}>
              <AppIcon name="close" size="compact" />
            </button>
          </div>
        </div>
        <div className={styles.body}>
          {content && <MessageMarkdown text={content} isStreaming={status === "streaming"} />}
          {status === "loading" && <div className={styles.loading}><AppIcon name="loading" size="compact" />正在回答…</div>}
          {status === "error" && (
            <div className={styles.error} role="alert">
              <span>{error}</span>
              {request && <button type="button" onClick={() => void run(new AbortController().signal)}>重试</button>}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
