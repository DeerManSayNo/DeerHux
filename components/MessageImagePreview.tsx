"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { useEscapeClose } from "@/hooks/useEscapeClose";
import { AppIcon } from "./AppIcon";
import styles from "./MessageImagePreview.module.css";

interface Props {
  src: string | null;
  onClose: () => void;
}

type WebKitGestureEvent = Event & {
  scale: number;
  clientX: number;
  clientY: number;
};

const MIN_SCALE = 0.1;
const MAX_SCALE = 5;
const ZOOM_STEP = 0.1;
const LONG_PRESS_DELAY_MS = 350;
const LONG_PRESS_MOVE_TOLERANCE = 6;

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

function downloadName(src: string): string {
  const mime = src.match(/^data:image\/([^;,]+)/i)?.[1]?.replace(/[^a-z0-9.+-]/gi, "");
  if (mime) return `message-image.${mime === "jpeg" ? "jpg" : mime}`;
  try {
    const name = decodeURIComponent(new URL(src, window.location.href).pathname.split("/").pop() ?? "");
    return name && /\.[a-z0-9]+$/i.test(name) ? name : "message-image.png";
  } catch {
    return "message-image.png";
  }
}

export function MessageImagePreview({ src, onClose }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; x: number; y: number } | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scaleRef = useRef(1);
  const positionRef = useRef({ x: 0, y: 0 });
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  useEscapeClose(onClose, Boolean(src));

  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current === null) return;
    clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  }, []);

  useEffect(() => {
    if (!src) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    setNaturalSize({ width: 0, height: 0 });
    scaleRef.current = 1;
    setScale(1);
    positionRef.current = { x: 0, y: 0 };
    setPosition({ x: 0, y: 0 });
    setLoadFailed(false);
    return () => {
      cancelLongPress();
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus?.();
    };
  }, [src, cancelLongPress]);

  const zoomTo = useCallback((nextScale: number, clientX?: number, clientY?: number) => {
    const stage = stageRef.current;
    const currentScale = scaleRef.current;
    const next = clampScale(nextScale);
    if (!stage || next === currentScale) return;
    scaleRef.current = next;
    setScale(next);
    const rect = stage.getBoundingClientRect();
    const x = (clientX === undefined ? stage.clientWidth / 2 : clientX - rect.left) - stage.clientWidth / 2;
    const y = (clientY === undefined ? stage.clientHeight / 2 : clientY - rect.top) - stage.clientHeight / 2;
    const ratio = next / currentScale;
    const current = positionRef.current;
    const nextPosition = {
      x: x - (x - current.x) * ratio,
      y: y - (y - current.y) * ratio,
    };
    positionRef.current = nextPosition;
    setPosition(nextPosition);
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!src || !stage) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? stage.clientHeight : 1;
      const factor = Math.exp(-event.deltaY * unit * 0.0015);
      zoomTo(scaleRef.current * factor, event.clientX, event.clientY);
    };
    stage.addEventListener("wheel", handleWheel, { passive: false });
    let gestureStartScale = scaleRef.current;
    const handleGestureStart = (rawEvent: Event) => {
      const event = rawEvent as WebKitGestureEvent;
      event.preventDefault();
      gestureStartScale = scaleRef.current;
    };
    const handleGestureChange = (rawEvent: Event) => {
      const event = rawEvent as WebKitGestureEvent;
      event.preventDefault();
      zoomTo(gestureStartScale * event.scale, event.clientX, event.clientY);
    };
    stage.addEventListener("gesturestart", handleGestureStart, { passive: false });
    stage.addEventListener("gesturechange", handleGestureChange, { passive: false });
    return () => {
      stage.removeEventListener("wheel", handleWheel);
      stage.removeEventListener("gesturestart", handleGestureStart);
      stage.removeEventListener("gesturechange", handleGestureChange);
    };
  }, [src, zoomTo]);

  const handleImageLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    const stage = stageRef.current;
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    setNaturalSize({ width, height });
    if (!stage || !width || !height) return;
    const fitScale = Math.min(1, (stage.clientWidth - 64) / width, (stage.clientHeight - 64) / height);
    scaleRef.current = clampScale(fitScale);
    setScale(scaleRef.current);
    positionRef.current = { x: 0, y: 0 };
    setPosition({ x: 0, y: 0 });
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLImageElement>) => {
    const stage = stageRef.current;
    if (!stage || !event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    const pointerId = event.pointerId;
    dragRef.current = {
      pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
    };
    cancelLongPress();
    longPressTimerRef.current = setTimeout(() => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== pointerId) return;
      longPressTimerRef.current = null;
      zoomTo(Math.max(1, scaleRef.current * 2), drag.x, drag.y);
    }, LONG_PRESS_DELAY_MS);
    setDragging(true);
  };

  useEffect(() => {
    if (!src) return;
    const handlePointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > LONG_PRESS_MOVE_TOLERANCE) {
        cancelLongPress();
      }
      const nextPosition = {
        x: positionRef.current.x + event.clientX - drag.x,
        y: positionRef.current.y + event.clientY - drag.y,
      };
      positionRef.current = nextPosition;
      setPosition(nextPosition);
      drag.x = event.clientX;
      drag.y = event.clientY;
    };
    const stopDragging = (event?: PointerEvent) => {
      if (!dragRef.current || (event && dragRef.current.pointerId !== event.pointerId)) return;
      cancelLongPress();
      dragRef.current = null;
      setDragging(false);
    };
    const handleBlur = () => stopDragging();
    window.addEventListener("pointermove", handlePointerMove, { capture: true, passive: false });
    window.addEventListener("pointerup", stopDragging, true);
    window.addEventListener("pointercancel", stopDragging, true);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerup", stopDragging, true);
      window.removeEventListener("pointercancel", stopDragging, true);
      window.removeEventListener("blur", handleBlur);
    };
  }, [src, cancelLongPress]);

  const handleDownload = () => {
    if (!src) return;
    const link = document.createElement("a");
    link.href = src;
    link.download = downloadName(src);
    link.rel = "noopener";
    link.click();
  };

  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled])"));
    if (controls.length === 0) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!src || typeof document === "undefined") return null;

  const imageWidth = naturalSize.width * scale;
  const imageHeight = naturalSize.height * scale;
  const percentage = Math.round(scale * 100);

  return createPortal(
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="图片预览" onKeyDown={handleDialogKeyDown}>
      <div ref={stageRef} className={styles.stage}>
        <div
          className={styles.canvas}
          onClick={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          {loadFailed ? (
            <div className={styles.error} role="status">图片加载失败</div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className={styles.image}
              data-dragging={dragging || undefined}
              src={src}
              alt="消息图片预览"
              draggable={false}
              style={naturalSize.width ? {
                width: imageWidth,
                height: imageHeight,
                transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
              } : { visibility: "hidden" }}
              onLoad={handleImageLoad}
              onError={() => setLoadFailed(true)}
              onPointerDown={handlePointerDown}
              onContextMenu={(event) => event.preventDefault()}
            />
          )}
        </div>
      </div>

      <div className={styles.topControls}>
        <button type="button" className={styles.iconButton} onClick={handleDownload} aria-label="下载图片" title="下载图片">
          <AppIcon name="download" size="section" />
        </button>
        <button ref={closeButtonRef} type="button" className={styles.iconButton} onClick={onClose} aria-label="关闭图片预览" title="关闭">
          <AppIcon name="close" size="section" />
        </button>
      </div>

      <div className={styles.zoomControls} aria-label="图片缩放">
        <button type="button" className={styles.zoomButton} onClick={() => zoomTo(scaleRef.current - ZOOM_STEP)} disabled={scale <= MIN_SCALE} aria-label="缩小" title="缩小">
          <AppIcon name="minus" size="section" />
        </button>
        <output className={styles.percentage} aria-live="polite">{percentage}%</output>
        <button type="button" className={styles.zoomButton} onClick={() => zoomTo(scaleRef.current + ZOOM_STEP)} disabled={scale >= MAX_SCALE} aria-label="放大" title="放大">
          <AppIcon name="add" size="section" />
        </button>
      </div>
    </div>,
    document.body,
  );
}
