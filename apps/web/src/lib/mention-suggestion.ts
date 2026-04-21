import type { SuggestionOptions } from "@tiptap/suggestion";

export interface MentionCandidate {
  id: string;
  name: string;
}

interface CreateArgs {
  getCandidates: () => MentionCandidate[];
}

/**
 * Vanilla-DOM Tiptap suggestion renderer. Avoids pulling in tippy.js —
 * we append a small popover to document.body, position it at the caret,
 * and manually handle keyboard navigation.
 *
 * `getCandidates` is a thunk so the popover always sees the latest
 * conversation members without re-building the editor config.
 */
export function createMentionSuggestion({
  getCandidates,
}: CreateArgs): Omit<SuggestionOptions<MentionCandidate>, "editor"> {
  return {
    char: "@",
    items: ({ query }) => {
      const q = query.toLowerCase();
      return getCandidates()
        .filter((c) => c.name.toLowerCase().includes(q))
        .slice(0, 8);
    },
    render: () => {
      let container: HTMLDivElement | null = null;
      let items: MentionCandidate[] = [];
      let selected = 0;
      let command:
        | ((item: { id: string; label: string }) => void)
        | null = null;

      const position = (rect: DOMRect | null) => {
        if (!container || !rect) return;
        container.style.top = `${rect.bottom + window.scrollY + 6}px`;
        container.style.left = `${rect.left + window.scrollX}px`;
      };

      const redraw = () => {
        if (!container) return;
        container.innerHTML = "";
        if (items.length === 0) {
          const empty = document.createElement("div");
          empty.className = "mention-empty";
          empty.textContent = "No matches";
          container.appendChild(empty);
          return;
        }
        items.forEach((item, i) => {
          const row = document.createElement("div");
          row.className =
            i === selected ? "mention-item selected" : "mention-item";
          row.textContent = `@${item.name}`;
          row.addEventListener("mousedown", (e) => {
            e.preventDefault();
            command?.({ id: item.id, label: item.name });
          });
          container!.appendChild(row);
        });
      };

      return {
        onStart: (props) => {
          container = document.createElement("div");
          container.className = "mention-popover";
          document.body.appendChild(container);
          items = props.items;
          selected = 0;
          command = (item) => props.command(item);
          position(props.clientRect?.() ?? null);
          redraw();
        },
        onUpdate: (props) => {
          items = props.items;
          selected = Math.min(selected, Math.max(0, items.length - 1));
          command = (item) => props.command(item);
          position(props.clientRect?.() ?? null);
          redraw();
        },
        onKeyDown: ({ event }) => {
          if (!container) return false;
          if (event.key === "ArrowDown") {
            selected = items.length ? (selected + 1) % items.length : 0;
            redraw();
            return true;
          }
          if (event.key === "ArrowUp") {
            selected = items.length
              ? (selected - 1 + items.length) % items.length
              : 0;
            redraw();
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            const item = items[selected];
            if (item) {
              command?.({ id: item.id, label: item.name });
              return true;
            }
            return false;
          }
          if (event.key === "Escape") {
            container.remove();
            container = null;
            return true;
          }
          return false;
        },
        onExit: () => {
          container?.remove();
          container = null;
        },
      };
    },
  };
}
