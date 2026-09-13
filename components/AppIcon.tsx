import type { CSSProperties } from "react";
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, BookOpen, Check, ChevronDown,
  ChevronRight, Clock3, Cpu, Ellipsis, FolderOpen, GitBranch, Layers,
  LoaderCircle, Minimize2, Moon, Network, PanelLeft, PanelRight, Paperclip,
  Pin, Plus, RotateCcw, Search, Settings2, ShieldCheck, Square, Sun,
  Terminal, UserRound, X, CircleAlert, CircleX, File, Lightbulb, Wrench,
  Volume2, VolumeX, ArrowUpFromLine, FolderPlus, Trash2, Pencil, MessageSquare, MessageCircle, Eye,
} from "lucide-react";

const icons = {
  add: Plus, close: X, search: Search, settings: Settings2,
  "panel-left": PanelLeft, "panel-right": PanelRight,
  "theme-light": Sun, "theme-dark": Moon,
  model: Cpu, memory: BookOpen, mcp: Network, role: UserRound,
  skills: Layers, schedule: Clock3, files: FolderOpen, refresh: RotateCcw,
  send: ArrowUp, down: ArrowDown, back: ArrowLeft, forward: ArrowRight,
  more: Ellipsis, attachment: Paperclip, pin: Pin, check: Check,
  "chevron-down": ChevronDown, "chevron-right": ChevronRight,
  loading: LoaderCircle, stop: Square, subagent: GitBranch,
  compact: Minimize2, terminal: Terminal, security: ShieldCheck,
  warning: CircleAlert, error: CircleX, file: File, thinking: Lightbulb,
  tools: Wrench, "sound-on": Volume2, "sound-off": VolumeX,
  steer: ArrowUpFromLine, "add-folder": FolderPlus, delete: Trash2, edit: Pencil,
  prompt: MessageSquare, wechat: MessageCircle, preview: Eye,
} as const;

export type AppIconName = keyof typeof icons;
export const APP_ICON_SIZES = { inline: 12, compact: 14, toolbar: 16, section: 20 } as const;

type AppIconProps = {
  name: AppIconName;
  size?: keyof typeof APP_ICON_SIZES;
  className?: string;
  style?: CSSProperties;
  label?: string;
};

// Controls own labels; standalone status icons can opt into an accessible name.
export function AppIcon({ name, size = "toolbar", className, style, label }: AppIconProps) {
  const Icon = icons[name];
  return <Icon data-app-icon={name} className={className} size={APP_ICON_SIZES[size]}
    strokeWidth={1.75} aria-hidden={label ? undefined : true} role={label ? "img" : undefined} aria-label={label} focusable="false"
    style={{ display: "block", flexShrink: 0, ...style }} />;
}
