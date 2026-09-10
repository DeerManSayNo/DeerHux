"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { nativeDragClientPosition } from "@/lib/native-drag-position";
import { parseClipboardFilePaths } from "@/lib/clipboard-file-paths";

export const FILE_REFERENCE_DRAG_TYPE = "application/x-deerhux-file-paths";

function isFileDrag(data: DataTransfer): boolean {
  return Array.from(data.types).some((type) =>
    type === "Files" || type === FILE_REFERENCE_DRAG_TYPE || type === "text/uri-list");
}

export function useDragDrop(onDrop: (paths: string[], files?: File[]) => void) {
  const [isDragOver, setIsDragOver] = useState(false);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const [dropSurface, setDropSurface] = useState<HTMLElement | null>(null);
  const callbackRef = useRef(onDrop);
  callbackRef.current = onDrop;
  const counterRef = useRef(0);

  // Native file drops include original paths, which WebView File objects omit.
  useEffect(() => {
    if (!dropSurface || !window.__TAURI_INTERNALS__) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let removeResizeListener: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const currentWindow = getCurrentWindow();
      const isMac = /Macintosh|Mac OS X/.test(navigator.userAgent);
      let nativeScale = await currentWindow.scaleFactor();
      if (disposed) return;
      const refreshScale = () => { void currentWindow.scaleFactor().then((scale) => { nativeScale = scale; }).catch(() => {}); };
      window.addEventListener("resize", refreshScale);
      removeResizeListener = () => window.removeEventListener("resize", refreshScale);
      const cleanup = await currentWindow.onDragDropEvent(({ payload }) => {
        if (disposed) return;
        if (payload.type === "leave") {
          setIsDragOver(false);
          return;
        }
        const { x, y } = nativeDragClientPosition(payload.position, isMac, window.devicePixelRatio, nativeScale);
        const hit = document.elementFromPoint(x, y);
        const inside = !!hit && dropSurface.contains(hit);
        setIsDragOver(payload.type !== "drop" && inside);
        if (payload.type === "drop" && inside) callbackRef.current(payload.paths);
      });
      if (disposed) cleanup();
      else unlisten = cleanup;
    }).catch(() => { /* DOM file URI drops remain available. */ });
    return () => { disposed = true; unlisten?.(); removeResizeListener?.(); };
  }, [dropSurface]);

  const handleDragEnter = useCallback((e: DragEvent) => {
    if (!e.dataTransfer || !isFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    counterRef.current += 1;
    setIsDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    if (!e.dataTransfer || !isFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.dataTransfer.effectAllowed === "link" ? "link" : "copy";
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    counterRef.current = Math.max(0, counterRef.current - 1);
    if (!counterRef.current) setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: DragEvent) => {
    if (!e.dataTransfer || !isFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    counterRef.current = 0;
    setIsDragOver(false);
    let paths = parseClipboardFilePaths(e.dataTransfer.getData("text/uri-list"));
    try {
      const internal: unknown = JSON.parse(e.dataTransfer.getData(FILE_REFERENCE_DRAG_TYPE) || "null");
      if (Array.isArray(internal)) paths = internal.filter((path): path is string => typeof path === "string" && !!path.trim());
    } catch { /* Fall back to file URLs. */ }
    // Native drops are handled above; do not report a missing DOM path first.
    if (paths.length || !window.__TAURI_INTERNALS__) callbackRef.current([...new Set(paths)], Array.from(e.dataTransfer.files));
  }, []);

  // Each session receives drops over its own chat window, including unfocused panes.
  useEffect(() => {
    const zone = dropZoneRef.current;
    const surface = zone?.closest<HTMLElement>(".chat-window-wrap") ?? zone;
    if (!surface) return;
    setDropSurface(surface);
    const enter = (event: Event) => handleDragEnter(event as DragEvent);
    const over = (event: Event) => handleDragOver(event as DragEvent);
    const leave = (event: Event) => {
      if (!((event as DragEvent).relatedTarget instanceof Node) || !surface.contains((event as DragEvent).relatedTarget as Node)) { counterRef.current = 0; setIsDragOver(false); }
      else handleDragLeave();
    };
    const drop = (event: Event) => handleDrop(event as DragEvent);
    surface.addEventListener("dragenter", enter, true);
    surface.addEventListener("dragover", over, true);
    surface.addEventListener("dragleave", leave, true);
    surface.addEventListener("drop", drop, true);
    const reset = () => { counterRef.current = 0; setIsDragOver(false); };
    window.addEventListener("dragend", reset, true);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("dragend", reset, true);
      window.removeEventListener("blur", reset);
      surface.removeEventListener("dragenter", enter, true);
      surface.removeEventListener("dragover", over, true);
      surface.removeEventListener("dragleave", leave, true);
      surface.removeEventListener("drop", drop, true);
    };
  }, [handleDragEnter, handleDragOver, handleDragLeave, handleDrop]);

  return { dropZoneRef, dropSurface, isDragOver };
}
