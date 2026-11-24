/**
 * Unified-diff previews for the `edit` and `write` approval prompts.
 *
 * Before a mode asks "Allow edit? (<path>)", the user should see what the call
 * is about to do: a `diff -u`-style preview of the file as it is and as it will
 * be. This module is pure (only `node:fs` for the default reader, injectable in
 * tests): the diff engine, the file-change builder, and the collapsed/expanded
 * line selection. The rendering and the interaction live in `approval-dialog.ts`
 * and the prompt flow in `approvals.ts`.
 *
 * The preview never decides anything: it only explains a prompt that the policy
 * engine already raised. A mode that never prompts (YOLO) never shows it.
 */

import { existsSync, readFileSync, statSync } from "node:fs";

/** Diff lines shown while the preview is collapsed. */
export const PREVIEW_COLLAPSED_LINES = 20;
/**
 * Cap for the expanded view. A very large diff must not push the editor off
 * the screen; the header still reports the full +added/-removed counts.
 */
export const PREVIEW_EXPANDED_MAX = 200;
/** A diff longer than this is cut even when expanded (`truncated`). */
export const MAX_DIFF_LINES = 2000;
/** A single line is cut here: minified bundles and generated files have no line structure. */
export const MAX_DIFF_LINE_LENGTH = 400;
/** Files larger than this get no preview: reading them costs more than the prompt is worth. */
export const MAX_PREVIEW_FILE_BYTES = 1_000_000;
/** Context lines around each change, as in `diff -u`. */
export const DIFF_CONTEXT = 3;
/** LCS table cells at most; beyond this the differing middle becomes one removal + addition block. */
const MAX_LCS_CELLS = 4_000_000;

/** How the call relates to the file: a new file, a targeted edit, or a full overwrite. */
export type PreviewKind = "create" | "edit" | "overwrite";

/** A ready-to-render change preview. */
export interface FileChangePreview {
  /** The path as the model wrote it (display only). */
  path: string;
  kind: PreviewKind;
  /** Lines the call adds and removes, across the whole diff (even when truncated). */
  added: number;
  removed: number;
  /** Unified diff lines, ANSI-free: `---`/`+++`/`@@` headers and ` `/`-`/`+` content. */
  lines: string[];
  /** An `edit` whose `oldText` was not found verbatim: the preview may not match the result. */
  approximate?: boolean;
  /** The diff was cut at MAX_DIFF_LINES. */
  truncated?: boolean;
}

/** The diff engine's output. */
export interface UnifiedDiff {
  lines: string[];
  added: number;
  removed: number;
  truncated: boolean;
}

/** One diff step: an unchanged line, a removal, or an addition. */
interface Op {
  t: "eq" | "del" | "add";
  line: string;
  oldNo?: number;
  newNo?: number;
}

/** Split into lines, tolerating CRLF; a trailing newline does not produce an empty last line. */
function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (normalized === "") return [];
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Line diff via a longest-common-subsequence table, with the common prefix and
 * suffix trimmed first (that is where a targeted edit's cost usually is). The
 * table is capped: past the cap the differing middle is shown as removals
 * followed by additions, which is what `diff` prints for a wholesale rewrite.
 */
function diffOps(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ t: "eq", line: a[i] });
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n > 0 && m > 0 && n * m <= MAX_LCS_CELLS) {
    const w = m + 1;
    const dp = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] =
          midA[i] === midB[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push({ t: "eq", line: midA[i] });
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
        ops.push({ t: "del", line: midA[i] });
        i++;
      } else {
        ops.push({ t: "add", line: midB[j] });
        j++;
      }
    }
    while (i < n) ops.push({ t: "del", line: midA[i++] });
    while (j < m) ops.push({ t: "add", line: midB[j++] });
  } else {
    for (const line of midA) ops.push({ t: "del", line });
    for (const line of midB) ops.push({ t: "add", line });
  }
  for (let i = endA; i < a.length; i++) ops.push({ t: "eq", line: a[i] });
  return ops;
}

/** Assign 1-based line numbers per side (an addition has no old number, a removal no new one). */
function numberOps(ops: Op[]): void {
  let oldNo = 1;
  let newNo = 1;
  for (const op of ops) {
    if (op.t !== "add") op.oldNo = oldNo++;
    if (op.t !== "del") op.newNo = newNo++;
  }
}

