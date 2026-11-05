import { useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useDismiss, usePlacement, useSheet } from "./hooks";
import { Sheet } from "./kit";
import { Select } from "./Select";

// Dates are handled as local calendar days "YYYY-MM-DD"; times as "HH:MM".
const pad = (n: number) => String(n).padStart(2, "0");
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseDay = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
};
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEK = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
export const fmtDay = (s: string | null) => (s ? parseDay(s).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");

function Month(props: { month: Date; onMonth: (d: Date) => void; isSelected: (k: string) => boolean; inRange?: (k: string) => boolean; onPick: (k: string) => void; min?: string; max?: string; onHover?: (k: string | null) => void }) {
  const { month, onMonth } = props;
  const today = dayKey(new Date());
  const cells = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const offset = (first.getDay() + 6) % 7;
    const start = new Date(first);
    start.setDate(1 - offset);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [month]);
  const [focus, setFocus] = useState<string | null>(null);
  const shift = (days: number) => {
    const base = parseDay(focus ?? dayKey(new Date(month.getFullYear(), month.getMonth(), 1)));
    base.setDate(base.getDate() + days);
    setFocus(dayKey(base));
    if (base.getMonth() !== month.getMonth()) onMonth(new Date(base.getFullYear(), base.getMonth(), 1));
  };
  const years = Array.from({ length: 11 }, (_, i) => month.getFullYear() - 5 + i);
  return (
    <div
      className="cal"
      tabIndex={0}
      onKeyDown={(e) => {
        const map: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
        if (map[e.key] !== undefined) (e.preventDefault(), shift(map[e.key]!));
        else if (e.key === "Enter" && focus) (e.preventDefault(), props.onPick(focus));
      }}
    >
      <div className="cal-h">
        <button type="button" className="icon-btn" aria-label="Previous month" onClick={() => onMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>
          <ChevronLeft size={17} />
        </button>
        <Select size="sm" variant="chip" name="Month" value={String(month.getMonth())} onChange={(v) => onMonth(new Date(month.getFullYear(), Number(v), 1))} options={MONTHS.map((m, i) => ({ value: String(i), label: m.slice(0, 3) }))} searchable={false} />
        <Select size="sm" variant="chip" name="Year" value={String(month.getFullYear())} onChange={(v) => onMonth(new Date(Number(v), month.getMonth(), 1))} options={years.map((y) => ({ value: String(y), label: String(y) }))} searchable={false} />
        <button type="button" className="icon-btn" aria-label="Next month" onClick={() => onMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>
          <ChevronRight size={17} />
        </button>
      </div>
      <div className="cal-grid" role="grid">
        {WEEK.map((w) => (
          <span key={w} className="cal-w">
            {w}
          </span>
        ))}
        {cells.map((d) => {
          const k = dayKey(d);
          const out = d.getMonth() !== month.getMonth();
          const disabled = (props.min && k < props.min) || (props.max && k > props.max);
          return (
            <button
              type="button"
              key={k}
              role="gridcell"
              disabled={Boolean(disabled)}
              aria-selected={props.isSelected(k)}
              className={`cal-d${out ? " out" : ""}${k === today ? " today" : ""}${props.isSelected(k) ? " sel" : ""}${props.inRange?.(k) ? " range" : ""}${focus === k ? " focus" : ""}`}
              onClick={() => props.onPick(k)}
              onPointerEnter={() => props.onHover?.(k)}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Trigger(props: { text: string; placeholder: string; open: boolean; onClick: () => void; disabled?: boolean; onClear?: () => void }) {
  const clear = Boolean(props.onClear && props.text);
  return (
    <div className="date-trigger">
      <button type="button" className={`sel-btn${clear ? " has-clear" : ""}`} disabled={props.disabled} aria-haspopup="dialog" aria-expanded={props.open} onClick={props.onClick}>
        <CalendarDays size={15} className="date-ico" aria-hidden />
        <span className={props.text ? "" : "faint"}>{props.text || props.placeholder}</span>
      </button>
      {clear && (
        <button type="button" className="icon-btn clear" aria-label="Clear" onClick={props.onClear}>
          <X size={15} />
        </button>
      )}
    </div>
  );
}

/** The calendar panel: a popover in a portal on wide screens (never clipped by a dialog), a bottom sheet on a phone. */
function Panel(props: { open: boolean; onClose: () => void; anchor: React.RefObject<HTMLDivElement | null>; label: string; className?: string; children: ReactNode }) {
  const sheet = useSheet();
  const pop = useRef<HTMLDivElement>(null);
  const place = usePlacement(props.open && !sheet, props.anchor, "left", { matchWidth: false, maxWidth: 640, maxHeight: 520 });
  useDismiss(props.open && !sheet, [props.anchor, pop], props.onClose);
  if (!props.open) return null;
  if (sheet)
    return (
      <Sheet open onClose={props.onClose} title={props.label} className="date-sheet">
        <div className={props.className}>{props.children}</div>
      </Sheet>
    );
  return createPortal(
    <div className={`pop date-pop ${props.className ?? ""}`} role="dialog" aria-label={props.label} ref={pop} style={place}>
      {props.children}
    </div>,
    document.body,
  );
}

/** Single date. */
export function DatePicker(props: { value: string | null; onChange: (v: string | null) => void; placeholder?: string; min?: string; max?: string; clearable?: boolean; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => parseDay(props.value ?? dayKey(new Date())));
  const wrap = useRef<HTMLDivElement>(null);
  return (
    <div className="date" ref={wrap}>
      <Trigger text={fmtDay(props.value)} placeholder={props.placeholder ?? "Pick a date"} open={open} disabled={props.disabled} onClick={() => setOpen(!open)} onClear={props.clearable ? () => props.onChange(null) : undefined} />
      <Panel open={open} onClose={() => setOpen(false)} anchor={wrap} label="Choose date">
        <Month month={month} onMonth={setMonth} isSelected={(k) => k === props.value} onPick={(k) => (props.onChange(k), setOpen(false))} min={props.min} max={props.max} />
        <div className="cal-foot">
          <button type="button" className="btn sm" onClick={() => (props.onChange(dayKey(new Date())), setOpen(false))}>
            Today
          </button>
        </div>
      </Panel>
    </div>
  );
}

const TIMES = Array.from({ length: 96 }, (_, i) => `${pad(Math.floor(i / 4))}:${pad((i % 4) * 15)}`);

/** Date and time; value is an ISO timestamp in UTC (local time chosen by the user). */
export function DateTimePicker(props: { value: string | null; onChange: (v: string | null) => void; placeholder?: string; min?: string; clearable?: boolean }) {
  const d = props.value ? new Date(props.value) : null;
  const day = d ? dayKey(d) : null;
  const time = d ? `${pad(d.getHours())}:${pad(Math.floor(d.getMinutes() / 15) * 15)}` : "17:00";
  const set = (k: string | null, t: string) => {
    if (!k) return props.onChange(null);
    const [h, m] = t.split(":").map(Number);
    const x = parseDay(k);
    x.setHours(h!, m!, 0, 0);
    props.onChange(x.toISOString());
  };
  return (
    <div className="datetime">
      <DatePicker value={day} onChange={(k) => set(k, time)} placeholder={props.placeholder ?? "Date"} min={props.min} clearable={props.clearable} />
      <Select size="md" name="Time" value={time} onChange={(t) => set(day ?? dayKey(new Date()), t)} options={TIMES.map((t) => ({ value: t, label: t }))} searchable={false} />
    </div>
  );
}

export interface Range {
  from: string | null;
  to: string | null;
}
const presetRanges = (): { label: string; range: Range }[] => {
  const t = new Date();
  const back = (n: number) => {
    const x = new Date(t);
    x.setDate(t.getDate() - n);
    return dayKey(x);
  };
  return [
    { label: "Today", range: { from: dayKey(t), to: dayKey(t) } },
    { label: "Last 24 hours", range: { from: back(1), to: dayKey(t) } },
    { label: "Last 7 days", range: { from: back(6), to: dayKey(t) } },
    { label: "Last 30 days", range: { from: back(29), to: dayKey(t) } },
  ];
};

/** A from–to range with presets; two months side by side. */
export function DateRangePicker(props: { value: Range; onChange: (r: Range) => void; max?: string }) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => {
    const base = parseDay(props.value.to ?? dayKey(new Date()));
    return new Date(base.getFullYear(), base.getMonth() - 1, 1);
  });
  const [draft, setDraft] = useState<Range>(props.value);
  const [hover, setHover] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const one = useSheet();
  const next = new Date(month.getFullYear(), month.getMonth() + 1, 1);
  const end = draft.to ?? (draft.from && hover && hover >= draft.from ? hover : null);
  const inRange = (k: string) => Boolean(draft.from && end && k > draft.from && k < end);
  const pick = (k: string) => {
    if (!draft.from || draft.to || k < draft.from) setDraft({ from: k, to: null });
    else {
      const r = { from: draft.from, to: k };
      setDraft(r);
      props.onChange(r);
      setOpen(false);
    }
  };
  const text = props.value.from ? `${fmtDay(props.value.from)} – ${props.value.to ? fmtDay(props.value.to) : "…"}` : "";
  return (
    <div className="date" ref={wrap}>
      <Trigger text={text} placeholder="Any date" open={open} onClick={() => (setDraft(props.value), setOpen(!open))} onClear={() => props.onChange({ from: null, to: null })} />
      <Panel open={open} onClose={() => setOpen(false)} anchor={wrap} label="Choose date range" className="range-pop">
          <div className="presets">
            {presetRanges().map((p) => (
              <button type="button" key={p.label} className="chip-btn" onClick={() => (props.onChange(p.range), setOpen(false))}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="months" onPointerLeave={() => setHover(null)}>
            {(one ? [month] : [month, next]).map((m, i) => (
              <Month
                key={i}
                month={m}
                onMonth={(d) => setMonth(i === 0 ? d : new Date(d.getFullYear(), d.getMonth() - 1, 1))}
                isSelected={(k) => k === draft.from || k === end}
                inRange={inRange}
                onPick={pick}
                onHover={setHover}
                max={props.max}
              />
            ))}
          </div>
      </Panel>
    </div>
  );
}
