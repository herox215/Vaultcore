import { ViewPlugin, Decoration, WidgetType } from "@codemirror/view";
import type { EditorView, DecorationSet, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

// ── Checkbox widget ────────────────────────────────────────────────────────────

class TaskCheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }

  eq(other: TaskCheckboxWidget): boolean {
    return this.checked === other.checked;
  }

  toDOM(): HTMLElement {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "cm-task-checkbox";
    input.checked = this.checked;
    input.setAttribute("aria-label", this.checked ? "completed task" : "incomplete task");
    return input;
  }

  ignoreEvent(event: Event): boolean {
    return event.type !== "mousedown";
  }
}

// ── Decoration builder ─────────────────────────────────────────────────────────

interface TaskRange {
  markerFrom: number;
  markerTo: number;
  textFrom: number;
  textTo: number;
  checked: boolean;
  line: number;
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const state = view.state;
  const head = state.selection.main.head;
  const cursorLine = state.doc.lineAt(head).number;

  const tasks: TaskRange[] = [];

  syntaxTree(state).iterate({
    from: view.viewport.from,
    to: view.viewport.to,
    enter(node) {
      if (node.name !== "TaskMarker") return;

      const markerFrom = node.from;
      const markerTo = node.to;
      const markerText = state.doc.sliceString(markerFrom, markerTo);
      const checked = markerText.toLowerCase() === "[x]";

      const taskNode = node.node.parent;
      const textFrom = markerTo + (state.doc.sliceString(markerTo, markerTo + 1) === " " ? 1 : 0);
      const textTo = taskNode ? taskNode.to : markerTo;

      const lineNum = state.doc.lineAt(markerFrom).number;

      tasks.push({ markerFrom, markerTo, textFrom, textTo, checked, line: lineNum });
    },
  });

  tasks.sort((a, b) => a.markerFrom - b.markerFrom);

  for (const task of tasks) {
    if (task.line === cursorLine) {
      if (task.checked && task.textFrom < task.textTo) {
        builder.add(
          task.textFrom,
          task.textTo,
          Decoration.mark({ class: "cm-task-done" }),
        );
      }
    } else {
      builder.add(
        task.markerFrom,
        task.markerTo,
        Decoration.replace({
          widget: new TaskCheckboxWidget(task.checked),
        }),
      );

      if (task.checked && task.textFrom < task.textTo) {
        builder.add(
          task.textFrom,
          task.textTo,
          Decoration.mark({ class: "cm-task-done" }),
        );
      }
    }
  }

  return builder.finish();
}

// ── ViewPlugin ─────────────────────────────────────────────────────────────────

export const taskListPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      mousedown(event: MouseEvent, view: EditorView) {
        const target = event.target as HTMLElement;
        if (!(target instanceof HTMLInputElement) || target.type !== "checkbox" || !target.classList.contains("cm-task-checkbox")) {
          return false;
        }

        event.preventDefault();

        const pos = view.posAtDOM(target);
        if (pos < 0) return false;

        const state = view.state;

        const node = syntaxTree(state).resolveInner(pos, 1);

        let markerFrom = -1;
        let markerTo = -1;
        let isChecked = false;

        let cur: typeof node | null = node;
        while (cur) {
          if (cur.type.name === "TaskMarker") {
            markerFrom = cur.from;
            markerTo = cur.to;
            isChecked = state.doc.sliceString(markerFrom, markerTo).toLowerCase() === "[x]";
            break;
          }
          cur = cur.parent;
        }

        if (markerFrom === -1) {
          const line = state.doc.lineAt(pos);
          const lineText = state.doc.sliceString(line.from, line.to);
          const m = /^(\s*[-*+]\s+)(\[[ x]\])/i.exec(lineText);
          if (!m) return false;
          const prefix = m[1] ?? "";
          const marker = m[2] ?? "";
          markerFrom = line.from + prefix.length;
          markerTo = markerFrom + marker.length;
          isChecked = marker.toLowerCase() === "[x]";
        }

        view.dispatch({
          changes: {
            from: markerFrom,
            to: markerTo,
            insert: isChecked ? "[ ]" : "[x]",
          },
          userEvent: "input",
        });

        return true;
      },
    },
  },
);
