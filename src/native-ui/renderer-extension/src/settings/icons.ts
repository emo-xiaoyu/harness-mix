// Central icon catalog for the Harness Mix settings dialog. Every page and
// shared widget draws its glyphs through this module so names stay validated
// and lucide bundles are imported from a single place.
import type { IconNode } from "lucide";
import createElement from "lucide/dist/esm/createElement.mjs";
import Boxes from "lucide/dist/esm/icons/boxes.mjs";
import ChartColumn from "lucide/dist/esm/icons/chart-column.mjs";
import Check from "lucide/dist/esm/icons/circle-check.mjs";
import ChevronDown from "lucide/dist/esm/icons/chevron-down.mjs";
import ChevronLeft from "lucide/dist/esm/icons/chevron-left.mjs";
import ChevronRight from "lucide/dist/esm/icons/chevron-right.mjs";
import ChevronUp from "lucide/dist/esm/icons/chevron-up.mjs";
import CircleArrowUp from "lucide/dist/esm/icons/circle-arrow-up.mjs";
import CircleOff from "lucide/dist/esm/icons/circle-off.mjs";
import Copy from "lucide/dist/esm/icons/copy.mjs";
import Download from "lucide/dist/esm/icons/download.mjs";
import ExternalLink from "lucide/dist/esm/icons/external-link.mjs";
import FolderInput from "lucide/dist/esm/icons/folder-input.mjs";
import GripVertical from "lucide/dist/esm/icons/grip-vertical.mjs";
import HeartPulse from "lucide/dist/esm/icons/heart-pulse.mjs";
import Info from "lucide/dist/esm/icons/info.mjs";
import Languages from "lucide/dist/esm/icons/languages.mjs";
import Network from "lucide/dist/esm/icons/network.mjs";
import PlugZap from "lucide/dist/esm/icons/plug-zap.mjs";
import RefreshCw from "lucide/dist/esm/icons/refresh-cw.mjs";
import RotateCcw from "lucide/dist/esm/icons/rotate-ccw.mjs";
import Route from "lucide/dist/esm/icons/route.mjs";
import Settings from "lucide/dist/esm/icons/settings.mjs";
import Stethoscope from "lucide/dist/esm/icons/stethoscope.mjs";
import Star from "lucide/dist/esm/icons/star.mjs";
import TriangleAlert from "lucide/dist/esm/icons/triangle-alert.mjs";
import Ticket from "lucide/dist/esm/icons/ticket.mjs";
import Trash from "lucide/dist/esm/icons/trash-2.mjs";
import Terminal from "lucide/dist/esm/icons/terminal.mjs";
import Search from "lucide/dist/esm/icons/search.mjs";
import CircleHelp from "lucide/dist/esm/icons/circle-question-mark.mjs";
import X from "lucide/dist/esm/icons/x.mjs";
import Users from "lucide/dist/esm/icons/users.mjs";
import Plus from "lucide/dist/esm/icons/plus.mjs";
import Database from "lucide/dist/esm/icons/database.mjs";
import Palette from "lucide/dist/esm/icons/palette.mjs";
import ShieldCheck from "lucide/dist/esm/icons/shield-check.mjs";
import PawPrint from "lucide/dist/esm/icons/paw-print.mjs";
import harnessMixLogoUrl from "../../../../assets/brand-harness-mix.png";

export const RENDERER_SETTINGS_ICON_NAMES = [
  "settings",
  "close",
  "star",
  "language",
  "connections",
  "accounts",
  "session-import",
  "add",
  "model-pool",
  "routes",
  "gateway",
  "updates",
  "about",
  "info",
  "external-link",
  "refresh",
  "unavailable",
  "alert",
  "check",
  "diagnose",
  "copy",
  "download",
  "chevron-left",
  "chevron-right",
  "chevron-down",
  "chevron-up",
  "grip-vertical",
  "undo",
  "ticket",
  "trash",
  "terminal",
  "search",
  "help",
  "palette",
  "shield",
  "storage",
  "pets",
  "collaboration",
  "usage",
  "health",
] as const;

export type RendererSettingsIconName = (typeof RENDERER_SETTINGS_ICON_NAMES)[number];

const ICON_NODES: Readonly<Record<RendererSettingsIconName, IconNode>> = {
  settings: Settings,
  close: X,
  star: Star,
  language: Languages,
  connections: PlugZap,
  accounts: Users,
  "session-import": FolderInput,
  add: Plus,
  "model-pool": Boxes,
  routes: Route,
  gateway: Network,
  updates: CircleArrowUp,
  about: Info,
  info: Info,
  "external-link": ExternalLink,
  refresh: RefreshCw,
  unavailable: CircleOff,
  alert: TriangleAlert,
  check: Check,
  diagnose: Stethoscope,
  copy: Copy,
  download: Download,
  "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight,
  "chevron-down": ChevronDown,
  "chevron-up": ChevronUp,
  "grip-vertical": GripVertical,
  undo: RotateCcw,
  ticket: Ticket,
  trash: Trash,
  terminal: Terminal,
  search: Search,
  help: CircleHelp,
  palette: Palette,
  shield: ShieldCheck,
  storage: Database,
  pets: PawPrint,
  collaboration: Users,
  usage: ChartColumn,
  health: HeartPulse,
};

const KNOWN_ICON_NAMES: ReadonlySet<string> = new Set(RENDERER_SETTINGS_ICON_NAMES);

export function isRendererSettingsIconName(value: string): value is RendererSettingsIconName {
  return KNOWN_ICON_NAMES.has(value);
}

export function createRendererSettingsIcon(name: RendererSettingsIconName, size = 18): SVGElement {
  const svg = createElement(ICON_NODES[name], {
    width: size,
    height: size,
    "aria-hidden": "true",
    focusable: "false",
  });
  svg.classList.add("harnessmix-settings-icon");
  return svg;
}

export function createRendererSettingsBrandIcon(size = 22, ownerDocument?: Document): HTMLImageElement {
  const doc = ownerDocument ?? (typeof document !== "undefined" ? document : undefined);
  if (!doc) throw new Error("Document is required to create icon element");
  const logo = doc.createElement("img");
  logo.src = harnessMixLogoUrl;
  logo.alt = "";
  logo.width = size;
  logo.height = size;
  logo.draggable = false;
  logo.setAttribute("aria-hidden", "true");
  logo.style.width = `${size}px`;
  logo.style.height = `${size}px`;
  logo.style.objectFit = "contain";
  logo.classList.add("harnessmix-settings-icon");
  return logo;
}
