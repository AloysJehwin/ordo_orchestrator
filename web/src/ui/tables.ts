/**
 * Every `table.t` stacks into one card per row on a phone (see styles.css). Each cell then shows its column's name,
 * which it reads from `data-label`. Rather than every page writing that on every cell, this sets it from the table's
 * header row whenever tables appear or change, including in dialogs and drawers rendered outside the app root.
 * A cell that already has its own `data-label` keeps it; `data-label=""` hides the label.
 */
export function labelTables(root: HTMLElement = document.body) {
  let queued = false;
  const run = () => {
    queued = false;
    for (const table of root.querySelectorAll<HTMLTableElement>("table.t")) {
      const head = table.tHead?.rows[0];
      if (!head) continue;
      const names: string[] = [];
      for (const th of head.cells) {
        const n = th.textContent?.trim() ?? "";
        for (let i = 0; i < th.colSpan; i++) names.push(n);
      }
      for (const body of table.tBodies)
        for (const row of body.rows) {
          let col = 0;
          for (const td of row.cells) {
            if (!td.hasAttribute("data-label") || td.dataset.auto === "1") {
              const n = names[col] ?? "";
              if (td.getAttribute("data-label") !== n) td.setAttribute("data-label", n);
              td.dataset.auto = "1";
            }
            col += td.colSpan;
          }
        }
    }
  };
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(run);
  };
  new MutationObserver(queue).observe(root, { childList: true, subtree: true, characterData: true });
  queue();
}