/** `[lo, hi)` ranges of the ops to print: each change plus its context, merged when they touch. */
function hunkRanges(ops: Op[], context: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].t === "eq") continue;
    const lo = Math.max(0, i - context);
    const hi = Math.min(ops.length, i + context + 1);
    const last = ranges[ranges.length - 1];
    if (last && lo <= last[1]) last[1] = Math.max(last[1], hi);
    else ranges.push([lo, hi]);
  }
  return ranges;
}

/** Cut a single line so a minified file cannot blow up one terminal row. */
function capLine(line: string): string {
  return line.length > MAX_DIFF_LINE_LENGTH ? `${line.slice(0, MAX_DIFF_LINE_LENGTH)}…` : line;
}

/**
 * A `diff -u`-style diff of `oldText` against `newText`. `create` labels the old
 * side `/dev/null`, as a new file's diff does. Returns at most MAX_DIFF_LINES
 * lines; `added`/`removed` still count the whole change.
 */
export function unifiedDiff(
  oldText: string,
  newText: string,
  filePath: string,
  opts: { context?: number; create?: boolean } = {},
): UnifiedDiff {
  const context = opts.context ?? DIFF_CONTEXT;
  const ops = diffOps(splitLines(oldText), splitLines(newText));
  numberOps(ops);

  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.t === "add") added++;
    else if (op.t === "del") removed++;
  }

  const lines: string[] = [`--- ${opts.create ? "/dev/null" : `a/${filePath}`}`, `+++ b/${filePath}`];
  let truncated = false;
  for (const [lo, hi] of hunkRanges(ops, context)) {
    if (lines.length >= MAX_DIFF_LINES) {
      truncated = true;
      break;
    }
    const slice = ops.slice(lo, hi);
    // The header's start is the first line printed for that side; with a zero
    // count (a pure insertion or deletion) unified diff names the line before.
    let oldBefore = 0;
    let newBefore = 0;
    for (let i = 0; i < lo; i++) {
      if (ops[i].t !== "add") oldBefore++;
      if (ops[i].t !== "del") newBefore++;
    }
    let oldCount = 0;
    let newCount = 0;
    let oldStart = oldBefore;
    let newStart = newBefore;
    for (const op of slice) {
      if (op.t !== "add") {
        if (oldCount === 0) oldStart = op.oldNo!;
        oldCount++;
      }
      if (op.t !== "del") {
        if (newCount === 0) newStart = op.newNo!;
        newCount++;
      }
    }
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of slice) {
      if (lines.length >= MAX_DIFF_LINES) {
        truncated = true;
        break;
      }
      lines.push(`${op.t === "eq" ? " " : op.t === "del" ? "-" : "+"}${capLine(op.line)}`);
    }
    if (truncated) break;
  }
  return { lines, added, removed, truncated };
}

/**
 * The edits an `edit` call carries: the current `edits` array, a single edit
 * object, a JSON-encoded array (some models send one), or the legacy
 * `{ path, oldText, newText }` shape.
 */
export function editList(input: Record<string, unknown>): Array<{ oldText: string; newText: string }> {
  const raw = input.edits;
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      list = undefined;
    }
  }
  const out: Array<{ oldText: string; newText: string }> = [];
  const push = (e: unknown): void => {
    if (!e || typeof e !== "object") return;
    const o = e as { oldText?: unknown; newText?: unknown };
    if (typeof o.oldText === "string" && typeof o.newText === "string" && o.oldText.length > 0) {
      out.push({ oldText: o.oldText, newText: o.newText });
    }
  };
  if (Array.isArray(list)) for (const e of list) push(e);
  else push(list);
  if (out.length === 0) push(input); // legacy single edit
  return out;
}

