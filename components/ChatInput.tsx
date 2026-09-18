"use client";

import { AppIcon } from "./AppIcon";
import { SendIconButton } from "./SendIconButton";
import { MessageImagePreview } from "./MessageImagePreview";

import React, { useRef, useState, useCallback, useEffect, useId, useImperativeHandle, useMemo, forwardRef, KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useAutoGrowTextarea } from "@/hooks/useAutoGrowTextarea";
import type { AutoRecoveryMode, RetryInfo, StallLevel } from "@/hooks/useAgentSession";
import type { AgentMode } from "@/lib/agent-modes";
import type { FileReference, SkillReference } from "@/lib/types";
import { skillReference, skillQueryAtCaret } from "@/lib/skill-selection";
import { useDragDrop } from "@/hooks/useDragDrop";
import { useTransientNotice } from "@/hooks/useTransientNotice";
import { subscribeToAppNotification } from "@/lib/app-notifications";
import { clipboardFilePaths } from "@/lib/clipboard-file-paths";
import { fetchJsonWithRetry, readCachedJson, writeCachedJson } from "@/lib/client-resilience";
import type { ContextCacheMetrics } from "@/lib/context-metrics";

export interface AttachedImage {
  uploadId?: string;
  data: string;   // base64, no prefix (legacy, kept for compatibility)
  mimeType: string;
  previewUrl: string; // object URL for temporary preview before upload
  filePath?: string;  // absolute filesystem path (backend reads from here)
  fileUrl?: string;   // frontend access URL via /api/files/...?type=read
}

function attachedImagePreviewSource(image: AttachedImage): string | null {
  if (image.fileUrl) return image.fileUrl;
  if (image.data) return `data:${image.mimeType};base64,${image.data}`;
  return image.previewUrl || null;
}

function revokeAttachedImagePreview(image: AttachedImage): void {
  if (image.previewUrl.startsWith("blob:")) URL.revokeObjectURL(image.previewUrl);
}

interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
  input?: ("text" | "image")[];
}

export interface SkillOption {
  name: string;
  description: string;
  source?: "global" | "project" | "path";
  sourceInfo?: {
    source?: string;
    scope?: string;
  };
  disableModelInvocation?: boolean;
}

export interface ChatInputState {
  value: string;
  attachedImages: AttachedImage[];
  selectedSkill: SkillOption | null;
  selectedSkills?: SkillOption[];
  fileReferences?: FileReference[];
}

interface RoleSetting { id: string; text: string; createdAt: string }
interface AgentRole {
  id: string;
  name: string;
  description: string;
  basePrompt: string;
  blocks: Record<string, RoleSetting[]>;
  builtIn?: boolean;
  sourceInfo?: { scope?: string; filePath?: string };
}

const DEFAULT_ROLE_FALLBACK: AgentRole = {
  id: "default",
  name: "默认角色",
  description: "通用任务",
  basePrompt: "",
  blocks: {},
  builtIn: true,
};

interface Props {
  /** Restricted remote transport: text input only, no local resource discovery. */
  textOnly?: boolean;
  /** Let the parent reading column own width and horizontal spacing. */
  fitContainer?: boolean;
  onSend: (message: string, images?: AttachedImage[], references?: FileReference[], skill?: SkillReference) => void;
  /** 返回 false 则取消本次发送并保留输入（如弹出压缩确认框）。 */
  onBeforeSend?: (message: string, images?: AttachedImage[], references?: FileReference[], skill?: SkillReference) => boolean | void;
  onAbort: () => void;
  onSteer?: (message: string, images?: AttachedImage[], references?: FileReference[], skill?: SkillReference) => void;
  onFollowUp?: (message: string, images?: AttachedImage[], references?: FileReference[], skill?: SkillReference) => void;
  isStreaming: boolean;
  contextMetrics?: ContextCacheMetrics | null;
  /** Saved input state to restore when the component mounts */
  initialInputState?: ChatInputState | null;
  /** Ref-based callback to persist input state (avoids parent re-renders on every keystroke) */
  saveInputStateRef?: React.MutableRefObject<((state: ChatInputState) => void) | null>;
  model?: { provider: string; modelId: string } | null;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string; input?: ("text" | "image")[] }[];
  modelCatalogError?: string | null;
  onModelChange?: (provider: string, modelId: string) => void;
  onCompact?: () => void;
  onAbortCompaction?: () => void;
  isCompacting?: boolean;
  compactError?: string | null;
  lastModelError?: string | null;
  onClearModelError?: () => void;
  terminalNotice?: { title: string; detail?: string } | null;
  onClearTerminalNotice?: () => void;
  agentMode?: AgentMode;
  onAgentModeChange?: (mode: AgentMode) => void;
  planReady?: boolean;
  onBuildPlan?: () => void;
  thinkingLevel?: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  onThinkingLevelChange?: (level: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh") => void;
  availableThinkingLevels?: string[] | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  retryInfo?: RetryInfo | null;
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  cwd?: string | null;
  currentRoleId?: string;
  onRoleChange?: (roleId: string) => void;
  onRolesLoaded?: (roles: AgentRole[]) => void;
  onOpenRoleConfig?: () => void;
  compact?: boolean;
  stallLevel?: StallLevel;
  autoRecoveryMode?: AutoRecoveryMode;
  onAutoRecoveryModeChange?: (mode: AutoRecoveryMode) => void;
  subagentEnabled?: boolean;
  onSubagentToggle?: () => void;
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  addImages: (files: File[]) => void;
  addReference: (path: string) => void;
  toggleReference: (path: string) => void;
  clearInput: () => void;
}

const AGENT_MODES: { id: AgentMode; label: string; desc: string }[] = [
  { id: "ask", label: "Ask", desc: "只读问答" },
  { id: "plan", label: "Plan", desc: "先研究再 Build" },
  { id: "agent", label: "Agent", desc: "可修改和执行" },
];

const THINKING_LEVELS = ["auto", "off", "minimal", "low", "medium", "high", "xhigh"] as const;
const THINKING_LEVEL_DESC: Record<typeof THINKING_LEVELS[number], string> = {
  auto: "沿用 DeerHux 默认设置",
  off: "关闭推理",
  minimal: "最少推理",
  low: "低强度推理",
  medium: "中等推理",
  high: "高强度推理",
  xhigh: "最高强度推理",
};

function fileReferenceName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function skillScope(skill: SkillOption): "global" | "project" | "path" {
  if (skill.source) return skill.source;
  const scope = skill.sourceInfo?.scope;
  if (scope === "user") return "global";
  if (scope === "project") return "project";
  return "path";
}


