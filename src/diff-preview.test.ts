import assert from "node:assert/strict";
import test from "node:test";
import {
  DIFF_CONTEXT,
  editList,
  fileChangePreview,
  MAX_DIFF_LINE_LENGTH,
  MAX_DIFF_LINES,
  previewHeader,
  previewLines,
  previewText,
  PREVIEW_COLLAPSED_LINES,
  PREVIEW_EXPANDED_MAX,
  unifiedDiff,
} from "./diff-preview.ts";

const lines = (n: number, prefix = "line"): string[] => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);

test("unifiedDiff: a one-line change prints a -u hunk with context and counts", () => {
  const before = lines(10);
  const after = [...before];
  after[4] = "changed";
  const d = unifiedDiff(before.join("\n"), after.join("\n"), "src/a.ts");
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  assert.equal(d.truncated, false);
  assert.deepEqual(d.lines, [
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    `@@ -${5 - DIFF_CONTEXT},${DIFF_CONTEXT * 2 + 1} +${5 - DIFF_CONTEXT},${DIFF_CONTEXT * 2 + 1} @@`,
    " line 2",
    " line 3",
    " line 4",
    "-line 5",
    "+changed",
    " line 6",
    " line 7",
    " line 8",
  ]);
});

test("unifiedDiff: separated changes become separate hunks; nearby ones merge", () => {
  const before = lines(40);
  const far = [...before];
  far[1] = "top";
  far[38] = "bottom";
  const d = unifiedDiff(before.join("\n"), far.join("\n"), "x");
  assert.equal(d.lines.filter((l) => l.startsWith("@@")).length, 2);
  assert.equal(d.added, 2);
  assert.equal(d.removed, 2);

  const near = [...before];
  near[10] = "a";
  near[12] = "b";
  const merged = unifiedDiff(before.join("\n"), near.join("\n"), "x");
  assert.equal(merged.lines.filter((l) => l.startsWith("@@")).length, 1);
});

test("unifiedDiff: an insertion into an empty file names the line before and counts zero", () => {
  const d = unifiedDiff("", "one\ntwo\n", "new.md", { create: true });
  assert.deepEqual(d.lines, [
    "--- /dev/null",
    "+++ b/new.md",
    "@@ -0,0 +1,2 @@",
    "+one",
    "+two",
  ]);
  assert.equal(d.added, 2);
  assert.equal(d.removed, 0);
});

test("unifiedDiff: identical text has headers and no hunks", () => {
  const d = unifiedDiff("same\n", "same\n", "x");
  assert.deepEqual(d.lines, ["--- a/x", "+++ b/x"]);
  assert.equal(d.added, 0);
  assert.equal(d.removed, 0);
});

test("unifiedDiff: CRLF and a missing trailing newline do not create phantom lines", () => {
  const d = unifiedDiff("a\r\nb\r\n", "a\nb\nc", "x");
  assert.deepEqual(d.lines.slice(2), ["@@ -1,2 +1,3 @@", " a", " b", "+c"]);
});

test("unifiedDiff: a very long line is cut at MAX_DIFF_LINE_LENGTH", () => {
  const long = "x".repeat(MAX_DIFF_LINE_LENGTH + 100);
  const d = unifiedDiff("", `${long}\n`, "x", { create: true });
  const added = d.lines.find((l) => l.startsWith("+") && !l.startsWith("+++"))!;
  assert.equal(added.length, MAX_DIFF_LINE_LENGTH + 2); // "+", the cap, and the ellipsis
  assert.ok(added.endsWith("…"));
});

test("unifiedDiff: a huge diff is cut at MAX_DIFF_LINES and says so", () => {
  const before = lines(MAX_DIFF_LINES + 500, "old");
  const after = lines(MAX_DIFF_LINES + 500, "new");
  const d = unifiedDiff(before.join("\n"), after.join("\n"), "big");
  assert.equal(d.truncated, true);
  assert.equal(d.lines.length, MAX_DIFF_LINES);
  // The counts still describe the whole change, not the cut.
  assert.equal(d.added, before.length);
  assert.equal(d.removed, before.length);
});

test("editList: current, single-object, JSON-string and legacy shapes", () => {
  const one = [{ oldText: "a", newText: "b" }];
  assert.deepEqual(editList({ edits: one }), one);
  assert.deepEqual(editList({ edits: { oldText: "a", newText: "b" } }), one);
  assert.deepEqual(editList({ edits: JSON.stringify(one) }), one);
  assert.deepEqual(editList({ oldText: "a", newText: "b" }), one); // legacy
  assert.deepEqual(editList({ edits: [] }), []);
  assert.deepEqual(editList({ edits: [{ oldText: "", newText: "x" }] }), []); // empty oldText is invalid
  assert.deepEqual(editList({}), []);
});

