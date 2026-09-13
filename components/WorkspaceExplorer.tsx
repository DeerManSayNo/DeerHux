"use client";

import { useEffect, useRef, useState } from "react";
import { FileExplorer } from "./FileExplorer";
import { AppIcon } from "./AppIcon";
import { type ExplorerProjectState, readFileExplorerState, writeFileExplorerState } from "@/lib/file-explorer-state";

interface Props {
  cwd: string;
  refreshKey: number;
  revealRequest?: { id: number; path: string } | null;
  onOpenFile: (path: string, name: string) => void;
  onAtMention: (path: string) => void;
}

// The parent keys this component by cwd, so each project's state is restored independently.
export function WorkspaceExplorer({ cwd, refreshKey, revealRequest, onOpenFile, onAtMention }: Props) {
  const [initialState, setInitialState] = useState<ExplorerProjectState | null>(null);
  const [filterQuery, setFilterQuery] = useState("");
  const currentState = useRef<ExplorerProjectState>({ expandedPaths: [], activePath: null });
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<number | null>(null);

  const initialReveal = useRef(revealRequest);

  useEffect(() => {
    const saved = readFileExplorerState(cwd);
    currentState.current = saved;
    pendingScroll.current = initialReveal.current ? null : saved.scrollTop ?? 0;
    setInitialState(saved);
  }, [cwd]);

  useEffect(() => {
    const viewport = scrollRef.current;
    const content = contentRef.current;
    if (!initialState || !viewport || !content) return;
    // Files and expanded directories load asynchronously; restore once enough rows exist.
    const restore = () => {
      const top = pendingScroll.current;
      if (top === null || viewport.clientHeight === 0) return;
      viewport.scrollTop = top;
      if (Math.abs(viewport.scrollTop - top) < 1) pendingScroll.current = null;
    };
    const observer = new ResizeObserver(restore);
    observer.observe(content);
    observer.observe(viewport);
    restore();
    return () => observer.disconnect();
  }, [initialState]);

  useEffect(() => {
    if (!revealRequest || !initialState) return;
    pendingScroll.current = null;
    const viewport = scrollRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    let completed = false;
    const locate = () => {
      if (completed || viewport.clientHeight === 0) return;
      const tree = content.querySelector<HTMLElement>(`[data-explorer-reveal-id="${revealRequest.id}"]`);
      if (tree?.querySelector("[data-explorer-loading=true]")) return;
      const row = tree?.querySelector<HTMLElement>("[data-explorer-active=true]");
      if (!row || row.getBoundingClientRect().height === 0) return;
      const rect = row.getBoundingClientRect();
      const bounds = viewport.getBoundingClientRect();
      viewport.scrollTop += rect.top - bounds.top - (viewport.clientHeight - rect.height) / 2;
      completed = true;
      currentState.current = { ...currentState.current, scrollTop: viewport.scrollTop };
      writeFileExplorerState(cwd, currentState.current);
    };
    const mutationObserver = new MutationObserver(locate);
    const resizeObserver = new ResizeObserver(locate);
    mutationObserver.observe(content, { subtree: true, childList: true, attributes: true });
    resizeObserver.observe(viewport);
    locate();
    return () => { mutationObserver.disconnect(); resizeObserver.disconnect(); };
  }, [cwd, initialState, revealRequest]);

  const save = (state: ExplorerProjectState) => {
    currentState.current = { ...currentState.current, ...state };
    writeFileExplorerState(cwd, currentState.current);
  };

  return (
    <div className="workspace-explorer">
      <label className="workspace-explorer-filter">
        <AppIcon name="search" size="compact" />
        <input
          type="search"
          value={filterQuery}
          onChange={(event) => setFilterQuery(event.target.value)}
          placeholder="筛选文件..."
          aria-label="筛选文件"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div
        ref={scrollRef}
        className="workspace-explorer-scroll"
        onWheel={() => { pendingScroll.current = null; }}
        onPointerDown={() => { pendingScroll.current = null; }}
        onKeyDown={() => { pendingScroll.current = null; }}
        onScroll={(event) => {
          if (pendingScroll.current !== null || event.currentTarget.clientHeight === 0) return;
          save({ ...currentState.current, scrollTop: event.currentTarget.scrollTop });
        }}
      >
        <div ref={contentRef}>
          {initialState && <FileExplorer
            cwd={cwd}
            showRoot
            filterQuery={filterQuery}
            revealRequest={revealRequest}
            refreshKey={refreshKey}
            onOpenFile={onOpenFile}
            onAtMention={onAtMention}
            initialExpandedPaths={initialState.expandedPaths}
            activePath={initialState.activePath}
            onExplorerStateChange={save}
          />}
        </div>
      </div>
    </div>
  );
}