export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput({
  onSend, onBeforeSend, onAbort, onSteer, onFollowUp, isStreaming, contextMetrics, model, modelNames, modelList, modelCatalogError, onModelChange,
  onCompact, onAbortCompaction, isCompacting, compactError, lastModelError, onClearModelError,
  terminalNotice, onClearTerminalNotice,
  textOnly = false,
  fitContainer = false,
  agentMode = "agent", onAgentModeChange, planReady, onBuildPlan,
  thinkingLevel, onThinkingLevelChange, availableThinkingLevels, thinkingLevelMap,
  retryInfo,
  soundEnabled, onSoundToggle,
  cwd,
  currentRoleId = "default",
  onRoleChange,
  onRolesLoaded,
  onOpenRoleConfig,
  compact = false,
  stallLevel,
  autoRecoveryMode,
  onAutoRecoveryModeChange,
  subagentEnabled = false,
  onSubagentToggle,
  initialInputState,
  saveInputStateRef,
}: Props, ref) {
  const contextUsageDetailsId = useId();
  const [value, setValue] = useState(initialInputState?.value ?? "");
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelDropdownRect, setModelDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [toolDropdownOpen, setToolDropdownOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [roleDropdownOpen, setRoleDropdownOpen] = useState(false);
  const [roleDropdownRect, setRoleDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [roles, setRoles] = useState<AgentRole[]>([DEFAULT_ROLE_FALLBACK]);
  const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false);
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>(initialInputState?.attachedImages ?? []);
  const [previewImageSrc, setPreviewImageSrc] = useState<string | null>(null);
  const [imageUploadError, setImageUploadError] = useState<string | null>(null);
  const [fileReferences, setFileReferences] = useState<FileReference[]>(initialInputState?.fileReferences ?? []);
  const [pendingPastes, setPendingPastes] = useState(0);
  const inputMaxWidth = fitContainer ? "100%" : compact ? 640 : 820;
  const inputHorizontalPadding = fitContainer ? 0 : compact ? 12 : 16;

  // Skill picker state
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [skillPickerRect, setSkillPickerRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [skillPickerIndex, setSkillPickerIndex] = useState(0);
  const [selectedSkills, setSelectedSkills] = useState<SkillOption[]>(initialInputState?.selectedSkills ?? (initialInputState?.selectedSkill ? [initialInputState.selectedSkill] : []));
  const [skillQuery, setSkillQuery] = useState<ReturnType<typeof skillQueryAtCaret>>(null);
  const skillPickerIndexRef = useRef(0);
  const skillPickerRef = useRef<HTMLDivElement>(null);
  const skillsFetchRef = useRef<AbortController | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const skillRowRef = useRef<HTMLDivElement>(null);
  useAutoGrowTextarea(textareaRef, value);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const modelDropdownPanelRef = useRef<HTMLDivElement>(null);
  const toolDropdownRef = useRef<HTMLDivElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const roleDropdownRef = useRef<HTMLDivElement>(null);
  const roleDropdownPanelRef = useRef<HTMLDivElement>(null);
  const rolesRequestIdRef = useRef(0);
  const thinkingDropdownRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pasteGenerationRef = useRef(0);

  // Track IME composition state to prevent candidate-confirming Enter from sending.
  // KeyboardEvent.isComposing is the standard signal; this ref covers browser event-order differences.
  const isComposingRef = useRef(false);
  // Sync isStreaming prop to a ref to avoid stale closure in handleSend / runSendAction.
  const isStreamingRef = useRef(isStreaming);
  isStreamingRef.current = isStreaming;
  // Local click/Enter latch: React prop updates are async, so a rapid double-click
  // can invoke handleSend twice before the button is re-rendered as disabled.
  const sendInFlightRef = useRef(false);
  const sendInFlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useImperativeHandle(ref, () => ({
    insertText(text: string) {
      const ta = textareaRef.current;
      if (!ta) {
        setValue((v) => v + (v ? " " : "") + text);
        return;
      }
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      const before = ta.value.slice(0, start);
      const after = ta.value.slice(end);
      const sep = before.length > 0 && !before.endsWith(" ") ? " " : "";
      const newVal = before + sep + text + after;
      setValue(newVal);
      requestAnimationFrame(() => {
        if (!ta) return;
        const pos = start + sep.length + text.length;
        ta.setSelectionRange(pos, pos);
        ta.focus();
        ta.style.height = "auto";
        ta.style.height = `${ta.scrollHeight}px`;
      });
    },
    addImages(files: File[]) {
      processImageFiles(files);
    },
    addReference(path: string) {
      const normalizedPath = path.trim();
      if (!normalizedPath) return;
      setFileReferences((prev) => {
        if (prev.some((ref) => ref.path === normalizedPath)) return prev;
        return [...prev, { path: normalizedPath, name: fileReferenceName(normalizedPath) }];
      });
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    toggleReference(path: string) {
      const normalizedPath = path.trim();
      if (!normalizedPath) return;
      setFileReferences((prev) => {
        if (prev.some((ref) => ref.path === normalizedPath)) {
          return prev.filter((ref) => ref.path !== normalizedPath);
        }
        return [...prev, { path: normalizedPath, name: fileReferenceName(normalizedPath) }];
      });
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    clearInput() {
      setValue("");
      setSelectedSkills([]);
      setFileReferences([]);
      pasteGenerationRef.current += 1;
      setAttachedImages((prev) => {
        prev.forEach(revokeAttachedImagePreview);
        return [];
      });
      saveInputStateRef?.current?.({
        value: "",
        attachedImages: [],
        selectedSkill: null,
        selectedSkills: [],
        fileReferences: [],
      });
      if (textareaRef.current) {
        textareaRef.current.value = "";
        textareaRef.current.style.height = "auto";
      }
    },
  }));

  const processImageFiles = useCallback((files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    if (!imageFiles.length) return;
    if (!cwd) {
      setImageUploadError("当前会话尚未设置工作目录，无法添加图片");
      return;
    }

    setImageUploadError(null);
    const pendingImages = imageFiles.map((file) => ({
      data: "",
      mimeType: file.type,
      previewUrl: URL.createObjectURL(file),
    }));

    // 先用本地 Object URL 立即展示，文件上传和落盘在后台完成。
    setAttachedImages((prev) => [...prev, ...pendingImages]);

    imageFiles.forEach(async (file, index) => {
      const pendingImage = pendingImages[index];
      try {
        const formData = new FormData();
        formData.append("image", file);
        formData.append("cwd", cwd);
        const res = await fetch("/api/chat-image-upload", {
          method: "POST",
          body: formData,
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "图片上传失败" }));
          throw new Error(err.error || "图片上传失败");
        }
        const result = await res.json() as { path: string; url: string; mimeType: string };
        setAttachedImages((prev) => prev.map((image) => image.previewUrl === pendingImage.previewUrl
          ? { ...image, mimeType: result.mimeType, previewUrl: "", filePath: result.path, fileUrl: result.url }
          : image));
        requestAnimationFrame(() => revokeAttachedImagePreview(pendingImage));
      } catch (error) {
        setAttachedImages((prev) => {
          if (!prev.some((image) => image.previewUrl === pendingImage.previewUrl)) return prev;
          revokeAttachedImagePreview(pendingImage);
          return prev.filter((image) => image.previewUrl !== pendingImage.previewUrl);
        });
        setImageUploadError(error instanceof Error ? error.message : "图片上传失败");
      }
    });
  }, [cwd]);

  useEffect(() => () => {
    pasteGenerationRef.current += 1;
  }, [cwd]);


  const removeImage = useCallback((index: number) => {
    setAttachedImages((prev) => {
      const next = [...prev];
      revokeAttachedImagePreview(next[index]);
      next.splice(index, 1);
      return next;
    });
  }, []);

  const clearImages = useCallback(() => {
    setAttachedImages((prev) => {
      prev.forEach(revokeAttachedImagePreview);
      return [];
    });
  }, []);

  const clearSubmittedInput = useCallback(() => {
    // React state updates are batched, while onSend can synchronously replace this
    // ChatInput (notably when a new-session placeholder adopts its real id). Clear
    // every source of input truth before handing control to the parent so neither
    // the current DOM nor a remount can restore the submitted text.
    if (textareaRef.current) {
      textareaRef.current.value = "";
      textareaRef.current.style.height = "auto";
    }
    setValue("");
    setSelectedSkills([]);
    clearImages();
    saveInputStateRef?.current?.({
      value: "",
      attachedImages: [],
      selectedSkill: null,
      selectedSkills: [],
      fileReferences,
    });
  }, [clearImages, fileReferences, saveInputStateRef]);

  const removeFileReference = useCallback((path: string) => {
    setFileReferences((prev) => prev.filter((ref) => ref.path !== path));
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const releaseSendInFlight = useCallback(() => {
    sendInFlightRef.current = false;
    if (sendInFlightTimerRef.current) {
      clearTimeout(sendInFlightTimerRef.current);
      sendInFlightTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!isStreaming) releaseSendInFlight();
  }, [isStreaming, releaseSendInFlight]);

  useEffect(() => {
    return () => {
      if (sendInFlightTimerRef.current) {
        clearTimeout(sendInFlightTimerRef.current);
      }
    };
  }, []);

  const handleSend = useCallback(() => {
    const currentValue = textareaRef.current?.value ?? value;
    const msg = currentValue.trim();
    const references = fileReferences.length ? [...fileReferences] : undefined;
    const skill = skillReference(selectedSkills.map((skill) => skill.name));
    if (!msg && !attachedImages.length && !skill && !references?.length) return;
    if (attachedImages.some((image) => !image.fileUrl && !image.data) || pendingPastes) return;
    if (isStreamingRef.current) return;
    if (sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    if (sendInFlightTimerRef.current) clearTimeout(sendInFlightTimerRef.current);
    sendInFlightTimerRef.current = setTimeout(() => {
      sendInFlightRef.current = false;
      sendInFlightTimerRef.current = null;
    }, 3000);
    const images = attachedImages.length ? attachedImages : undefined;
    if (onBeforeSend?.(msg, images, references, skill) === false) {
      sendInFlightRef.current = false;
      if (sendInFlightTimerRef.current) {
        clearTimeout(sendInFlightTimerRef.current);
        sendInFlightTimerRef.current = null;
      }
      return;
    }
    clearSubmittedInput();
    onSend(msg, images, references, skill);
  }, [value, selectedSkills, attachedImages, fileReferences, pendingPastes, onSend, onBeforeSend, clearSubmittedInput]);

  const sendQueued = useCallback((mode: "steer" | "followup") => {
    const currentValue = textareaRef.current?.value ?? value;
    const msg = currentValue.trim();
    const references = fileReferences.length ? [...fileReferences] : undefined;
    const skill = skillReference(selectedSkills.map((skill) => skill.name));
    if (!msg && !attachedImages.length && !skill && !references?.length) return;
    if (attachedImages.some((image) => !image.fileUrl && !image.data) || pendingPastes) return;
    const images = attachedImages.length ? attachedImages : undefined;
    clearSubmittedInput();
    if (mode === "steer" && onSteer) {
      onSteer(msg, images, references, skill);
    } else if (mode === "followup" && onFollowUp) {
      onFollowUp(msg, images, references, skill);
    }
  }, [value, selectedSkills, attachedImages, fileReferences, pendingPastes, onSteer, onFollowUp, clearSubmittedInput]);

  const fetchSkills = useCallback(async (cwd: string) => {
    if (textOnly) return;
    if (skillsFetchRef.current) {
      skillsFetchRef.current.abort();
    }
    const controller = new AbortController();
    skillsFetchRef.current = controller;
    try {
      const res = await fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.skills) return;
      setSkills(
        data.skills
          .filter((s: SkillOption) => !s.name?.startsWith("find-skills"))
          .map((s: SkillOption) => ({
            ...s,
            source: skillScope(s),
          }))
      );
    } catch {
      // ignore abort or fetch errors
    }
  }, [textOnly]);

  const setActiveSkillPickerIndex = useCallback((index: number) => {
    skillPickerIndexRef.current = index;
    setSkillPickerIndex(index);
  }, []);

  const closeSkillPicker = useCallback(() => {
    setSkillPickerOpen(false);
    setSkillQuery(null);
    setActiveSkillPickerIndex(0);
  }, [setActiveSkillPickerIndex]);

  const selectSkill = useCallback((skill: SkillOption) => {
    const ta = textareaRef.current;
    const currentValue = ta?.value ?? value;
    const query = skillPickerOpen ? skillQueryAtCaret(currentValue, ta?.selectionStart ?? currentValue.length) : null;
    const rest = query ? currentValue.slice(0, query.start) + currentValue.slice(query.end) : currentValue;
    const caret = query?.start ?? ta?.selectionStart ?? rest.length;
    setSelectedSkills((previous) => previous.some((item) => item.name === skill.name) ? previous : [...previous, skill]);
    setValue(rest);
    closeSkillPicker();
    requestAnimationFrame(() => {
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(caret, caret);
    });
  }, [value, skillPickerOpen, closeSkillPicker]);

  const handleTextChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    setValue(newValue);
    const query = skillQueryAtCaret(newValue, e.target.selectionStart);
    setSkillQuery(query);

    // Each slash token can add a skill without replacing prior selections or prose.
    if (cwd && query) {
      const ta = textareaRef.current;
      if (ta) {
        const taRect = ta.getBoundingClientRect();
        // Anchor the picker above the skill row when present, else above the textarea.
        const anchor = skillRowRef.current?.getBoundingClientRect().top ?? taRect.top;
        setSkillPickerRect({ top: anchor, left: taRect.left, width: taRect.width });
      }
      if (!skillPickerOpen) {
        fetchSkills(cwd);
        setSkillPickerOpen(true);
      }
      setActiveSkillPickerIndex(0);
    } else {
      if (skillPickerOpen) closeSkillPicker();
    }
  }, [skillPickerOpen, cwd, fetchSkills, closeSkillPicker, setActiveSkillPickerIndex]);

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback(() => {
    isComposingRef.current = false;
  }, []);

  const runSendAction = useCallback(() => {
    if (isStreamingRef.current && (onSteer || onFollowUp)) {
      sendQueued(onSteer ? "steer" : "followup");
    } else {
      handleSend();
    }
  }, [onSteer, onFollowUp, sendQueued, handleSend]);

  // Filtered skills for the picker
  const skillPickerMode = skillQuery ? "all" : null;
  const skillPickerFilter = skillQuery?.query.toLowerCase() ?? "";

  const filteredSkills = useMemo(() => {
    const available = skills.filter((skill) => !selectedSkills.some((selected) => selected.name === skill.name));
    if (!skillPickerFilter) return available;
    const q = skillPickerFilter;
    return available.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    );
  }, [skillPickerFilter, skills, selectedSkills]);

  const globalSkills = useMemo(() => (
    skillPickerMode === "all" ? filteredSkills.filter((s) => skillScope(s) === "global") : []
  ), [filteredSkills, skillPickerMode]);
  const projectSkills = useMemo(() => filteredSkills.filter((s) => skillScope(s) === "project"), [filteredSkills]);
  const visibleSkillPickerSkills = useMemo(() => (
    skillPickerMode === "all" ? [...globalSkills, ...projectSkills] : projectSkills
  ), [globalSkills, projectSkills, skillPickerMode]);

  const commonProjectSkills = useMemo(() => skills
    .filter((s) => skillScope(s) === "project" && !s.disableModelInvocation && !selectedSkills.some((selected) => selected.name === s.name)), [skills, selectedSkills]);

  useEffect(() => {
    if (!cwd) {
      setSkills([]);
      return;
    }
    fetchSkills(cwd);
    return () => {
      skillsFetchRef.current?.abort();
    };
  }, [cwd, fetchSkills]);

  // Reset skill picker index when filter changes
  useEffect(() => {
    setActiveSkillPickerIndex(0);
  }, [skillPickerFilter, setActiveSkillPickerIndex]);

  const handleSkillPickerKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (visibleSkillPickerSkills.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveSkillPickerIndex(Math.min(skillPickerIndexRef.current + 1, visibleSkillPickerSkills.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveSkillPickerIndex(Math.max(skillPickerIndexRef.current - 1, 0));
      return;
    }
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      e.preventDefault();
      const activeIndex = Math.min(skillPickerIndexRef.current, visibleSkillPickerSkills.length - 1);
      if (visibleSkillPickerSkills[activeIndex]) {
        selectSkill(visibleSkillPickerSkills[activeIndex]);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeSkillPicker();
      return;
    }
    // Let other keys pass through for normal typing
  }, [visibleSkillPickerSkills, setActiveSkillPickerIndex, selectSkill, closeSkillPicker]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const nativeEvent = e.nativeEvent as KeyboardEvent<HTMLTextAreaElement>["nativeEvent"] & {
        keyCode?: number;
      };

      // Never interpret an IME-managed key as an app shortcut. Safari may report
      // isComposing=false for the confirming Enter, but still exposes keyCode 229.
      if (
        isComposingRef.current ||
        nativeEvent.isComposing ||
        nativeEvent.keyCode === 229 ||
        e.key === "Process"
      ) {
        return;
      }

      // Handle skill picker keys only after excluding IME events.
      if (skillPickerOpen && visibleSkillPickerSkills.length > 0) {
        handleSkillPickerKeyDown(e);
        return;
      }

      if (selectedSkills.length > 0 && e.key === "Backspace") {
        const ta = e.currentTarget;
        const start = ta.selectionStart ?? 0;
        const end = ta.selectionEnd ?? 0;
        const isEmpty = ta.value.length === 0;
        const isBackspaceAtStart = e.key === "Backspace" && start === 0 && end === 0;
        if (isEmpty || isBackspaceAtStart) {
          e.preventDefault();
          setSelectedSkills((previous) => previous.slice(0, -1));
          return;
        }
      }

      const hasDraft = e.currentTarget.value.length > 0
        || attachedImages.length > 0
        || fileReferences.length > 0
        || selectedSkills.length > 0
        || pendingPastes > 0;
      if (
        isStreamingRef.current
        && e.key === " "
        && !e.repeat
        && !e.shiftKey
        && !e.ctrlKey
        && !e.altKey
        && !e.metaKey
        && !hasDraft
      ) {
        e.preventDefault();
        e.stopPropagation();
        onAbort();
        return;
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        runSendAction();
      }
    },
    [runSendAction, onAbort, skillPickerOpen, visibleSkillPickerSkills.length, handleSkillPickerKeyDown, selectedSkills, attachedImages.length, fileReferences.length, pendingPastes]
  );

  const handleInput = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, []);

  // Build model options: prefer modelList (has provider info), fallback to modelNames
  const modelOptions: ModelOption[] = (() => {
    if (modelList && modelList.length > 0) {
      return modelList.map((m) => ({ provider: m.provider, modelId: m.id, name: m.name, input: m.input }));
    }
    const fallback = Object.entries(modelNames ?? {}).map(([modelId, name]) => ({
      provider: model?.provider ?? "unknown",
      modelId,
      name,
    }));
    // Existing sessions already know their active model. Keep that control
    // visible even if the independent models metadata request is delayed.
    if (fallback.length === 0 && model) {
      return [{ provider: model.provider, modelId: model.modelId, name: model.modelId }];
    }
    return fallback;
  })();

  // Group options by provider, preserving insertion order
  const modelsByProvider: { provider: string; options: ModelOption[] }[] = [];
  for (const opt of modelOptions) {
    const group = modelsByProvider.find((g) => g.provider === opt.provider);
    if (group) group.options.push(opt);
    else modelsByProvider.push({ provider: opt.provider, options: [opt] });
  }

  const currentName = model
    ? (modelOptions.find((o) => o.modelId === model.modelId && o.provider === model.provider)?.name ?? model.modelId)
    : modelOptions.length > 0 ? modelOptions[0].name : null;

  const addFileReferences = useCallback((paths: string[], files: File[] = []) => {
    if (!paths.length) {
      const images = files.filter((file) => file.type.startsWith("image/"));
      if (images.length) processImageFiles(images);
      if (!images.length || images.length !== files.length) {
        setImageUploadError("无法获取文件原始路径，请复制文件路径后粘贴，或使用桌面端拖入文件");
      }
      return;
    }
    setImageUploadError(null);
    const uniquePaths = [...new Set(paths)];
    const isImage = (path: string) => /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(path);
    const references = uniquePaths.filter((path) => !isImage(path));
    setFileReferences((prev) => {
      const added = references.filter((path) => !prev.some((ref) => ref.path === path));
      return [...prev, ...added.map((path) => ({ path, name: fileReferenceName(path) }))];
    });
    const imagePaths = uniquePaths.filter(isImage);
    const generation = pasteGenerationRef.current;
    if (imagePaths.length && !cwd) {
      setImageUploadError("当前会话尚未设置工作目录，无法添加图片");
      return;
    }
    for (const imagePath of imagePaths) {
      const uploadId = crypto.randomUUID();
      setAttachedImages((prev) => [...prev, {
        uploadId, data: "", mimeType: "image/png", previewUrl: "",
      }]);
      void (async () => {
        try {
          const res = await fetch("/api/chat-image-upload", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: imagePath, cwd }),
          });
          const result = await res.json();
          if (!res.ok) throw new Error(result.error || "图片添加失败");
          if (generation !== pasteGenerationRef.current) return;
          setAttachedImages((prev) => prev.map((image) => image.uploadId === uploadId ? {
            ...image, mimeType: result.mimeType, previewUrl: result.url,
            filePath: result.path, fileUrl: result.url,
          } : image));
        } catch (error) {
          if (generation === pasteGenerationRef.current) {
            setAttachedImages((prev) => prev.filter((image) => image.uploadId !== uploadId));
            setImageUploadError(error instanceof Error ? error.message : "图片添加失败");
          }
        }
      })();
    }
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [cwd, processImageFiles]);
  const { dropZoneRef, dropSurface, isDragOver } = useDragDrop(addFileReferences);

  const selectReferenceFiles = useCallback(async () => {
    if (!window.__TAURI_INTERNALS__) {
      fileInputRef.current?.click();
      return;
    }
    const generation = pasteGenerationRef.current;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        title: "上传文件",
        multiple: true,
        directory: false,
        ...(cwd ? { defaultPath: cwd } : {}),
      });
      if (generation !== pasteGenerationRef.current || !selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      if (paths.length) addFileReferences(paths);
    } catch (error) {
      if (generation !== pasteGenerationRef.current) return;
      setImageUploadError(error instanceof Error ? error.message : "选择文件失败，请重试");
    }
  }, [cwd, addFileReferences]);

  const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (textOnly) return;
    const clipboard = e.clipboardData;
    const files = Array.from(clipboard.files);
    const images = files.filter((file) => file.type.startsWith("image/"));
    const uriList = clipboard.getData("text/uri-list");
    const text = clipboard.getData("text/plain");
    const desktop = !!window.__TAURI_INTERNALS__;
    if (!desktop && !files.length && !uriList.includes("file://")) return;
    e.preventDefault();
    // On Windows the native file-path lookup calls OpenClipboard. Avoid opening
    // it again while WebView2 is already delivering image bytes for this paste.
    if (images.length) {
      processImageFiles(images);
      return;
    }
    const textarea = e.currentTarget;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const originalValue = textarea.value;
    const generation = pasteGenerationRef.current;
    const insertText = () => {
      if (generation !== pasteGenerationRef.current || !text) return;
      const current = textarea.value;
      const insertionStart = current === originalValue ? start : textarea.selectionStart;
      const insertionEnd = current === originalValue ? end : textarea.selectionEnd;
      const next = current.slice(0, insertionStart) + text + current.slice(insertionEnd);
      textarea.value = next;
      setValue(next);
      textarea.setSelectionRange(insertionStart + text.length, insertionStart + text.length);
      handleInput();
    };
    setPendingPastes((count) => count + 1);
    setImageUploadError(null);
    try {
      const paths = await clipboardFilePaths(uriList, desktop);
      if (generation !== pasteGenerationRef.current) return;
      if (paths.length) {
        addFileReferences(paths);
        return;
      }
      if (files.some((file) => !file.type.startsWith("image/"))) {
        setImageUploadError("无法获取文件原始路径，请复制文件路径后粘贴；文件不会复制到项目中");
      }
      if (!files.length && text) {
        insertText();
      }
    } catch (error) {
      if (generation !== pasteGenerationRef.current) return;
      if (!files.length && text) insertText();
      else setImageUploadError(error instanceof Error ? error.message : "读取文件路径失败，请复制文件路径后粘贴");
    } finally {
      setPendingPastes((count) => count - 1);
    }
  }, [processImageFiles, handleInput, addFileReferences, textOnly]);



  // Persist input state to the cache ref whenever it changes
  useEffect(() => {
    saveInputStateRef?.current?.({ value, attachedImages, selectedSkill: null, selectedSkills, fileReferences });
  }, [value, attachedImages, selectedSkills, fileReferences, saveInputStateRef]);

  // Close dropdowns on outside click or Escape
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        modelDropdownPanelRef.current && !modelDropdownPanelRef.current.contains(e.target as Node)
      ) {
        setModelDropdownOpen(false);
      }
      if (
        roleDropdownRef.current && !roleDropdownRef.current.contains(e.target as Node) &&
        roleDropdownPanelRef.current && !roleDropdownPanelRef.current.contains(e.target as Node)
      ) {
        setRoleDropdownOpen(false);
      }
      if (toolDropdownRef.current && !toolDropdownRef.current.contains(e.target as Node)) {
        setToolDropdownOpen(false);
      }
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setMoreMenuOpen(false);
      }
      if (thinkingDropdownRef.current && !thinkingDropdownRef.current.contains(e.target as Node)) {
        setThinkingDropdownOpen(false);
      }
      if (skillPickerRef.current && !skillPickerRef.current.contains(e.target as Node)) {
        setSkillPickerOpen(false);
      }
    };
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setModelDropdownOpen(false);
      setRoleDropdownOpen(false);
      setToolDropdownOpen(false);
      setMoreMenuOpen(false);
      setThinkingDropdownOpen(false);
      setSkillPickerOpen(false);
    };
    document.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const loadRoles = useCallback(async () => {
    if (textOnly) return;
    const requestId = ++rolesRequestIdRef.current;
    const cacheKey = `deerhux.control-plane.roles.v1:${cwd ?? "global"}`;
    const applyRoles = (nextRoles: AgentRole[]) => {
      if (requestId !== rolesRequestIdRef.current || !Array.isArray(nextRoles) || nextRoles.length === 0) return;
      setRoles(nextRoles);
      onRolesLoaded?.(nextRoles);
    };

    // Render the last-known-good role selector synchronously before attempting
    // network I/O. The API is revalidated with retries in the background.
    const cached = readCachedJson<AgentRole[]>(cacheKey);
    if (cached) applyRoles(cached);

    try {
      const url = cwd ? `/api/roles?cwd=${encodeURIComponent(cwd)}` : "/api/roles";
      const data = await fetchJsonWithRetry<{ roles: AgentRole[] }>(url, { cache: "no-store" }, {
        attempts: 3,
        timeoutMs: 8_000,
      });
      if (!Array.isArray(data.roles) || data.roles.length === 0) return;
      writeCachedJson(cacheKey, data.roles);
      applyRoles(data.roles);
    } catch {
      // Keep cached/current roles. A transient control-plane failure must not
      // remove the selector while the active Agent SSE stream is healthy.
    }
  }, [onRolesLoaded, cwd, textOnly]);

  useEffect(() => {
    loadRoles();
    return subscribeToAppNotification("deerhux.roles-updated", () => { loadRoles(); });
  }, [loadRoles]);

  const selectedRole = roles.find((r) => r.id === currentRoleId) ?? roles.find((r) => r.id === "default");
  const roleSettingCount = selectedRole ? Object.values(selectedRole.blocks ?? {}).reduce((n, arr) => n + (arr?.length ?? 0), 0) : 0;
  const isUploadingImages = attachedImages.some((image) => !image.fileUrl && !image.data);
  const isReadingClipboard = pendingPastes > 0;
  const hasComposerContent = Boolean(value.trim() || attachedImages.length || selectedSkills.length || fileReferences.length);
  const hasSendableContent = hasComposerContent
    && !isUploadingImages
    && !isReadingClipboard;
  const hasFileReferences = fileReferences.length > 0;
  const retryNoticeKey = retryInfo
    ? [
        retryInfo.attempt,
        retryInfo.maxAttempts,
        retryInfo.errorCode ?? "",
        retryInfo.userMessage ?? retryInfo.errorMessage ?? "",
      ].join(":")
    : null;
  const modelErrorNoticeKey = lastModelError && !retryInfo ? lastModelError : null;
  const terminalNoticeKey = terminalNotice && !retryInfo ? `${terminalNotice.title}::${terminalNotice.detail ?? ""}` : null;
  const recoveryNoticeKey = stallLevel === "recovering" ? "recovering" : null;
  const showRetryNotice = useTransientNotice(retryNoticeKey);
  const showModelErrorNotice = useTransientNotice(modelErrorNoticeKey);
  const showTerminalNotice = useTransientNotice(terminalNoticeKey);
  const showRecoveryNotice = useTransientNotice(recoveryNoticeKey);
  const showImageUploadError = useTransientNotice(imageUploadError);
  const contextProgress = contextMetrics
    ? Math.min(1, contextMetrics.usedTokens / contextMetrics.contextWindow)
    : 0;
  const safeContextCapacity = contextMetrics
    ? contextMetrics.usedTokens + contextMetrics.safeRemainingTokens
    : 0;
  const contextPressure = contextMetrics && safeContextCapacity > 0
    ? contextMetrics.usedTokens / safeContextCapacity
    : 0;
  const contextPressureLevel = contextPressure >= 1
    ? "critical"
    : contextPressure >= 0.85 ? "warning" : "normal";

  useEffect(() => {
    if (previewImageSrc && !attachedImages.some((image) => attachedImagePreviewSource(image) === previewImageSrc)) {
      setPreviewImageSrc(null);
    }
  }, [attachedImages, previewImageSrc]);



  return (
    <div
      ref={dropZoneRef}
      data-chat-input
      style={{
        position: "relative",
        containerType: "inline-size",
        containerName: "chat-input",
        outlineOffset: -2,
        borderRadius: "var(--radius-panel)",
        flexShrink: 0,
        background: "transparent",
        padding: `0 ${inputHorizontalPadding}px ${compact ? 10 : 8}px`,
      }}
    >
      {isDragOver && dropSurface && createPortal(
        <div role="status" aria-label="松开以添加到此对话" style={{
          position: "absolute", inset: 0, zIndex: 100, pointerEvents: "none",
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "color-mix(in srgb, var(--bg) 78%, transparent)",
          backdropFilter: "blur(3px)", border: "3px dashed var(--accent)",
        }}>
          <div style={{ padding: "24px 36px", borderRadius: "var(--radius-panel)", background: "var(--bg-panel)", color: "var(--text)", textAlign: "center", boxShadow: "0 8px 32px rgba(0,0,0,0.12)" }}>
            <div style={{ fontSize: 18, fontWeight: 600 }}>松开以添加到此对话</div>
            <div style={{ marginTop: 8, fontSize: 13, color: "var(--text-muted)" }}>文件作为路径引用，图片作为图片附件</div>
          </div>
        </div>, dropSurface,
      )}
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) addFileReferences([], files);
          e.target.value = "";
        }}
      />
      <div style={{ maxWidth: inputMaxWidth, margin: "0 auto" }}>
        {modelCatalogError && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)",
            borderRadius: "var(--radius-control)", fontSize: 12, color: "rgba(200,60,60,0.9)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <AppIcon name="warning" size="inline" style={{...({ flexShrink: 0 })}} />
            <span style={{ flex: 1, whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.5 }}>
              {modelCatalogError}
            </span>
          </div>
        )}
        {/* Retry banner */}
        {retryInfo && showRetryNotice && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "rgba(234,179,8,0.08)", border: "1px solid rgba(234,179,8,0.25)",
            borderRadius: "var(--radius-control)", fontSize: 12, color: "rgba(180,130,0,0.9)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <AppIcon name="refresh" size="inline" style={{...({ flexShrink: 0 })}} />
            {retryInfo.userMessage ?? "正在自动重试"}
            <span style={{ opacity: 0.7, marginLeft: 4 }}>
              ({retryInfo.attempt}/{retryInfo.maxAttempts})
            </span>
          </div>
        )}
        {/* Model error banner */}
        {lastModelError && !retryInfo && showModelErrorNotice && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)",
            borderRadius: "var(--radius-control)", fontSize: 12, color: "rgba(200,60,60,0.9)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <AppIcon name="error" size="inline" style={{...({ flexShrink: 0 })}} />
            <span style={{ flex: 1, whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.5 }}>
              模型调用失败{lastModelError ? `：${lastModelError}` : ""}
            </span>
            {onClearModelError && (
              <button
                onClick={onClearModelError}
                style={{
                  flexShrink: 0,
                  background: "none", border: "none", cursor: "pointer",
                  padding: "1px 4px", color: "inherit", opacity: 0.6,
                  fontSize: 11, lineHeight: 1,
                }}
              >
                ✕
              </button>
            )}
          </div>
        )}
        {/* Terminal run notice — interrupted / session persist failed */}
        {terminalNotice && !retryInfo && showTerminalNotice && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "rgba(148,163,184,0.10)", border: "1px solid rgba(148,163,184,0.30)",
            borderRadius: "var(--radius-control)", fontSize: 12, color: "var(--text-muted, rgba(148,163,184,0.95))",
            display: "flex", alignItems: "flex-start", gap: 6,
          }}>
            <AppIcon name="warning" size="inline" style={{...({ flexShrink: 0, marginTop: 2 })}} />
            <span style={{ flex: 1, whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.5 }}>
              {terminalNotice.title}
              {terminalNotice.detail ? `\n${terminalNotice.detail}` : ""}
            </span>
            {onClearTerminalNotice && (
              <button
                onClick={onClearTerminalNotice}
                style={{
                  flexShrink: 0, background: "none", border: "none", cursor: "pointer",
                  padding: "1px 4px", color: "inherit", opacity: 0.6,
                  fontSize: 11, lineHeight: 1,
                }}
              >
                ✕
              </button>
            )}
          </div>
        )}
        {/* Recovering banner — auto-recovery in progress */}
        {stallLevel === "recovering" && showRecoveryNotice && (
          <div style={{
            marginBottom: 8, padding: "6px 12px",
            background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.25)",
            borderRadius: "var(--radius-panel)", fontSize: 12, color: "rgba(96,165,250,0.9)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <AppIcon name="refresh" size="inline" style={{...({ flexShrink: 0 })}} />
            正在中断旧连接并续跑…
          </div>
        )}
        {/* Image upload error banner */}
        {imageUploadError && showImageUploadError && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)",
            borderRadius: "var(--radius-control)", fontSize: 12, color: "rgba(200,60,60,0.9)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <AppIcon name="warning" size="inline" style={{...({ flexShrink: 0 })}} />
            <span style={{ flex: 1, whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.5 }}>
              {imageUploadError}
            </span>
            <button
              onClick={() => setImageUploadError(null)}
              style={{
                flexShrink: 0,
                background: "none", border: "none", cursor: "pointer",
                padding: "1px 4px", color: "inherit", opacity: 0.6,
                fontSize: 11, lineHeight: 1,
              }}
            >
              ✕
            </button>
          </div>
        )}
        {/* Image previews */}
        {attachedImages.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
            {attachedImages.map((img, i) => {
              const previewSrc = attachedImagePreviewSource(img);
              return (
                <div key={i} style={{ position: "relative", flexShrink: 0 }}>
                  {previewSrc ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={previewSrc}
                      alt=""
                      role="button"
                      tabIndex={0}
                      aria-label="查看待发送图片"
                      title="查看图片"
                      onClick={(event) => {
                        event.stopPropagation();
                        setPreviewImageSrc(previewSrc);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        event.stopPropagation();
                        setPreviewImageSrc(previewSrc);
                      }}
                      onError={() => {
                        setAttachedImages((prev) => prev.filter((image) => {
                          if (attachedImagePreviewSource(image) !== previewSrc) return true;
                          revokeAttachedImagePreview(image);
                          return false;
                        }));
                        setImageUploadError("图片无法读取，请重新添加");
                      }}
                      style={{ width: 56, height: 56, objectFit: "cover", borderRadius: "var(--radius-control)", border: "1px solid var(--border)", display: "block", opacity: img.fileUrl || img.data ? 1 : 0.65, cursor: "pointer" }}
                    />
                  ) : (
                    <div aria-label="正在准备图片预览" style={{ width: 56, height: 56, borderRadius: "var(--radius-control)", border: "1px solid var(--border)", background: "var(--bg-panel)" }} />
                  )}
                  {!img.fileUrl && !img.data && (
                    <span
                      role="status"
                      aria-label="图片上传中"
                      title="图片上传中"
                      style={{
                        position: "absolute", inset: 0,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        color: "#fff", background: "rgba(0,0,0,0.18)", borderRadius: "var(--radius-control)",
                        pointerEvents: "none",
                      }}
                    >
                      <AppIcon name="loading" size="toolbar" className="animate-spin" />
                    </span>
                  )}
                  <button
                    onClick={() => removeImage(i)}
                    style={{
                      position: "absolute", top: -4, right: -4,
                      width: 16, height: 16, borderRadius: "var(--radius-circle)",
                      background: "var(--bg-panel)", border: "1px solid var(--border)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      cursor: "pointer", padding: 0, color: "var(--text-muted)",
                    }}
                  >
                    <AppIcon name="close" size="inline" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Skill picker dropdown */}
        {skillPickerOpen && skillPickerRect && (() => {
          const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
          const totalSkills = visibleSkillPickerSkills.length;
          if (totalSkills === 0) return null;
          const bottom = viewportHeight - skillPickerRect.top + 6;
          const maxH = Math.max(120, Math.min(skillPickerRect.top - 8, viewportHeight * 0.5));
          return (
            <div ref={skillPickerRef} style={{
              position: "fixed",
              bottom, left: skillPickerRect.left,
              zIndex: 501, background: "var(--bg)", border: "1px solid var(--border)",
              borderRadius: "var(--radius-panel)", boxShadow: "0 -4px 16px rgba(0,0,0,0.12)",
              overflow: "hidden", width: "max-content", minWidth: Math.max(skillPickerRect.width, 320), maxWidth: 480,
              maxHeight: maxH, overflowY: "auto",
            }}>
              <div style={{ padding: "5px 12px", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
                选择技能（使用 ↑↓ 导航，Enter 选择，Esc 关闭）
              </div>
              {globalSkills.length > 0 && (
                <>
                  <div style={{ padding: "4px 12px 2px", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em", borderTop: "1px solid var(--border)" }}>
                    全局技能
                  </div>
                  {globalSkills.map((skill, gi) => {
                    const absIdx = gi;
                    const isActive = absIdx === skillPickerIndex;
                    return (
                      <button
                        key={skill.name}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => selectSkill(skill)}
                        style={{
                          display: "flex", alignItems: "flex-start", gap: 8,
                          width: "100%", padding: "7px 12px",
                          background: isActive ? "var(--bg-selected)" : "none",
                          border: "none",
                          color: isActive ? "var(--text)" : "var(--text-muted)",
                          cursor: "pointer", fontSize: 12, textAlign: "left",
                          fontWeight: isActive ? 500 : 400,
                          lineHeight: 1.5,
                        }}
                        onMouseEnter={(e) => { setSkillPickerIndex(absIdx); e.currentTarget.style.background = "var(--bg-hover)"; }}
                        onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                      >
                        <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--accent)", minWidth: "fit-content" }}>
                          /skill:{skill.name}
                        </span>
                        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {skill.description}
                        </span>
                      </button>
                    );
                  })}
                </>
              )}
              {projectSkills.length > 0 && (
                <>
                  <div style={{ padding: "4px 12px 2px", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em", borderTop: "1px solid var(--border)" }}>
                    项目技能
                  </div>
                  {projectSkills.map((skill, pi) => {
                    const absIdx = globalSkills.length + pi;
                    const isActive = absIdx === skillPickerIndex;
                    return (
                      <button
                        key={skill.name}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => selectSkill(skill)}
                        style={{
                          display: "flex", alignItems: "flex-start", gap: 8,
                          width: "100%", padding: "7px 12px",
                          background: isActive ? "var(--bg-selected)" : "none",
                          border: "none",
                          color: isActive ? "var(--text)" : "var(--text-muted)",
                          cursor: "pointer", fontSize: 12, textAlign: "left",
                          fontWeight: isActive ? 500 : 400,
                          lineHeight: 1.5,
                        }}
                        onMouseEnter={(e) => { setSkillPickerIndex(absIdx); e.currentTarget.style.background = "var(--bg-hover)"; }}
                        onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                      >
                        <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--accent)", minWidth: "fit-content" }}>
                          /skill:{skill.name}
                        </span>
                        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {skill.description}
                        </span>
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          );
        })()}

        {/* Input context row: project skills on the left, file references on the right */}
        {(commonProjectSkills.length > 0 || hasFileReferences) && (
          <div data-chat-context-reveal>
            <div
              ref={skillRowRef}
              data-chat-skill-row
              style={{
                display: "flex",
                alignItems: "flex-end",
                justifyContent: "space-between",
                gap: 6,
                minHeight: 0,
                marginBottom: 6,
                padding: "0 1px 2px",
              }}
            >
            <div
              data-chat-project-skills
              style={{
                flex: "1 1 0",
                minWidth: 0,
                display: "flex",
                alignItems: "center",
                gap: 6,
                overflowX: "hidden",
                overflowY: "auto",
                flexWrap: "wrap",
                maxHeight: 64,
                paddingRight: hasFileReferences ? 18 : 0,
                scrollbarWidth: "none",
                WebkitMaskImage: hasFileReferences
                  ? "linear-gradient(to right, #000 calc(100% - 26px), transparent)"
                  : undefined,
                maskImage: hasFileReferences
                  ? "linear-gradient(to right, #000 calc(100% - 26px), transparent)"
                  : undefined,
              }}
            >
              {commonProjectSkills.length > 0 && (
                <>
                  <span
                    style={{
                      flexShrink: 0,
                      fontSize: 11,
                      color: "var(--text-dim)",
                      marginRight: 2,
                    }}
                  >
                    项目技能
                  </span>
                  {commonProjectSkills.map((skill) => (
                    <button
                      key={skill.name}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                      }}
                      onClick={() => selectSkill(skill)}
                      title={skill.description ? `${skill.name} — ${skill.description}` : skill.name}
                      style={{
                        flexShrink: 0,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 5,
                        maxWidth: "min(180px, 100%)",
                        height: 26,
                        padding: "0 9px",
                        borderRadius: "var(--radius-small)",
                        border: "1px solid transparent",
                        background: "var(--bg-panel)",
                        color: "var(--text-muted)",
                        cursor: "pointer",
                        fontSize: 12,
                        fontWeight: 500,
                        letterSpacing: 0,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = "var(--bg-hover)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "var(--bg-panel)";
                      }}
                    >
                      <AppIcon name="skills" size="inline" />
                      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {skill.name}
                      </span>
                    </button>
                  ))}
                </>
              )}
            </div>
            {hasFileReferences && (
              <div
                data-chat-file-references
                style={{
                  flex: "0 1 38%",
                  minWidth: 0,
                  maxWidth: "38%",
                  marginLeft: 10,
                  display: "flex",
                  flexDirection: "column-reverse",
                  alignItems: "flex-end",
                  justifyContent: "flex-end",
                  gap: 6,
                  overflow: "visible",
                }}
              >
                <>
                  {fileReferences.map((ref, index) => {
                    const chip = (
                      <span
                        title={ref.path}
                        data-chat-context-chip
                        style={{
                          flexShrink: 0,
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 5,
                          maxWidth: 180,
                          height: 24,
                          padding: "0 6px 0 8px",
                          borderRadius: "var(--radius-small)",
                          background: "var(--bg-panel)",
                          border: "1px solid transparent",
                          color: "var(--text-muted)",
                          fontSize: 12,
                          fontWeight: 500,
                        }}
                      >
                        <AppIcon name="file" size="inline" style={{...({ flexShrink: 0 })}} />
                        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {ref.name}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeFileReference(ref.path)}
                          aria-label={`移除引用 ${ref.name}`}
                          title="移除引用"
                          style={{
                            flexShrink: 0,
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 14,
                            height: 14,
                            marginRight: -2,
                            border: "none",
                            borderRadius: "var(--radius-circle)",
                            background: "transparent",
                            color: "inherit",
                            cursor: "pointer",
                            padding: 0,
                            opacity: 0.45,
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.9"; e.currentTarget.style.background = "color-mix(in srgb, currentColor 9%, transparent)"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.45"; e.currentTarget.style.background = "transparent"; }}
                        >
                          <AppIcon name="close" size="inline" />
                        </button>
                      </span>
                    );

                    if (index !== 0) return <React.Fragment key={ref.path}>{chip}</React.Fragment>;
                    return (
                      <span key={ref.path} data-chat-file-reference-primary style={{ display: "inline-flex", alignItems: "center", justifyContent: "flex-end", gap: 6, maxWidth: "100%" }}>
                        <span style={{ flexShrink: 0, fontSize: 11, color: "var(--text-dim)", marginRight: 2 }}>引用</span>
                        {chip}
                      </span>
                    );
                  })}
                </>
              </div>
            )}
            </div>
          </div>
        )}

        {/* Text and controls share one composer surface. */}
        <div
          data-chat-composer
          style={{
            position: "relative",
            display: "flex",
            flexDirection: "column",
            gap: compact ? 7 : 8,
            alignItems: "stretch",
            background: "var(--composer-bg, var(--bg))",
            border: "none",
            borderRadius: "var(--radius-composer)",
            padding: compact ? "12px 10px 6px 12px" : "16px 12px 6px 16px",
            boxShadow: "var(--shadow-composer, var(--shadow-control))",
            transition: "background 0.15s, box-shadow 0.15s",
          } as React.CSSProperties}
        >
          {contextMetrics && (
            <div className="context-usage-summary">
              <button
                type="button"
                className="context-usage-trigger"
                aria-describedby={contextUsageDetailsId}
                aria-label={`上下文已使用 ${contextMetrics.usedTokens.toLocaleString()}，窗口 ${contextMetrics.contextWindow.toLocaleString()}`}
                data-pressure={contextPressureLevel}
                style={{
                  "--context-progress": `${contextProgress * 100}%`,
                } as React.CSSProperties}
              >
                <span
                  className="context-progress-track"
                  role="progressbar"
                  aria-label="上下文使用进度"
                  aria-valuemin={0}
                  aria-valuemax={contextMetrics.contextWindow}
                  aria-valuenow={Math.min(contextMetrics.usedTokens, contextMetrics.contextWindow)}
                >
                </span>
              </button>
              <div id={contextUsageDetailsId} className="context-usage-popover" role="tooltip">
                <div><span>上下文</span><strong>{contextMetrics.usedTokens.toLocaleString()} / {contextMetrics.contextWindow.toLocaleString()}</strong></div>
                <div><span>安全可用余额</span><strong>{contextMetrics.safeRemainingTokens.toLocaleString()}</strong></div>
                <div><span>最近缓存命中</span><strong>{contextMetrics.recentCacheHitRate == null ? "—" : `${Math.round(contextMetrics.recentCacheHitRate * 100)}%`}</strong></div>
                <div><span>会话缓存命中</span><strong>{contextMetrics.sessionCacheHitRate == null ? "—" : `${Math.round(contextMetrics.sessionCacheHitRate * 100)}%`}</strong></div>
              </div>
            </div>
          )}
          <div
            style={{
              position: "relative",
              flex: 1,
              minWidth: 0,
              alignSelf: "stretch",
              display: "flex",
              flexDirection: "column",
              alignItems: "stretch",
            }}
          >
            {selectedSkills.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, width: "100%", marginBottom: 6 }}>
                {selectedSkills.map((selectedSkill) => (
                  <span
                    key={selectedSkill.name}
                    title={`当前启用 skill: ${selectedSkill.name}`}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      maxWidth: 200,
                      height: 22,
                      padding: "0 5px 0 7px",
                      borderRadius: "var(--radius-small)",
                      background: "var(--bg-panel)",
                      border: "1px solid transparent",
                      color: "var(--text-muted)",
                      fontSize: 12,
                      fontWeight: 500,
                      letterSpacing: 0,
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        width: 4,
                        height: 4,
                        borderRadius: "var(--radius-circle)",
                        background: "currentColor",
                        opacity: 0.45,
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {selectedSkill.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => { setSelectedSkills((previous) => previous.filter((skill) => skill.name !== selectedSkill.name)); textareaRef.current?.focus(); }}
                      aria-label={`移除 skill ${selectedSkill.name}`}
                      title="移除技能"
                      style={{
                        flexShrink: 0,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 14,
                        height: 14,
                        marginRight: -2,
                        border: "none",
                        borderRadius: "var(--radius-circle)",
                        background: "transparent",
                        color: "inherit",
                        cursor: "pointer",
                        padding: 0,
                        opacity: 0.42,
                        outline: "none",
                        transition: "background 120ms ease, opacity 120ms ease, color 120ms ease",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "color-mix(in srgb, currentColor 9%, transparent)"; e.currentTarget.style.opacity = "0.85"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.opacity = "0.42"; }}
                      onFocus={(e) => { e.currentTarget.style.background = "color-mix(in srgb, currentColor 9%, transparent)"; e.currentTarget.style.opacity = "0.9"; }}
                      onBlur={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.opacity = "0.42"; }}
                    >
                      <AppIcon name="close" size="inline" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={value}
              onChange={handleTextChange}
              onKeyDown={handleKeyDown}
              onInput={handleInput}
              onPaste={handlePaste}
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={handleCompositionEnd}
              onBlur={() => {
                // Delay close so click on skill picker item can fire first
                setTimeout(() => setSkillPickerOpen(false), 150);
              }}
              placeholder={
                isStreaming && (onSteer || onFollowUp)
                  ? "Steer 立即注入 / Follow-up 排队…"
                  : isStreaming ? "智能体正在运行…"
                  : "输入消息…"
              }
              rows={2}
              style={{
                width: "100%",
                background: "none",
                border: "none",
                outline: "none",
                resize: "none",
                color: "var(--text)",
                fontSize: compact ? 13 : 14,
                lineHeight: compact ? "21px" : "22px",
                fontFamily: "inherit",
                padding: 0,
                paddingLeft: 0,
                margin: 0,
                display: "block",
                boxSizing: "border-box",
                minHeight: compact ? 40 : 44,
                maxHeight: "min(200px, 40dvh)",
                overflowX: "hidden",
                overflowY: "auto",
                overscrollBehaviorY: "contain",
                // Only reserve space for the skill chip on the first visual line.
                // Wrapped/subsequent lines should start from the normal left edge.
              }}
            />
          </div>

        {/* Bottom bar: left | center (context) | right */}
        <div data-composer-toolbar style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0, marginLeft: compact ? -6 : -8 }}>

          {/* LEFT: attach + model selector (idle) or steer/followup toggle (streaming) */}
          <div style={{ flex: "0 1 auto", minWidth: 0, display: "flex", alignItems: "center", gap: 2 }}>
            <button
              hidden={textOnly}
              onClick={() => { void selectReferenceFiles(); }}
              title="上传文件"
              aria-label="上传文件"
              type="button"
              style={{
                flexShrink: 0, display: textOnly ? "none" : "flex", alignItems: "center", justifyContent: "center",
                width: 32, height: 32, padding: 0,
                background: "none", border: "none",
                borderRadius: "var(--radius-control)",
                color: fileReferences.length ? "var(--accent)" : "var(--text-muted)",
                cursor: "pointer",
                transition: "background 0.12s, color 0.12s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = fileReferences.length ? "var(--accent)" : "var(--text)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "none";
                e.currentTarget.style.color = fileReferences.length ? "var(--accent)" : "var(--text-muted)";
              }}
            >
              <AppIcon name="attachment" size="toolbar" />
            </button>
            {/* Role selector */}
            {selectedRole && onRoleChange && (
              <div ref={roleDropdownRef} style={{ position: "relative", minWidth: 0 }}>
                <button
                  onClick={(e) => {
                    if (isStreaming) return;
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setRoleDropdownRect({ top: rect.top, left: rect.left, width: rect.width });
                    setRoleDropdownOpen((v) => !v);
                  }}
                  disabled={isStreaming}
                  title={roleSettingCount ? `当前角色有 ${roleSettingCount} 条设定` : "选择角色"}
                  aria-expanded={roleDropdownOpen}
                  style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: compact ? "0 8px" : "0 12px", lineHeight: "16px", height: 32, maxWidth: compact ? 92 : 180, width: "100%", minWidth: 0,
                    background: roleDropdownOpen ? "var(--bg-hover)" : "none",
                    border: "none", borderRadius: "var(--radius-control)",
                    color: "var(--text-muted)",
                    cursor: isStreaming ? "not-allowed" : "pointer",
                    fontSize: 12, opacity: isStreaming ? 0.5 : 1,
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => { if (!isStreaming) { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; } }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = roleDropdownOpen ? "var(--bg-hover)" : "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
                >
                  <AppIcon name="role" size="compact" />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selectedRole.name}</span>
                </button>
                {roleDropdownOpen && roleDropdownRect && (() => {
                  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
                  const bottom = viewportHeight - roleDropdownRect.top + 6;
                  const maxH = Math.max(120, Math.min(roleDropdownRect.top - 8, viewportHeight * 0.6));
                  return (
                  <div ref={roleDropdownPanelRef} style={{
                    position: "fixed", bottom, left: roleDropdownRect.left,
                    zIndex: 500, background: "var(--bg)", border: "1px solid var(--border)",
                    borderRadius: "var(--radius-panel)", boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                    overflow: "hidden", width: "max-content", minWidth: Math.max(roleDropdownRect.width, 260), maxHeight: maxH, overflowY: "auto",
                  }}>
                    <div style={{ padding: "6px 12px 4px", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>角色</div>
                    {roles.map((role) => {
                      const active = role.id === selectedRole.id;
                      const count = Object.values(role.blocks ?? {}).reduce((n, arr) => n + (arr?.length ?? 0), 0);
                      const scope = role.sourceInfo?.scope ?? (role.builtIn ? "builtIn" : "user");
                      const scopeText = scope === "project" ? "项目" : scope === "user" ? "全局" : scope === "builtIn" ? "内置" : scope;
                      return <button
                        key={role.id}
                        onClick={() => { onRoleChange(role.id); setRoleDropdownOpen(false); }}
                        style={{
                          display: "flex", alignItems: "center", gap: 8,
                          width: "100%", padding: "7px 12px",
                          background: active ? "var(--bg-selected)" : "none",
                          border: "none",
                          color: active ? "var(--text)" : "var(--text-muted)",
                          cursor: "pointer", fontSize: 12, textAlign: "left",
                          fontWeight: active ? 600 : 400,
                          whiteSpace: "nowrap",
                        }}
                        onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--bg-hover)"; }}
                        onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "none"; }}
                      >
                        {active ? <AppIcon name="check" size="inline" style={{color: "var(--accent)", }} /> : <span style={{ width: 10 }} />}
                        <span style={{ flex: 1 }}>{role.name}</span>
                        <span style={{ fontSize: 10, color: scope === "project" ? "var(--accent)" : "var(--text-dim)" }}>{scopeText}</span>
                        {count > 0 && <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{count} 条</span>}
                      </button>;
                    })}
                    <div style={{ borderTop: "1px solid var(--border)", padding: 0 }}>
                      <button
                        onClick={() => { setRoleDropdownOpen(false); onOpenRoleConfig?.(); }}
                        style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 12px", background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, textAlign: "left", whiteSpace: "nowrap" }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
                      >
                        <AppIcon name="add" size="inline" />
                        <span style={{ flex: 1 }}>创建 / 管理角色</span>
                      </button>
                    </div>
                  </div>
                  );
                })()}
              </div>
            )}
            {/* Model selector — visible always, disabled during streaming */}
            {modelOptions.length > 0 && currentName && onModelChange && (
                <div ref={dropdownRef} style={{ position: "relative", minWidth: 0 }}>
                  <button
                    aria-expanded={modelDropdownOpen}
                    onClick={(e) => {
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setModelDropdownRect({ top: rect.top, left: rect.left, width: rect.width });
                      setModelDropdownOpen((v) => !v);
                    }}
                    disabled={isStreaming}
                    style={{
                      display: "flex", alignItems: "center", gap: 6,
                      padding: compact ? "0 8px" : "0 12px",
                      lineHeight: "16px",
                      height: 32,
                      maxWidth: compact ? 118 : 220, width: "100%", minWidth: 0, overflow: "hidden",
                      background: modelDropdownOpen ? "var(--bg-hover)" : "none",
                      border: "none",
                      borderRadius: "var(--radius-control)",
                      color: "var(--text-muted)",
                      cursor: isStreaming ? "not-allowed" : "pointer",
                      fontSize: 12,
                      opacity: isStreaming ? 0.5 : 1,
                      transition: "background 0.12s, color 0.12s",
                    }}
                    onMouseEnter={(e) => {
                      if (isStreaming) return;
                      e.currentTarget.style.background = "var(--bg-hover)";
                      e.currentTarget.style.color = "var(--text)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = modelDropdownOpen ? "var(--bg-hover)" : "none";
                      e.currentTarget.style.color = "var(--text-muted)";
                    }}
                  >
                    <AppIcon name="model" size="inline" />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{currentName}</span>
                  </button>
                  {modelDropdownOpen && modelDropdownRect && (() => {
                    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
                    const bottom = viewportHeight - modelDropdownRect.top + 6;
                    const maxH = Math.max(120, Math.min(modelDropdownRect.top - 8, viewportHeight * 0.6));
                    return (
                    <div ref={modelDropdownPanelRef} style={{
                      position: "fixed",
                      bottom, left: modelDropdownRect.left,
                      zIndex: 500, background: "var(--bg)", border: "1px solid var(--border)",
                      borderRadius: "var(--radius-panel)", boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                      overflow: "hidden", width: "max-content", minWidth: modelDropdownRect.width, maxHeight: maxH, overflowY: "auto",
                    }}>
                      {modelsByProvider.map((group, gi) => (
                        <div key={group.provider}>
                          {(modelsByProvider.length > 1) && (
                            <div style={{
                              padding: "6px 12px 4px",
                              fontSize: 10, fontWeight: 600, color: "var(--text-dim)",
                              textTransform: "uppercase", letterSpacing: "0.07em",
                              borderTop: gi > 0 ? "1px solid var(--border)" : "none",
                            }}>
                              {group.provider}
                            </div>
                          )}
                          {group.options.map((opt) => {
                            const isActive = opt.modelId === model?.modelId && opt.provider === model?.provider;
                            return (
                              <button
                                key={`${opt.provider}:${opt.modelId}`}
                                onClick={() => { setModelDropdownOpen(false); if (!isActive) onModelChange(opt.provider, opt.modelId); }}
                                style={{
                                  display: "flex", alignItems: "center", gap: 8,
                                  width: "100%", padding: "7px 12px",
                                  background: isActive ? "var(--bg-selected)" : "none",
                                  border: "none",
                                  color: isActive ? "var(--text)" : "var(--text-muted)",
                                  cursor: "pointer", fontSize: 12, textAlign: "left",
                                  fontWeight: isActive ? 600 : 400,
                                  whiteSpace: "nowrap",
                                }}
                                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                              >
                                {isActive
                                  ? <AppIcon name="check" size="inline" style={{color: "var(--accent)", ...({ flexShrink: 0 })}} />
                                  : <span style={{ width: 10, flexShrink: 0 }} />}
                                {opt.name}
                              </button>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                    );
                  })()}
                </div>
            )}
          </div>

          {/* spacer */}
          <div style={{ flex: 1 }} />

          {/* RIGHT: collapsed assistant controls */}
          <div ref={moreMenuRef} style={{ flex: "0 0 auto", position: "relative", display: textOnly ? "none" : "flex", alignItems: "center", marginLeft: "auto" }}>
            {onSubagentToggle && (
              <button
                type="button"
                onClick={onSubagentToggle}
                title={subagentEnabled ? "Subagent 能力已开启：主 Agent 可派生隔离子 Agent（点击关闭）" : "开启 Subagent 能力：让主 Agent 可派生隔离子 Agent（点击开启）"}
                aria-label={subagentEnabled ? "关闭 Subagent 能力" : "开启 Subagent 能力"}
                aria-pressed={subagentEnabled}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 32,
                  height: 32,
                  padding: 0,
                  marginRight: 2,
                  background: subagentEnabled ? "var(--bg-selected)" : "none",
                  border: "none",
                  borderRadius: "var(--radius-control)",
                  color: subagentEnabled ? "var(--accent)" : "var(--text-muted)",
                  cursor: "pointer",
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = subagentEnabled ? "var(--bg-selected)" : "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = subagentEnabled ? "var(--bg-selected)" : "none";
                  e.currentTarget.style.color = subagentEnabled ? "var(--accent)" : "var(--text-muted)";
                }}
              >
                <AppIcon name="subagent" size="compact" />
              </button>
            )}
            <button
              type="button"
              onClick={() => setMoreMenuOpen((open) => !open)}
              title="更多输入选项"
              aria-label="更多输入选项"
              aria-expanded={moreMenuOpen}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 32,
                height: 32,
                padding: 0,
                background: moreMenuOpen ? "var(--bg-hover)" : "none",
                border: "none",
                borderRadius: "var(--radius-control)",
                color: moreMenuOpen ? "var(--text)" : "var(--text-muted)",
                cursor: "pointer",
                fontSize: 18,
                lineHeight: 1,
                fontWeight: 700,
                letterSpacing: 1,
                transition: "background 0.12s, color 0.12s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = "var(--text)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = moreMenuOpen ? "var(--bg-hover)" : "none";
                e.currentTarget.style.color = moreMenuOpen ? "var(--text)" : "var(--text-muted)";
              }}
            >
              <AppIcon name="more" size="toolbar" style={{...({ display: "block", flexShrink: 0 })}} />
            </button>
            {moreMenuOpen && (
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  bottom: "calc(100% + 8px)",
                  zIndex: 120,
                  display: "flex",
                  alignItems: "center",
                  gap: 3,
                  padding: 6,
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-panel)",
                  background: "var(--bg)",
                  boxShadow: "0 -8px 26px rgba(0,0,0,0.14)",
                  overflow: "visible",
                  whiteSpace: "nowrap",
                }}
              >
            {!isStreaming && onThinkingLevelChange && (
              <div ref={thinkingDropdownRef} style={{ position: "relative" }}>
                <button
                  onClick={() => !isStreaming && setThinkingDropdownOpen((v) => !v)}
                  disabled={isStreaming}
                  title="切换推理强度"
                  aria-expanded={thinkingDropdownOpen}
                  style={{
                    display: "flex", alignItems: "center", gap: 5,
                    padding: "8px 12px",
                    height: 32,
                    background: thinkingDropdownOpen ? "var(--bg-hover)" : "none",
                    border: "none",
                    borderRadius: "var(--radius-control)",
                    color: "var(--text-muted)",
                    cursor: isStreaming ? "not-allowed" : "pointer",
                    fontSize: 12,
                    opacity: isStreaming ? 0.5 : 1,
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    if (isStreaming) return;
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = thinkingDropdownOpen ? "var(--bg-hover)" : "none";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  <AppIcon name="thinking" size="inline" />
                  <span>{(() => {
                    const lvl = thinkingLevel ?? "auto";
                    if (lvl === "auto" || !thinkingLevelMap) return lvl;
                    const mapped = thinkingLevelMap[lvl];
                    return mapped != null ? mapped : lvl;
                  })()}</span>
                </button>
                {thinkingDropdownOpen && (
                  <div style={{
                    position: "absolute", bottom: "calc(100% + 6px)", right: 0,
                    zIndex: 100, background: "var(--bg)", border: "1px solid var(--border)",
                    borderRadius: "var(--radius-panel)", boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                    overflow: "hidden", minWidth: 180,
                  }}>
                    {THINKING_LEVELS.filter((lvl) => {
                      if (!availableThinkingLevels) return true;
                      if (lvl === "auto") return true;
                      return availableThinkingLevels.includes(lvl);
                    }).map((lvl) => {
                      const isActive = (thinkingLevel ?? "auto") === lvl;
                      const desc = THINKING_LEVEL_DESC[lvl];
                      const mappedVal = (lvl !== "auto" && thinkingLevelMap) ? thinkingLevelMap[lvl] : undefined;
                      const displayLabel = (mappedVal != null && mappedVal !== lvl) ? mappedVal : lvl;
                      const showOriginal = mappedVal != null && mappedVal !== lvl;
                      return (
                        <button
                          key={lvl}
                          onClick={() => { setThinkingDropdownOpen(false); if (!isActive) onThinkingLevelChange(lvl); }}
                          style={{
                            display: "flex", alignItems: "center", gap: 8,
                            width: "100%", padding: "7px 12px",
                            background: isActive ? "var(--bg-selected)" : "none",
                            border: "none",
                            color: isActive ? "var(--text)" : "var(--text-muted)",
                            cursor: "pointer", fontSize: 12, textAlign: "left",
                            fontWeight: isActive ? 600 : 400,
                            whiteSpace: "nowrap",
                          }}
                          onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                          onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                        >
                          {isActive
                            ? <AppIcon name="check" size="inline" style={{color: "var(--accent)", ...({ flexShrink: 0 })}} />
                            : <span style={{ width: 10, flexShrink: 0 }} />}
                          <span style={{ flex: 1 }}>
                            {displayLabel}
                            {showOriginal && <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginLeft: 5 }}>({lvl})</span>}
                          </span>
                          <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 8 }}>{desc}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {!isStreaming && onAgentModeChange && (
              <div ref={toolDropdownRef} style={{ position: "relative" }}>
                <button
                  onClick={() => !isStreaming && setToolDropdownOpen((v) => !v)}
                  disabled={isStreaming}
                  title="切换 Ask / Plan / Agent 模式"
                  aria-expanded={toolDropdownOpen}
                  style={{
                    display: "flex", alignItems: "center", gap: 5,
                    padding: "8px 12px",
                    height: 32,
                    background: toolDropdownOpen ? "var(--bg-hover)" : "none",
                    border: "none",
                    borderRadius: "var(--radius-control)",
                    color: "var(--text-muted)",
                    cursor: isStreaming ? "not-allowed" : "pointer",
                    fontSize: 12,
                    opacity: isStreaming ? 0.5 : 1,
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    if (isStreaming) return;
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = toolDropdownOpen ? "var(--bg-hover)" : "none";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  <AppIcon name="tools" size="inline" />
                  <span>{AGENT_MODES.find((mode) => mode.id === agentMode)?.label ?? "Agent"}</span>
                </button>
                {toolDropdownOpen && (
                  <div style={{
                    position: "absolute", bottom: "calc(100% + 6px)", right: 0,
                    zIndex: 100, background: "var(--bg)", border: "1px solid var(--border)",
                    borderRadius: "var(--radius-panel)", boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                    overflow: "hidden", minWidth: 210,
                  }}>
                    {AGENT_MODES.map((mode) => {
                      const isActive = agentMode === mode.id;
                      return (
                        <button
                          key={`desc-${mode.id}`}
                          onClick={() => { setToolDropdownOpen(false); if (!isActive) onAgentModeChange(mode.id); }}
                          style={{
                            display: "flex", alignItems: "center", gap: 8,
                            width: "100%", padding: "8px 12px",
                            background: isActive ? "var(--bg-selected)" : "none",
                            border: "none",
                            color: isActive ? "var(--text)" : "var(--text-muted)",
                            cursor: "pointer", fontSize: 12, textAlign: "left",
                            fontWeight: isActive ? 600 : 400,
                            whiteSpace: "nowrap",
                          }}
                          onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                          onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                        >
                          {isActive
                            ? <AppIcon name="check" size="inline" style={{color: "var(--accent)", ...({ flexShrink: 0 })}} />
                            : <span style={{ width: 10, flexShrink: 0 }} />}
                          <span style={{ flex: 1 }}>{mode.label}</span>
                          <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 8 }}>{mode.desc}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {!isStreaming && planReady && onBuildPlan && (
              <button
                onClick={onBuildPlan}
                title="按已批准的计划开始实施"
                style={{
                  display: "flex", alignItems: "center", gap: 5,
                  padding: "8px 12px",
                  height: 32,
                  background: "var(--accent)",
                  border: "none",
                  borderRadius: "var(--radius-control)",
                  color: "#fff",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 700,
                  boxShadow: "0 1px 3px rgba(37,99,235,0.25)",
                }}
              >
                Build
              </button>
            )}

            {!isStreaming && onCompact && (
              <div style={{ position: "relative" }}>
                {compactError && (
                  <div style={{
                    position: "absolute", bottom: "calc(100% + 6px)", right: 0,
                    background: "#1f2937", color: "#f87171",
                    fontSize: 11, padding: "4px 8px", borderRadius: "var(--radius-small)",
                    whiteSpace: "nowrap", pointerEvents: "none",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.2)", zIndex: 50,
                  }}>
                    {compactError}
                  </div>
                )}
                <button
                  onClick={isCompacting ? onAbortCompaction : onCompact}
                  disabled={isStreaming && !isCompacting}
                  style={{
                    display: "flex", alignItems: "center", gap: 5,
                    padding: "8px 12px",
                    height: 32,
                    background: isCompacting ? "rgba(239,68,68,0.08)" : "none",
                    border: "none",
                    borderRadius: "var(--radius-control)",
                    color: isCompacting ? "#ef4444" : "var(--text-muted)",
                    cursor: (isStreaming && !isCompacting) ? "not-allowed" : "pointer",
                    fontSize: 12, opacity: (isStreaming && !isCompacting) ? 0.5 : 1,
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    if (isStreaming && !isCompacting) return;
                    e.currentTarget.style.background = isCompacting ? "rgba(239,68,68,0.16)" : "var(--bg-hover)";
                    e.currentTarget.style.color = isCompacting ? "#ef4444" : "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = isCompacting ? "rgba(239,68,68,0.08)" : "none";
                    e.currentTarget.style.color = isCompacting ? "#ef4444" : "var(--text-muted)";
                  }}
                  title={isCompacting ? "停止压缩" : "压缩上下文"}
                >
                  {isCompacting ? (
                    <><AppIcon name="stop" size="inline" />压缩中…</>
                  ) : (
                    <><AppIcon name="compact" size="inline" />压缩</>
                  )}
                </button>
              </div>
            )}

            {onSoundToggle !== undefined && (
              <button
                onClick={onSoundToggle}
                title={soundEnabled ? "关闭完成提示音" : "开启完成提示音"}
                aria-pressed={soundEnabled}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 32, height: 32, padding: 0,
                  background: "none",
                  border: "none",
                  borderRadius: "var(--radius-control)",
                  color: soundEnabled ? "var(--text-muted)" : "var(--text-dim)",
                  cursor: "pointer",
                  opacity: soundEnabled ? 1 : 0.55,
                  transition: "background 0.12s, color 0.12s, opacity 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text)";
                  e.currentTarget.style.opacity = "1";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "none";
                  e.currentTarget.style.color = soundEnabled ? "var(--text-muted)" : "var(--text-dim)";
                  e.currentTarget.style.opacity = soundEnabled ? "1" : "0.55";
                }}
              >
                {soundEnabled ? (
                  <AppIcon name="sound-on" size="inline" />
                ) : (
                  <AppIcon name="sound-off" size="inline" />
                )}
              </button>
            )}

            {/* Auto-recovery mode toggle */}
            {onAutoRecoveryModeChange && autoRecoveryMode !== undefined && (
              <button
                onClick={() => {
                  const next = autoRecoveryMode === "off" ? "conservative" : autoRecoveryMode === "conservative" ? "aggressive" : "off";
                  onAutoRecoveryModeChange(next);
                }}
                title={`模型卡住自动续跑：${autoRecoveryMode === "off" ? "关闭" : autoRecoveryMode === "conservative" ? "保守" : "激进"}（点击切换）`}
                style={{
                  display: "flex", alignItems: "center", gap: 4,
                  padding: "2px 8px",
                  height: 32,
                  background: autoRecoveryMode === "aggressive" ? "rgba(234,179,8,0.1)" : "none",
                  border: autoRecoveryMode === "aggressive" ? "1px solid rgba(234,179,8,0.2)" : "1px solid transparent",
                  borderRadius: "var(--radius-control)",
                  color: autoRecoveryMode === "off" ? "var(--text-dim)" : "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: 11, fontWeight: autoRecoveryMode === "aggressive" ? 600 : 400,
                  opacity: autoRecoveryMode === "off" ? 0.5 : 1,
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text)";
                  e.currentTarget.style.borderColor = "transparent";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = autoRecoveryMode === "aggressive" ? "rgba(234,179,8,0.1)" : "none";
                  e.currentTarget.style.color = autoRecoveryMode === "off" ? "var(--text-dim)" : "var(--text-muted)";
                  e.currentTarget.style.borderColor = autoRecoveryMode === "aggressive" ? "rgba(234,179,8,0.2)" : "transparent";
                }}
              >
                <AppIcon name="refresh" size="inline" style={{...({ flexShrink: 0 })}} />
                {autoRecoveryMode === "off" ? "关闭" : autoRecoveryMode === "conservative" ? "保守" : "激进"}
              </button>
            )}
              </div>
            )}
          </div>

          {isStreaming ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, alignSelf: "center" }}>
              {onSteer && (
                <button
                  type="button"
                  onClick={() => sendQueued("steer")}
                  disabled={!hasSendableContent}
                  title="打断 Agent 当前运行，立即注入消息"
                  aria-label="立即注入消息"
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 32,
                    height: 32,
                    padding: 0,
                    background: hasSendableContent ? "var(--bg-panel)" : "var(--bg-panel)",
                    border: "none",
                    borderRadius: "var(--radius-circle)",
                    color: hasSendableContent ? "var(--text-muted)" : "var(--text-dim)",
                    cursor: hasSendableContent ? "pointer" : "not-allowed",
                    boxShadow: "none",
                    transition: "background 0.15s, box-shadow 0.15s",
                  }}
                >
                  <AppIcon name="forward" size="compact" />
                </button>
              )}
              {onFollowUp && (
                <button
                  type="button"
                  onClick={() => sendQueued("followup")}
                  disabled={!hasSendableContent}
                  title="在 Agent 完成后排队发送"
                  aria-label="排队发送消息"
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 32,
                    height: 32,
                    padding: 0,
                    background: hasSendableContent ? "var(--bg-panel)" : "var(--bg-panel)",
                    border: "none",
                    borderRadius: "var(--radius-circle)",
                    color: hasSendableContent ? "var(--text-muted)" : "var(--text-dim)",
                    cursor: hasSendableContent ? "pointer" : "not-allowed",
                    boxShadow: "none",
                    transition: "background 0.15s, box-shadow 0.15s",
                  }}
                >
                  <AppIcon name="steer" size="compact" />
                </button>
              )}
              <button
                type="button"
                onClick={onAbort}
                title="停止 Agent"
                aria-label="停止 Agent"
                style={{
                  flexShrink: 0,
                  alignSelf: "center",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 32,
                  height: 32,
                  padding: 0,
                  background: "#ef4444",
                  border: "none",
                  borderRadius: "var(--radius-circle)",
                  color: "#fff",
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 600,
                  letterSpacing: "-0.01em",
                  boxShadow: "0 1px 3px rgba(239,68,68,0.25)",
                  transition: "background 0.15s, box-shadow 0.15s",
                }}
              >
                <AppIcon name="stop" size="inline" />
              </button>
            </div>
          ) : (
            <SendIconButton
              onClick={handleSend}
              disabled={!hasSendableContent}
              hasContent={hasComposerContent}
              title={isReadingClipboard ? "正在读取文件路径" : isUploadingImages ? "图片上传中" : agentMode === "plan" ? "生成计划" : agentMode === "ask" ? "发送 Ask" : "发送 Agent"}
              busy={isReadingClipboard || isUploadingImages}
            />
          )}
        </div>
        </div>
      </div>
      <MessageImagePreview src={previewImageSrc} onClose={() => setPreviewImageSrc(null)} />
    </div>
  );
});