test("fileChangePreview: write of a new file is a create diff", () => {
  const p = fileChangePreview({
    toolName: "write",
    input: { content: "hello\nworld\n" },
    path: "plan/x.md",
    exists: () => false,
    readFile: () => undefined,
  });
  assert.ok(p);
  assert.equal(p.kind, "create");
  assert.equal(p.added, 2);
  assert.deepEqual(p.lines, ["--- /dev/null", "+++ b/plan/x.md", "@@ -0,0 +1,2 @@", "+hello", "+world"]);
});

test("fileChangePreview: write over an existing file diffs old against new", () => {
  const p = fileChangePreview({
    toolName: "write",
    input: { content: "b\n" },
    path: "x",
    exists: () => true,
    readFile: () => "a\n",
  });
  assert.ok(p);
  assert.equal(p.kind, "overwrite");
  assert.equal(p.added, 1);
  assert.equal(p.removed, 1);
});

test("fileChangePreview: no preview when there is nothing to show", () => {
  const base = { path: "x", exists: () => true };
  // unchanged content
  assert.equal(
    fileChangePreview({ ...base, toolName: "write", input: { content: "a\n" }, readFile: () => "a\n" }),
    undefined,
  );
  // missing input
  assert.equal(fileChangePreview({ ...base, toolName: "write", input: {}, readFile: () => "a\n" }), undefined);
  // unreadable / too large (the reader refuses)
  assert.equal(
    fileChangePreview({ ...base, toolName: "write", input: { content: "b\n" }, readFile: () => undefined }),
    undefined,
  );
  // other tools have no preview
  assert.equal(fileChangePreview({ ...base, toolName: "read", input: { path: "x" } }), undefined);
});

test("fileChangePreview: edit applies its replacements exactly", () => {
  const p = fileChangePreview({
    toolName: "edit",
    input: { edits: [{ oldText: "two", newText: "TWO" }] },
    path: "x",
    readFile: () => "one\ntwo\nthree\n",
  });
  assert.ok(p);
  assert.equal(p.kind, "edit");
  assert.equal(p.approximate, undefined);
  assert.ok(p.lines.includes("-two"));
  assert.ok(p.lines.includes("+TWO"));
});

test("fileChangePreview: an edit that does not match verbatim is marked approximate", () => {
  const p = fileChangePreview({
    toolName: "edit",
    input: { edits: [{ oldText: "missing", newText: "x" }, { oldText: "two", newText: "TWO" }] },
    path: "x",
    readFile: () => "one\ntwo\n",
  });
  assert.ok(p);
  assert.equal(p.approximate, true);
  assert.match(previewHeader(p), /approximate match/);
});

test("fileChangePreview: an edit that changes nothing has no preview", () => {
  const p = fileChangePreview({
    toolName: "edit",
    input: { edits: [{ oldText: "nope", newText: "x" }] },
    path: "x",
    readFile: () => "one\ntwo\n",
  });
  assert.equal(p, undefined);
});

test("previewLines: collapsed shows the head, expanded shows more", () => {
  const lines = Array.from({ length: PREVIEW_EXPANDED_MAX + 50 }, (_, i) => `+${i}`);
  const preview = { path: "x", kind: "edit" as const, added: lines.length, removed: 0, lines };
  const collapsed = previewLines(preview, false);
  assert.equal(collapsed.lines.length, PREVIEW_COLLAPSED_LINES);
  assert.equal(collapsed.hidden, lines.length - PREVIEW_COLLAPSED_LINES);
  const expanded = previewLines(preview, true);
  assert.equal(expanded.lines.length, PREVIEW_EXPANDED_MAX);
  assert.equal(expanded.hidden, lines.length - PREVIEW_EXPANDED_MAX);
  // A short terminal bounds even the expanded view.
  const bounded = previewLines(preview, true, 10);
  assert.equal(bounded.lines.length, 10);
  assert.equal(bounded.hidden, lines.length - 10);
  // A short diff has nothing hidden in either state.
  const small = { ...preview, lines: lines.slice(0, 3) };
  assert.deepEqual(previewLines(small, false), { lines: small.lines, hidden: 0 });
});

test("previewText: header, collapsed head and a 'more lines' note", () => {
  const lines = Array.from({ length: PREVIEW_COLLAPSED_LINES + 5 }, (_, i) => `+${i}`);
  const preview = { path: "src/a.ts", kind: "edit" as const, added: lines.length, removed: 0, lines };
  const text = previewText(preview);
  assert.equal(text.split("\n")[0], previewHeader(preview));
  assert.match(text, /\+25 -0/);
  assert.match(text, /… 5 more diff lines/);
  assert.equal(text.split("\n").length, 1 + PREVIEW_COLLAPSED_LINES + 1);
});