/** Default reader: UTF-8, refusing directories and files over MAX_PREVIEW_FILE_BYTES. */
export function readPreviewFile(p: string): string | undefined {
  try {
    const st = statSync(p);
    if (!st.isFile() || st.size > MAX_PREVIEW_FILE_BYTES) return undefined;
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}

/** What `fileChangePreview` needs; the fs functions are injectable for tests. */
export interface FileChangePreviewInput {
  /** "edit" or "write"; anything else has no preview. */
  toolName: string;
  /** The tool call's input. */
  input: Record<string, unknown>;
  /** The path as the model wrote it, shown in the header. */
  path: string;
  /** The path to read (absolute); defaults to `path`. */
  filePath?: string;
  /** Reader override; defaults to readPreviewFile. */
  readFile?: (p: string) => string | undefined;
  /** Existence check override; defaults to fs.existsSync. */
  exists?: (p: string) => boolean;
}

function buildPreview(
  path: string,
  kind: PreviewKind,
  before: string,
  after: string,
  approximate = false,
): FileChangePreview {
  const d = unifiedDiff(before, after, path, { create: kind === "create" });
  return {
    path,
    kind,
    added: d.added,
    removed: d.removed,
    lines: d.lines,
    approximate: approximate || undefined,
    truncated: d.truncated || undefined,
  };
}

/**
 * The preview for an `edit` or `write` call, or undefined when there is nothing
 * to show (not that tool, missing input, unreadable or unchanged file).
 *
 * `write` diffs the file on disk against the new content (a missing file is a
 * `create`). `edit` applies each replacement to the current content exactly as
 * the model wrote it; when an `oldText` is not found verbatim the preview is
 * marked `approximate` (pi's own matcher may still find it fuzzily).
 */
export function fileChangePreview(args: FileChangePreviewInput): FileChangePreview | undefined {
  const read = args.readFile ?? readPreviewFile;
  const exists = args.exists ?? existsSync;
  const abs = args.filePath ?? args.path;

  if (args.toolName === "write") {
    const content = args.input.content;
    if (typeof content !== "string") return undefined;
    const present = exists(abs);
    const before = present ? read(abs) : "";
    if (before === undefined) return undefined; // unreadable or too large
    if (present && before === content) return undefined; // nothing would change
    return buildPreview(args.path, present ? "overwrite" : "create", before, content);
  }

  if (args.toolName === "edit") {
    const before = read(abs);
    if (before === undefined) return undefined;
    const edits = editList(args.input);
    if (edits.length === 0) return undefined;
    let after = before;
    let approximate = false;
    for (const e of edits) {
      const at = after.indexOf(e.oldText);
      if (at < 0) {
        approximate = true;
        continue;
      }
      after = after.slice(0, at) + e.newText + after.slice(at + e.oldText.length);
    }
    if (after === before) return undefined;
    return buildPreview(args.path, "edit", before, after, approximate);
  }

  return undefined;
}

/** One header line: kind, path, and the counts (plus truncation/approximation notes). */
export function previewHeader(preview: FileChangePreview): string {
  const kind = preview.kind === "create" ? "new file" : preview.kind === "overwrite" ? "overwrite" : "edit";
  const notes = [
    preview.truncated ? "truncated" : "",
    preview.approximate ? "approximate match" : "",
  ].filter(Boolean);
  const suffix = notes.length > 0 ? `  (${notes.join(", ")})` : "";
  return `${kind} ${preview.path}  +${preview.added} -${preview.removed}${suffix}`;
}

/**
 * The lines to render: the head while collapsed, more while expanded, and
 * never more than the dialog can show (`maxVisible`, from the terminal height).
 */
export function previewLines(
  preview: FileChangePreview,
  expanded: boolean,
  maxVisible = Number.POSITIVE_INFINITY,
): { lines: string[]; hidden: number } {
  const cap = Math.max(1, Math.min(expanded ? PREVIEW_EXPANDED_MAX : PREVIEW_COLLAPSED_LINES, maxVisible));
  const total = preview.lines.length;
  if (total <= cap) return { lines: preview.lines, hidden: 0 };
  return { lines: preview.lines.slice(0, cap), hidden: total - cap };
}

/**
 * The preview as plain text, for hosts without `ctx.ui.custom()` (RPC and the
 * non-interactive modes): the header, the collapsed head, and how much is left.
 */
export function previewText(preview: FileChangePreview): string {
  const { lines, hidden } = previewLines(preview, false);
  const more = hidden > 0 ? [`… ${hidden} more diff line${hidden === 1 ? "" : "s"}`] : [];
  return [previewHeader(preview), ...lines, ...more].join("\n");
}
