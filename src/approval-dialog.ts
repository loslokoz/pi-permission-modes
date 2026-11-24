/**
 * The approval dialog with a unified-diff preview (TUI only).
 *
 * pi's stock selector (`ctx.ui.select`) renders its title as plain text, which
 * cannot collapse: a 400-line diff would flood the editor. This component
 * renders the same three-way prompt plus the change preview, collapsed to
 * PREVIEW_COLLAPSED_LINES and expandable with `e`, ctrl+o (the app's
 * "expand tools" binding) or a mouse click, so the user reviews the change
 * before allowing it.
 *
 * pi-tui is loaded LAZILY (like show-plan.ts): the caller asks `loadTui()`
 * first and falls back to `ui.select` when it cannot be resolved, so the
 * module loads in hosts that ship no TUI. Everything imported from pi-tui and
 * pi-coding-agent is type-only and erased at runtime.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import {
  type FileChangePreview,
  previewHeader,
  previewLines,
} from "./diff-preview.ts";

export type Tui = typeof import("@earendil-works/pi-tui");

let _tui: Tui | undefined;
let _tried = false;

/** Resolve pi-tui once; undefined (cached) when it cannot be loaded. */
export async function loadTui(): Promise<Tui | undefined> {
  if (!_tried) {
    _tried = true;
    try {
      _tui = await import("@earendil-works/pi-tui");
    } catch {
      _tui = undefined;
    }
  }
  return _tui;
}

/** What the dialog renders and what it resolves to. */
export interface ApprovalDialogArgs {
  /** The prompt title, e.g. `Allow edit? (src/a.ts)`. */
  title: string;
  /** The prompt options (Allow once / Allow for session / Deny / …). */
  options: string[];
  preview: FileChangePreview;
  /** Called with the chosen option, or undefined on cancel. */
  done: (choice: string | undefined) => void;
}

/** Colour one diff line by its role, with pi's own diff tokens. */
function styleDiffLine(theme: Theme, line: string): string {
  const text = line.replace(/\t/g, "   "); // tabs would land on terminal tab stops, not on the diff column
  if (text.startsWith("+++") || text.startsWith("---")) return theme.fg("muted", theme.bold(text));
  if (text.startsWith("@@")) return theme.fg("accent", text);
  if (text.startsWith("+")) return theme.fg("toolDiffAdded", text);
  if (text.startsWith("-")) return theme.fg("toolDiffRemoved", text);
  return theme.fg("toolDiffContext", text);
}

/**
 * The dialog: a bordered box with the title, the preview, the options and a
 * key hint. Up/down (or j/k) moves, enter selects, escape cancels; `e`,
 * ctrl+o or a click toggles the collapsed/expanded preview.
 */
class ApprovalDialog implements Component {
  private selected = 0;
  private expanded = false;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private readonly lib: Tui;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly args: ApprovalDialogArgs;

  constructor(lib: Tui, tui: TUI, theme: Theme, keybindings: KeybindingsManager, args: ApprovalDialogArgs) {
    this.lib = lib;
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.args = args;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private get maxVisible(): number {
    // Keep the box on screen: the terminal height minus the chrome around the diff.
    const rows = this.tui.terminal?.rows ?? 40;
    return Math.max(1, rows - (11 + this.args.options.length));
  }

  private get hasMore(): boolean {
    return previewLines(this.args.preview, false, this.maxVisible).hidden > 0;
  }

  private refresh(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const t = this.theme;
    const cut = (line: string) => this.lib.truncateToWidth(line, width);
    const out: string[] = [];
    out.push(t.fg("borderMuted", "─".repeat(width)));
    out.push("");
    out.push(cut(t.fg("accent", t.bold(this.args.title))));
    out.push("");
    out.push(cut(t.fg("muted", previewHeader(this.args.preview))));
    const { lines, hidden } = previewLines(this.args.preview, this.expanded, this.maxVisible);
    for (const line of lines) out.push(cut(styleDiffLine(t, line)));
    if (hidden > 0) {
      const note = this.expanded
        ? `… ${hidden} more diff line${hidden === 1 ? "" : "s"} not shown`
        : `… ${hidden} more diff line${hidden === 1 ? "" : "s"} — press e or click to expand`;
      out.push(cut(t.fg("muted", note)));
    }
    out.push("");
    this.args.options.forEach((option, i) => {
      out.push(cut(i === this.selected ? `${t.fg("accent", "→ ")}${t.fg("accent", option)}` : `  ${t.fg("text", option)}`));
    });
    out.push("");
    const expandHint = this.hasMore ? ` · ${this.expanded ? "e collapse" : "e expand"}` : "";
    out.push(cut(t.fg("dim", `↑↓ move · enter select · esc cancel${expandHint}`)));
    out.push("");
    out.push(t.fg("borderMuted", "─".repeat(width)));
    this.cachedWidth = width;
    this.cachedLines = out;
    return out;
  }

  handleInput(data: string): void {
    const kb = this.keybindings;
    if (this.hasMore && (data === "e" || kb.matches(data, "app.tools.expand"))) {
      this.expanded = !this.expanded;
      this.refresh();
      return;
    }
    if (kb.matches(data, "tui.select.up") || data === "k") {
      this.selected = Math.max(0, this.selected - 1);
      this.refresh();
      return;
    }
    if (kb.matches(data, "tui.select.down") || data === "j") {
      this.selected = Math.min(this.args.options.length - 1, this.selected + 1);
      this.refresh();
      return;
    }
    if (kb.matches(data, "tui.select.confirm") || data === "\n") {
      const choice = this.args.options[this.selected];
      if (choice) this.args.done(choice);
      return;
    }
    if (kb.matches(data, "tui.select.cancel")) this.args.done(undefined);
  }

  /**
   * A click on the preview toggles it too. Typed loosely and optional: only
   * newer pi-tui hosts dispatch mouse events (fullscreen mode), and older ones
   * have no mouse API in `Component` at all.
   */
  handleMouse(event: { type?: string; button?: string }): { handled: boolean; render: boolean } | undefined {
    if (event.type !== "click" || event.button !== "left" || !this.hasMore) return undefined;
    this.expanded = !this.expanded;
    this.refresh();
    return { handled: true, render: true };
  }
}

/** Build the dialog. `lib` must come from `loadTui()` (the caller already checked it). */
export function createApprovalDialog(
  lib: Tui,
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  args: ApprovalDialogArgs,
): Component {
  return new ApprovalDialog(lib, tui, theme, keybindings, args);
}
