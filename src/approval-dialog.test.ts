/**
 * The approval dialog's rendering and keys, against a fake theme/keybindings
 * and the real pi-tui utilities (loaded the way the extension loads them).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createApprovalDialog, loadTui } from "./approval-dialog.ts";
import { type FileChangePreview, PREVIEW_COLLAPSED_LINES, PREVIEW_EXPANDED_MAX, previewHeader } from "./diff-preview.ts";

const tui = (rows = 1000) => ({ requestRender() {}, terminal: { rows } }) as never;
const theme = () => ({ fg: (_color: string, text: string) => text, bold: (text: string) => text }) as never;
const keys = (bindings: Record<string, string>) =>
  ({ matches: (data: string, id: string) => bindings[id] === data }) as never;

const preview = (n: number): FileChangePreview => ({
  path: "src/a.ts",
  kind: "edit",
  added: n,
  removed: 0,
  lines: Array.from({ length: n }, (_, i) => `+line ${i + 1}`),
});

/** Feed a key to the dialog (its `handleInput` is optional in the Component type). */
function press(component: { handleInput?(data: string): void }, data: string): void {
  assert.ok(component.handleInput);
  component.handleInput(data);
}

/** Build a dialog with captured completion. */
async function dialog(p: FileChangePreview, options = ["Allow once", "Allow for session", "Deny"]) {
  const lib = await loadTui();
  assert.ok(lib, "pi-tui resolves in the test environment");
  const choices: Array<string | undefined> = [];
  const component = createApprovalDialog(lib, tui(), theme(), keys({ "tui.select.confirm": "\r", "tui.select.cancel": "\u001b" }), {
    title: "Allow edit? (src/a.ts)",
    options,
    preview: p,
    done: (choice) => choices.push(choice),
  });
  return { component, choices };
}

test("approval dialog: renders the title, the header, a collapsed diff and the options", async () => {
  const p = preview(PREVIEW_COLLAPSED_LINES + 30);
  const { component } = await dialog(p);
  const out = component.render(100);
  assert.equal(out[2], "Allow edit? (src/a.ts)");
  assert.equal(out[4], previewHeader(p));
  // The head of the diff, not all of it.
  assert.equal(out.filter((l) => l.startsWith("+line")).length, PREVIEW_COLLAPSED_LINES);
  assert.ok(out.some((l) => /… 30 more diff lines — press e or click to expand/.test(l)));
  assert.ok(out.includes("→ Allow once"));
  assert.ok(out.includes("  Deny"));
  assert.ok(out.some((l) => /e expand/.test(l)));
});

test("approval dialog: 'e' expands the preview and collapses it again", async () => {
  const p = preview(PREVIEW_EXPANDED_MAX + 50);
  const { component } = await dialog(p);
  assert.equal(component.render(100).filter((l) => l.startsWith("+line")).length, PREVIEW_COLLAPSED_LINES);
  press(component, "e");
  const expanded = component.render(100);
  assert.equal(expanded.filter((l) => l.startsWith("+line")).length, PREVIEW_EXPANDED_MAX);
  assert.ok(expanded.some((l) => /… 50 more diff lines not shown/.test(l)));
  press(component, "e");
  assert.equal(component.render(100).filter((l) => l.startsWith("+line")).length, PREVIEW_COLLAPSED_LINES);
});

test("approval dialog: a short diff has no expand hint and ignores 'e'", async () => {
  const { component } = await dialog(preview(3));
  const out = component.render(100);
  assert.ok(!out.some((l) => /e expand/.test(l)));
  press(component, "e");
  assert.equal(component.render(100).filter((l) => l.startsWith("+line")).length, 3);
});

test("approval dialog: arrows/j/k move the selection; enter chooses it; escape cancels", async () => {
  const p = preview(3);
  const a = await dialog(p);
  press(a.component, "j");
  press(a.component, "\r");
  assert.deepEqual(a.choices, ["Allow for session"]);

  const b = await dialog(p);
  press(b.component, "j");
  press(b.component, "j");
  press(b.component, "j"); // clamped at the last option
  press(b.component, "\r");
  assert.deepEqual(b.choices, ["Deny"]);

  const c = await dialog(p);
  press(c.component, "k"); // clamped at the first option
  press(c.component, "\r");
  assert.deepEqual(c.choices, ["Allow once"]);

  const d = await dialog(p);
  press(d.component, "\u001b"); // escape
  assert.deepEqual(d.choices, [undefined]);
});

test("approval dialog: the expanded view is bounded by the terminal height", async () => {
  const lib = await loadTui();
  assert.ok(lib);
  const component = createApprovalDialog(lib, tui(24), theme(), keys({}), {
    title: "Allow edit? (src/a.ts)",
    options: ["Allow once", "Allow for session", "Deny"],
    preview: preview(PREVIEW_EXPANDED_MAX + 50),
    done: () => {},
  });
  assert.ok(component.render(80).length <= 24, "collapsed fits");
  press(component, "e");
  assert.ok(component.render(80).length <= 24, "expanded fits");
});

test("approval dialog: a click toggles a long preview", async () => {
  const { component } = await dialog(preview(PREVIEW_COLLAPSED_LINES + 5));
  // The mouse handler is not part of older pi-tui's Component type.
  const mouse = component as unknown as { handleMouse?(e: { type: string; button: string }): unknown };
  mouse.handleMouse?.({ type: "click", button: "left" });
  assert.equal(component.render(100).filter((l) => l.startsWith("+line")).length, PREVIEW_COLLAPSED_LINES + 5);
  mouse.handleMouse?.({ type: "move", button: "left" });
  assert.equal(component.render(100).filter((l) => l.startsWith("+line")).length, PREVIEW_COLLAPSED_LINES + 5);
});

test("approval dialog: every line fits the width", async () => {
  const lib = await loadTui();
  assert.ok(lib);
  const { component } = await dialog(preview(5));
  for (const line of component.render(20)) {
    assert.ok(lib.visibleWidth(line) <= 20, JSON.stringify(line));
  }
});
