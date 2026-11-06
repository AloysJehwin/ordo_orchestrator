import { cloneElement, createContext, useCallback, useContext, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ClipboardCheck, Coins, Factory, History, Inbox, Layers, LayoutGrid, Lock, PenTool, Scale, Settings, ShieldCheck, Users, Wallet, Workflow, Wrench, X, type LucideIcon, AtSign } from "lucide-react";
import { useDismiss, useLockScroll, usePlacement, useSheet } from "./hooks";

export function Segmented<V extends string>(props: { value: V; onChange: (v: V) => void; options: { value: V; label: string; count?: number }[]; size?: "sm" | "md"; label?: string }) {
  return (
    <div className={`seg ${props.size ?? "md"}`} role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button type="button" key={o.value} role="radio" aria-checked={o.value === props.value} className={o.value === props.value ? "on" : ""} onClick={() => props.onChange(o.value)}>
          {o.label}
          {o.count !== undefined && <span className="seg-n num">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Tabs<V extends string>(props: { value: V; onChange: (v: V) => void; tabs: { value: V; label: string; count?: number }[] }) {
  return (
    <div className="tabs" role="tablist">
      {props.tabs.map((t) => (
        <button type="button" key={t.value} role="tab" aria-selected={t.value === props.value} className={t.value === props.value ? "on" : ""} onClick={() => props.onChange(t.value)}>
          {t.label}
          {t.count !== undefined && <span className="tab-n num">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Closes on a click that both starts and ends on the backdrop, so a drag out of a text field or a tap that lands
 *  after the backdrop is gone never closes it, and never "ghost-clicks" the page underneath. */
function useBackdrop(onClose: () => void) {
  const down = useRef(false);
  return {
    onPointerDown: (e: React.PointerEvent) => (down.current = e.target === e.currentTarget),
    onClick: (e: React.MouseEvent) => {
      if (down.current && e.target === e.currentTarget) onClose();
      down.current = false;
    },
  };
}

export function Modal(props: { open: boolean; onClose: () => void; title: string; eyebrow?: string; children: ReactNode; footer?: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLockScroll(props.open);
  useDismiss(props.open, [ref], props.onClose, { outside: false });
  const backdrop = useBackdrop(props.onClose);
  useEffect(() => {
    if (props.open) ref.current?.querySelector<HTMLElement>("input, textarea, button.sel-btn")?.focus({ preventScroll: true });
  }, [props.open]);
  if (!props.open) return null;
  return createPortal(
    <div className="overlay" {...backdrop}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={props.title} ref={ref} style={{ maxWidth: props.width ?? 560 }}>
        <div className="sheet-grip" aria-hidden />
        <div className="modal-h">
          <div className="grow">
            {props.eyebrow && <div className="eyebrow">{props.eyebrow}</div>}
            <h2>{props.title}</h2>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={props.onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="modal-b">{props.children}</div>
        {props.footer && <div className="modal-f">{props.footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer(props: { open: boolean; onClose: () => void; title: ReactNode; eyebrow?: ReactNode; children: ReactNode; width?: number; actions?: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useLockScroll(props.open);
  useDismiss(props.open, [ref], props.onClose, { outside: false });
  const backdrop = useBackdrop(props.onClose);
  if (!props.open) return null;
  return createPortal(
    <div className="overlay drawer-overlay" {...backdrop}>
      <aside className="drawer" role="dialog" aria-modal="true" ref={ref} style={{ width: props.width ?? 440 }}>
        <div className="sheet-grip" aria-hidden />
        <div className="modal-h">
          <div className="grow">
            {props.eyebrow && <div className="eyebrow">{props.eyebrow}</div>}
            <h2>{props.title}</h2>
          </div>
          <div className="btns">
            {props.actions}
            <button type="button" className="icon-btn" aria-label="Close" onClick={props.onClose}>
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="drawer-b">{props.children}</div>
      </aside>
    </div>,
    document.body,
  );
}

/** A bottom sheet: how lists, calendars and menus open on a phone. */
export function Sheet(props: { open: boolean; onClose: () => void; title?: ReactNode; label?: string; children: ReactNode; footer?: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLockScroll(props.open);
  useDismiss(props.open, [ref], props.onClose, { outside: false });
  const backdrop = useBackdrop(props.onClose);
  if (!props.open) return null;
  return createPortal(
    <div className="overlay sheet-overlay" {...backdrop}>
      <div className={`sheet ${props.className ?? ""}`} ref={ref} role="dialog" aria-modal="true" aria-label={props.label ?? (typeof props.title === "string" ? props.title : undefined)}>
        <div className="sheet-grip" aria-hidden />
        {props.title && (
          <div className="sheet-h">
            <b>{props.title}</b>
            <button type="button" className="icon-btn" aria-label="Close" onClick={props.onClose}>
              <X size={18} />
            </button>
          </div>
        )}
        <div className="sheet-b">{props.children}</div>
        {props.footer && <div className="sheet-f">{props.footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** A small menu anchored to its trigger; a bottom sheet on a phone. */
export function Menu(props: { trigger: (open: boolean, toggle: () => void) => ReactNode; items: { label: string; onClick: () => void; danger?: boolean; disabled?: boolean }[]; align?: "left" | "right"; title?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const sheet = useSheet();
  useDismiss(open && !sheet, [ref, pop], () => setOpen(false));
  const place = usePlacement(open && !sheet, ref, props.align === "left" ? "left" : "right", { matchWidth: false, maxWidth: 320 });
  const items = props.items.map((i) => (
    <button type="button" role="menuitem" key={i.label} disabled={i.disabled} className={i.danger ? "danger" : ""} onClick={() => (setOpen(false), i.onClick())}>
      {i.label}
    </button>
  ));
  return (
    <div className="menu" ref={ref}>
      {props.trigger(open, () => setOpen(!open))}
      {open && !sheet && createPortal(
        <div className="pop menu-pop" role="menu" ref={pop} style={place}>
          {items}
        </div>,
        document.body,
      )}
      <Sheet open={open && sheet} onClose={() => setOpen(false)} title={props.title} label={props.title ?? "Menu"}>
        <div className="menu-pop in-sheet" role="menu">
          {items}
        </div>
      </Sheet>
    </div>
  );
}

// ---------------- Toasts ----------------
type Toast = { id: number; text: string; kind: "ok" | "bad" | "info" };
const ToastCtx = createContext<(text: string, kind?: Toast["kind"]) => void>(() => undefined);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x.slice(-3), { id, text, kind }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === "bad" ? 8000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} onClick={() => setItems((x) => x.filter((y) => y.id !== t.id))}>
            <span className="toast-dot" aria-hidden />
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ---------------- Small pieces ----------------
export const Empty = (p: { title: string; children?: ReactNode; action?: ReactNode }) => (
  <div className="empty-state">
    <div className="empty-mark" aria-hidden>
      <Layers size={22} strokeWidth={1.6} />
    </div>
    <h3>{p.title}</h3>
    {p.children && <p className="muted">{p.children}</p>}
    {p.action}
  </div>
);

/** A labelled form row. Plain inputs get the label via aria-label; custom controls sit in a named group. */
export const Field = (p: { label: string; hint?: ReactNode; children: ReactNode; error?: string | null }) => {
  const child = p.children as { type?: unknown; props?: Record<string, unknown> };
  const plain = child && (child.type === "input" || child.type === "textarea");
  const content = plain && !child.props?.["aria-label"] ? cloneElement(p.children as ReactElement<Record<string, unknown>>, { "aria-label": p.label }) : p.children;
  return (
    <div className="field" role="group" aria-label={p.label}>
      <span className="field-l">{p.label}</span>
      {content}
      {p.hint && !p.error && <span className="field-h">{p.hint}</span>}
      {p.error && <span className="field-e">{p.error}</span>}
    </div>
  );
};

export const Spinner = () => <span className="spinner" aria-label="Loading" />;

export function Loading({ text = "Loading…" }: { text?: string }) {
  return (
    <div className="loading">
      <Spinner /> {text}
    </div>
  );
}

/** Async button: disables itself while the action runs and reports errors as a toast. */
export function Action(props: { onClick: () => Promise<unknown> | unknown; children: ReactNode; className?: string; disabled?: boolean; title?: string; type?: "button" | "submit" }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <button
      type={props.type ?? "button"}
      title={props.title}
      className={props.className ?? "btn"}
      disabled={props.disabled || busy}
      onClick={async () => {
        setBusy(true);
        try {
          await props.onClick();
        } catch (e) {
          toast(e instanceof Error ? e.message : String(e), "bad");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Spinner /> : null}
      {props.children}
    </button>
  );
}

export const ICONS: Record<string, LucideIcon> = {
  pipelines: Workflow,
  validation: ShieldCheck,
  templates: LayoutGrid,
  history: History,
  floor: Factory,
  approvals: Inbox,
  builder: PenTool,
  team: Users,
  proof: Lock,
  pow: ClipboardCheck,
  cases: Scale,
  rewards: Coins,
  workorders: Wrench,
  finance: Wallet,
  settings: Settings,
  names: AtSign,
};

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const I = ICONS[name] ?? Layers;
  return <I size={size} strokeWidth={1.7} aria-hidden />;
}
