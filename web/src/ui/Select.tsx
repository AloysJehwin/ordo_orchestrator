import { useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";
import { useDismiss, useId, usePlacement, useSheet } from "./hooks";
import { Sheet } from "./kit";

export interface Option<V extends string = string> {
  value: V;
  label: string;
  hint?: string;
  group?: string;
  disabled?: boolean;
  icon?: ReactNode;
}

/**
 * Ordo's dropdown: a button that opens a listbox, as a popover on wide screens and a bottom sheet on a phone.
 * Keyboard: ↑/↓ to move, Enter to choose, Esc to close, type to filter (when searchable) or jump to the first match.
 * `variant="chip"` is the compact pill used in card headers and filter rows.
 */
export function Select<V extends string>(props: {
  value: V | null;
  onChange: (v: V) => void;
  options: Option<V>[];
  placeholder?: string;
  searchable?: boolean;
  disabled?: boolean;
  width?: number | string;
  label?: string;
  /** names the list for screen readers and as the sheet title, without a visible label */
  name?: string;
  size?: "sm" | "md";
  variant?: "field" | "chip";
  align?: "left" | "right";
  emptyText?: string;
}) {
  const { value, onChange, options, placeholder = "Select…", disabled, width, label, name, size = "md", variant = "field", align = "left", emptyText = "No matches" } = props;
  const searchable = props.searchable ?? options.length > 8;
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const sheet = useSheet();
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const place = usePlacement(open && !sheet, btn, align, { matchWidth: variant !== "chip" });
  const listRef = useRef<HTMLUListElement>(null);
  const id = useId("sel");
  const current = options.find((o) => o.value === value) ?? null;
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? options.filter((o) => `${o.label} ${o.hint ?? ""} ${o.group ?? ""}`.toLowerCase().includes(s)) : options;
  }, [options, q]);
  useDismiss(open && !sheet, [wrap, pop], () => setOpen(false));

  const openList = () => {
    if (disabled) return;
    setQ("");
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    btn.current?.focus({ preventScroll: true });
  };
  const choose = (o: Option<V> | undefined) => {
    if (!o || o.disabled) return;
    onChange(o.value);
    close();
  };
  const move = (d: number) => {
    if (!filtered.length) return;
    let i = active;
    for (let n = 0; n < filtered.length; n++) {
      i = (i + d + filtered.length) % filtered.length;
      if (!filtered[i]!.disabled) break;
    }
    setActive(i);
    listRef.current?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        openList();
      }
      return;
    }
    if (e.key === "ArrowDown") (e.preventDefault(), move(1));
    else if (e.key === "ArrowUp") (e.preventDefault(), move(-1));
    else if (e.key === "Home") (e.preventDefault(), setActive(0));
    else if (e.key === "End") (e.preventDefault(), setActive(filtered.length - 1));
    else if (e.key === "Enter") (e.preventDefault(), choose(filtered[active]));
    else if (e.key === "Tab") setOpen(false);
    else if (!searchable && e.key.length === 1) {
      const i = filtered.findIndex((o) => o.label.toLowerCase().startsWith(e.key.toLowerCase()));
      if (i >= 0) setActive(i);
    }
  };

  let lastGroup: string | undefined;
  const list = (
    <>
      {searchable && (
        <label className="sel-search">
          <Search size={15} aria-hidden />
          <input autoFocus={!sheet} placeholder="Search…" value={q} onChange={(e) => (setQ(e.target.value), setActive(0))} aria-label="Filter options" />
        </label>
      )}
      <ul role="listbox" id={id} ref={listRef} tabIndex={-1} aria-label={name ?? label ?? placeholder} aria-activedescendant={`${id}-${active}`}>
        {filtered.length === 0 && <li className="sel-empty">{emptyText}</li>}
        {filtered.map((o, i) => {
          const head = o.group && o.group !== lastGroup ? o.group : null;
          lastGroup = o.group;
          return (
            <li key={o.value} role="presentation">
              {head && <div className="sel-group">{head}</div>}
              <div
                role="option"
                id={`${id}-${i}`}
                data-i={i}
                aria-selected={o.value === value}
                aria-disabled={o.disabled}
                className={`sel-opt${i === active ? " active" : ""}${o.value === value ? " chosen" : ""}${o.disabled ? " disabled" : ""}`}
                onPointerEnter={() => setActive(i)}
                onClick={() => choose(o)}
              >
                {o.icon}
                <span className="sel-text">
                  <span>{o.label}</span>
                  {o.hint && <span className="sel-hint">{o.hint}</span>}
                </span>
                <Check size={15} className="tick" aria-hidden />
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );

  return (
    <div className={`sel ${size}${variant === "chip" ? " sel-chip" : ""}`} ref={wrap} style={{ width }} onKeyDown={onKey}>
      {label && variant !== "chip" && <span className="sel-label">{label}</span>}
      <button type="button" ref={btn} className="sel-btn" disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-controls={id} aria-label={name ?? (variant === "chip" ? label : undefined)} onClick={() => (open ? setOpen(false) : openList())}>
        {current?.icon}
        <span className={current ? "" : "faint"}>{current?.label ?? placeholder}</span>
        <ChevronDown size={variant === "chip" ? 13 : 15} className="chev" aria-hidden />
      </button>
      {open &&
        !sheet &&
        createPortal(
          <div className="sel-pop floating" ref={pop} style={place}>
            {list}
          </div>,
          document.body,
        )}
      <Sheet open={open && sheet} onClose={close} title={name ?? label ?? (placeholder === "Select…" ? "Choose one" : placeholder)} className="sel-sheet">
        {list}
      </Sheet>
    </div>
  );
}
