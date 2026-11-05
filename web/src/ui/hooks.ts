import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

/**
 * Open popups (lists, calendars, menus, sheets, dialogs) form a stack. A pointer-down dismisses a layer only when it
 * lands outside that layer and every layer opened above it, so a month list opened from a calendar inside a dialog
 * never closes the calendar or the dialog. Escape closes the topmost layer only.
 */
type Layer = { els: () => (HTMLElement | null)[] };
const stack: Layer[] = [];

/** Calls `onOutside` on a pointer-down outside the refs (and any layer above), or on Escape while topmost. */
export function useDismiss(open: boolean, refs: RefObject<HTMLElement | null>[], onOutside: () => void, opts: { outside?: boolean } = {}) {
  const cb = useRef(onOutside);
  cb.current = onOutside;
  const outside = opts.outside ?? true;
  useEffect(() => {
    if (!open) return;
    const me: Layer = { els: () => refs.map((r) => r.current) };
    stack.push(me);
    const down = (e: PointerEvent) => {
      if (!outside) return;
      const t = e.target as Node;
      const from = stack.indexOf(me);
      if (stack.slice(from).some((l) => l.els().some((el) => el?.contains(t)))) return;
      cb.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || stack[stack.length - 1] !== me) return;
      e.preventDefault();
      cb.current();
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key);
    return () => {
      const i = stack.indexOf(me);
      if (i >= 0) stack.splice(i, 1);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

let uid = 0;
export const useId = (p: string) => {
  const r = useRef<string | null>(null);
  r.current ??= `${p}-${++uid}`;
  return r.current;
};

/** Whether a media query matches, kept in step with the viewport. */
export function useMedia(query: string): boolean {
  const get = () => typeof window !== "undefined" && Boolean(window.matchMedia?.(query).matches);
  const [m, setM] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return m;
}
/** Phones: popups open as bottom sheets. */
export const useSheet = () => useMedia("(max-width: 639px)");

/** Locks page scrolling while a dialog or sheet is open. */
export function useLockScroll(open: boolean) {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);
}

/**
 * Where a popover goes: fixed to the viewport under its anchor (above it when there is more room there), in a portal so
 * the scrolling body of a dialog or drawer never clips it. Follows the anchor while anything scrolls or resizes.
 */
export function usePlacement(open: boolean, anchor: RefObject<HTMLElement | null>, align: "left" | "right" = "left", opts: { maxWidth?: number; maxHeight?: number; matchWidth?: boolean } = {}): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const { maxWidth = 420, maxHeight = 360, matchWidth = true } = opts;
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom - 8;
      const above = r.top - 8;
      // flip above when the popover would not fit below and there is more room above
      const up = below < Math.min(maxHeight, 420) && above > below;
      const room = Math.max(140, (up ? above : below) - 6);
      setStyle({
        position: "fixed",
        ...(matchWidth ? { minWidth: r.width } : {}),
        maxWidth: Math.min(maxWidth, window.innerWidth - 16),
        maxHeight: Math.min(maxHeight, room),
        ...(align === "right" ? { right: Math.max(8, window.innerWidth - r.right) } : { left: Math.max(8, Math.min(r.left, window.innerWidth - 8 - Math.max(matchWidth ? r.width : 0, 180))) }),
        ...(up ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }),
      });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, anchor, align, maxWidth, maxHeight, matchWidth]);
  return style;
}
