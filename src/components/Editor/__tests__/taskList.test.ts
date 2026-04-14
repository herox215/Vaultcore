import { describe, it, expect } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { buildExtensions } from "../extensions";
import { taskListPlugin } from "../taskList";

function makeView(doc: string, cursorPos?: number): EditorView {
  const state = EditorState.create({
    doc,
    selection: { anchor: cursorPos ?? 0 },
    extensions: buildExtensions(() => {}),
  });
  return new EditorView({ state });
}

type DecoEntry = { from: number; to: number; cls: string | null; hasWidget: boolean };

function getTaskDecorations(view: EditorView, from: number, to: number): DecoEntry[] {
  const result: DecoEntry[] = [];
  const instance = view.plugin(taskListPlugin);
  if (!instance) return result;
  const set = instance.decorations;
  if (!set) return result;
  set.between(from, to, (f: number, t: number, value: any) => {
    result.push({
      from: f,
      to: t,
      cls: (value.spec?.class as string | undefined) ?? null,
      hasWidget: !!value.spec?.widget,
    });
  });
  return result;
}

describe("taskListPlugin decorations", () => {
  const doc = "- [ ] unchecked task\n- [x] checked task\n";
  // Line 1: "- [ ] unchecked task"  => TaskMarker at positions 2-5
  // Line 2: "- [x] checked task"   => TaskMarker at positions 23-26
  // "checked task" text starts at 27

  it("hides the TaskMarker with a widget when cursor is on a different line", () => {
    // Put cursor at start of line 2 (pos 21) — line 1 marker should be hidden by widget
    const view = makeView(doc, 21);
    const decos = getTaskDecorations(view, 2, 5);
    const widgetDeco = decos.find((d) => d.from === 2 && d.to === 5 && d.hasWidget);
    expect(widgetDeco, "expected a replace widget hiding [ ] on line 1").toBeTruthy();
    view.destroy();
  });

  it("does NOT add a replace widget when cursor is on the task line", () => {
    // Put cursor inside line 1 (pos 2, right on the marker)
    const view = makeView(doc, 2);
    const decos = getTaskDecorations(view, 2, 5);
    const widgetDeco = decos.find((d) => d.from === 2 && d.to === 5 && d.hasWidget);
    expect(widgetDeco, "should not hide marker when cursor is on the same line").toBeUndefined();
    view.destroy();
  });

  it("adds cm-task-done class to checked item text when cursor is elsewhere", () => {
    // Cursor on line 1 — line 2 (checked) should have cm-task-done on its text
    const view = makeView(doc, 0);
    // "checked task" starts at 27, line 2 ends at 39 (before newline)
    const decos = getTaskDecorations(view, 27, 40);
    const doneDeco = decos.find((d) => d.cls === "cm-task-done");
    expect(doneDeco, "expected cm-task-done mark on checked item text").toBeTruthy();
    view.destroy();
  });

  it("does not add cm-task-done to unchecked item text", () => {
    // Cursor on line 2 — line 1 (unchecked) should not have cm-task-done
    const view = makeView(doc, 21);
    // "unchecked task" starts at 6, ends at 20
    const decos = getTaskDecorations(view, 6, 20);
    const doneDeco = decos.find((d) => d.cls === "cm-task-done");
    expect(doneDeco, "unchecked item should not have cm-task-done").toBeUndefined();
    view.destroy();
  });

  it("toggle dispatch changes [ ] to [x]", () => {
    const view = makeView("- [ ] my task\n", 14);
    view.dispatch({
      changes: { from: 2, to: 5, insert: "[x]" },
      userEvent: "input",
    });
    expect(view.state.doc.toString()).toBe("- [x] my task\n");
    view.destroy();
  });

  it("toggle dispatch changes [x] to [ ]", () => {
    const view = makeView("- [x] my task\n", 14);
    view.dispatch({
      changes: { from: 2, to: 5, insert: "[ ]" },
      userEvent: "input",
    });
    expect(view.state.doc.toString()).toBe("- [ ] my task\n");
    view.destroy();
  });

  it("handles nested task lists", () => {
    const nestedDoc = "- [ ] parent\n  - [x] child\n";
    // parent marker: 2-5, child marker: pos of "[x]" inside "  - [x] child"
    // Line 1: "- [ ] parent" (0-12), Line 2: "  - [x] child" (13-26)
    // In line 2: "  - " is 4 chars from line start, so marker at 13+4=17..20
    const view = makeView(nestedDoc, 0);
    // scan broadly for any widget in line 2 range
    const decos = getTaskDecorations(view, 13, 27);
    const childWidget = decos.find((d) => d.hasWidget);
    expect(childWidget, "nested task marker should be replaced with widget").toBeTruthy();
    view.destroy();
  });
});
