import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useApp } from "../lib/app";
import { AGENT_LABEL } from "../lib/format";
import { AGG_LABEL, AGGS, bandOf, KIND_LABEL as CRIT_KIND_LABEL, KINDS, kindOf, targetText } from "../lib/criteria";
import { MEDIA, MEDIA_ICON, MEDIA_LABEL, MIN_OUTCOMES, OUTCOME_PRESETS, machineless, metricText, outcomeErrors, outcomeKey } from "../lib/outcomes";
import { go, href, useRoute } from "../lib/router";
import type { AgentKey, AssetKind, AssetView, Criterion, CriterionKind, Outcome, OutcomeMedia, Role, SignalAgg, StageSpec, TemplateView } from "../types";
import { Action, Field, Loading, Modal, Segmented, useToast } from "../ui/kit";
import { Select } from "../ui/Select";
import { SpecBand } from "../ui/SpecBand";

interface Draft extends Omit<StageSpec, "code"> {
  key: number;
}
type Mode = StageSpec["mode"];
let seq = 1;
const KIND_LABEL: Record<AssetKind, string> = {
  cnc: "CNC machine",
  robot: "Robot cell",
  manual_station: "Manual station",
  inspection: "Inspection station",
  agv: "AGV fleet",
  pack_line: "Pack line",
  process_vessel: "Vessel / oven",
  maintenance_crew: "Maintenance crew",
  system: "ERP / MES link",
};
const PALETTE: { name: string; agent: AgentKey; resourceKind: AssetKind; mode: Mode; escalationRole: Role; criteria?: Criterion[] }[] = [
  { name: "Order intake", agent: "planning", resourceKind: "system", mode: "auto", escalationRole: "manager" },
  { name: "Material sourcing", agent: "supply", resourceKind: "agv", mode: "auto", escalationRole: "manager" },
  { name: "Machining", agent: "scheduler", resourceKind: "cnc", mode: "auto", escalationRole: "manager" },
  { name: "Assembly", agent: "line", resourceKind: "robot", mode: "auto", escalationRole: "manager" },
  { name: "Manual assembly", agent: "line", resourceKind: "manual_station", mode: "manual", escalationRole: "manager" },
  { name: "Heat treatment", agent: "process", resourceKind: "process_vessel", mode: "auto", escalationRole: "manager" },
  { name: "Quality inspection", agent: "vision_qa", resourceKind: "inspection", mode: "approve", escalationRole: "manager" },
  { name: "Functional test", agent: "vision_qa", resourceKind: "inspection", mode: "auto", escalationRole: "manager" },
  { name: "Packaging", agent: "logistics", resourceKind: "pack_line", mode: "auto", escalationRole: "manager" },
  { name: "Dispatch", agent: "logistics", resourceKind: "agv", mode: "auto", escalationRole: "manager" },
  { name: "Maintenance check", agent: "maintenance", resourceKind: "maintenance_crew", mode: "manual", escalationRole: "manager" },
  // lab stages: judged on measured instrument parameters rather than counts
  {
    name: "Bioreactor expression",
    agent: "process",
    resourceKind: "process_vessel",
    mode: "auto",
    escalationRole: "manager",
    criteria: [
      { label: "Culture temperature", kind: "signal", signal: "temperature", agg: "envelope", op: ">=", target: 35, targetMax: 39, unit: "°C" },
      { label: "Cell density OD600", kind: "signal", signal: "od600", agg: "last", op: ">=", target: 0.6, unit: "" },
    ],
  },
  {
    name: "Purification (FPLC)",
    agent: "process",
    resourceKind: "process_vessel",
    mode: "auto",
    escalationRole: "manager",
    criteria: [
      { label: "Purity", kind: "signal", signal: "purity_pct", agg: "last", op: ">=", target: 95, unit: "%" },
      { label: "Protein yield", kind: "signal", signal: "yield_mg_l", agg: "last", op: ">=", target: 10, unit: "mg/L" },
      { label: "Column pressure", kind: "signal", signal: "pressure_bar", agg: "max", op: "<=", target: 3, unit: "bar" },
    ],
  },
  {
    name: "QC release",
    agent: "vision_qa",
    resourceKind: "manual_station",
    mode: "approve",
    escalationRole: "manager",
    criteria: [
      { label: "Endotoxin", kind: "signal", signal: "endotoxin_eu_mg", agg: "last", op: "<=", target: 0.5, unit: "EU/mg" },
      { label: "Bioburden", kind: "signal", signal: "bioburden_cfu", agg: "last", op: "==", target: 0, unit: "CFU" },
    ],
  },
];

/** Codes from columns: one stage → "05", several → "05a", "05b". */
function withCodes(stages: Draft[]): (Draft & { code: string })[] {
  const cols = [...new Set(stages.map((s) => s.column))].sort((a, b) => a - b);
  const out: (Draft & { code: string })[] = [];
  cols.forEach((c, i) => {
    const g = stages.filter((s) => s.column === c);
    g.forEach((s, j) => out.push({ ...s, column: i + 1, code: `${String(i + 1).padStart(2, "0")}${g.length > 1 ? String.fromCharCode(97 + j) : ""}` }));
  });
  return out;
}
const fromSpec = (t: TemplateView): Draft[] => t.spec.stages.map((s) => ({ ...s, key: seq++ }));

export function Builder() {
  const { path, can, meta, live } = useApp();
  const route = useRoute();
  // signals the site's assets have reported, offered when naming a measured signal
  const seenSignals = useMemo(() => [...new Set((live?.assets ?? []).flatMap((a) => Object.keys(a.latest)))].sort(), [live?.assets]);
  const assets = useMemo(() => live?.assets ?? [], [live?.assets]);
  const toast = useToast();
  const [templates, setTemplates] = useState<TemplateView[] | null>(null);
  const [base, setBase] = useState<TemplateView | null>(null);
  const [stages, setStages] = useState<Draft[]>([]);
  const [rework, setRework] = useState<{ from: number; to: number } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("Discrete");
  const [description, setDescription] = useState("");
  const [publish, setPublish] = useState(false);
  const [note, setNote] = useState("");
  const editable = can("manager");

  useEffect(() => {
    void api.get<TemplateView[]>(path("/templates")).then((t) => {
      setTemplates(t);
      const pick = t.find((x) => x.id === route.id) ?? null;
      load(pick);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, route.id]);
  const load = (t: TemplateView | null) => {
    setBase(t);
    if (!t) {
      setStages([]);
      setRework(null);
      setName("New pipeline");
      setDescription("");
      return;
    }
    const d = fromSpec(t);
    setStages(d);
    const codes = withCodes(d);
    setRework(t.spec.rework ? { from: codes.find((c) => c.code === t.spec.rework!.from)!.key, to: codes.find((c) => c.code === t.spec.rework!.to)!.key } : null);
    setName(t.name);
    setCategory(t.category);
    setDescription(t.description);
    setSelected(d[0]?.key ?? null);
  };
  const coded = useMemo(() => withCodes(stages), [stages]);
  const columns = useMemo(() => {
    const m = new Map<number, (Draft & { code: string })[]>();
    for (const s of coded) m.set(s.column, [...(m.get(s.column) ?? []), s]);
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [coded]);
  const sel = coded.find((s) => s.key === selected) ?? null;
  const maxCol = Math.max(0, ...stages.map((s) => s.column));
  const update = (key: number, patch: Partial<Draft>) => setStages(stages.map((s) => (s.key === key ? { ...s, ...patch } : s)));

  const add = (p: (typeof PALETTE)[number]) => {
    const key = seq++;
    // criteria from the palette entry, else seeded from the library defaults for that agent (taken from any template that uses it)
    const { criteria: own, ...rest } = p;
    const crit = own ?? templates?.flatMap((t) => t.spec.stages).find((s) => s.agent === p.agent)?.criteria ?? [];
    // the machine's outcomes for this kind of stage, ready to edit; their metrics are criteria the server adds on publish
    const outcomes = (OUTCOME_PRESETS[p.resourceKind] ?? []).map((o) => ({ ...o, metric: { ...o.metric } }));
    setStages([...stages, { ...rest, key, column: maxCol + 1, timeoutMin: 60, criteria: crit.filter((c) => !c.outcome), outcomes }]);
    setSelected(key);
  };
  // Move a stage one column left/right; "parallel" puts it in the same column as its neighbour.
  const move = (key: number, dir: -1 | 1) => {
    const s = stages.find((x) => x.key === key)!;
    const alone = stages.filter((x) => x.column === s.column).length === 1;
    const target = s.column + dir;
    if (target < 1) return;
    if (alone) {
      // swap whole columns
      setStages(stages.map((x) => (x.key === key ? { ...x, column: target } : x.column === target ? { ...x, column: s.column } : x)));
    } else {
      // leave the parallel group into its own new column next to it
      const shift = dir === 1 ? s.column : s.column - 1;
      setStages(stages.map((x) => (x.key === key ? { ...x, column: shift + 0.5 } : x)).map((x) => ({ ...x, column: x.column })).sort((a, b) => a.column - b.column));
    }
  };
  const parallel = (key: number, dir: -1 | 1) => {
    const s = stages.find((x) => x.key === key)!;
    const cols = [...new Set(stages.map((x) => x.column))].sort((a, b) => a - b);
    const idx = cols.indexOf(s.column) + dir;
    if (idx < 0 || idx >= cols.length) return;
    update(key, { column: cols[idx]! });
  };
  const remove = (key: number) => {
    setStages(stages.filter((s) => s.key !== key));
    if (rework && (rework.from === key || rework.to === key)) setRework(null);
    setSelected(null);
  };

  const spec = () => ({
    stages: coded.map(({ key: _k, ...s }) => s),
    rework: rework ? { from: coded.find((c) => c.key === rework.from)!.code, to: coded.find((c) => c.key === rework.to)!.code } : null,
  });
  const errors: string[] = [];
  if (!stages.length) errors.push("Add at least one stage");
  if (stages.some((s) => s.criteria.some((c) => kindOf(c) === "signal" && !c.signal))) errors.push("Every measured-signal criterion names the signal it reads");
  if (stages.some((s) => s.criteria.some((c) => c.targetMax !== undefined && c.targetMax < c.target))) errors.push("A range's upper bound must be at least its lower bound");
  const noMachine = meta.machinesRequired === false ? [] : machineless(coded, assets);
  if (noMachine.length) errors.push(`Every stage runs on a machine: add ${noMachine.map((s) => `a ${KIND_LABEL[s.resourceKind].toLowerCase()} for ${s.code}`).join(", ")} on the Floor, or pick another`);
  for (const s of coded) for (const e of outcomeErrors(s.outcomes, s.criteria.filter((c) => !c.outcome).map((c) => c.label))) errors.push(`Stage ${s.code}: ${e}`);
  if (rework) {
    const f = coded.find((c) => c.key === rework.from);
    const t = coded.find((c) => c.key === rework.to);
    if (!f || !t || t.column >= f.column) errors.push("The rework loop must send units back to an earlier stage");
  }

  if (!templates) return <Loading />;
  return (
    <div className="builder">
      <div className="page-head">
        <div className="ph-text">
          <div className="eyebrow">{base ? `${base.origin === "library" ? "Draft · based on" : `Editing v${base.version} of`} ${base.name}` : "Draft · new pipeline"}</div>
          <h1>Pipeline builder</h1>
        </div>
        <div className="ph-actions">
          <Select
            width={280}
            value={base?.id ?? "__new"}
            onChange={(id) => go(id === "__new" ? "builder" : `builder/${id}`)}
            options={[{ value: "__new", label: "Blank pipeline", group: "New" }, ...templates.map((t) => ({ value: t.id, label: t.name, hint: t.origin === "custom" ? `v${t.version}` : "Library", group: t.category }))]}
            searchable
          />
          <button type="button" className="btn" onClick={() => load(base)}>
            Reset
          </button>
          {editable && (
            <button type="button" className="btn accent" disabled={errors.length > 0} onClick={() => setPublish(true)} title={errors.join("; ")}>
              Publish pipeline
            </button>
          )}
        </div>
      </div>
      <div className="b-grid">
        <aside className="palette">
          <span className="label">Add stage</span>
          {PALETTE.map((p) => (
            <button type="button" key={p.name} className="pal" disabled={!editable} onClick={() => add(p)}>
              + {p.name}
              <span className="faint small">{AGENT_LABEL[p.agent]}</span>
            </button>
          ))}
        </aside>
        <div className="b-canvas">
          <p className="muted small">Columns run left to right; stages stacked in a column run in parallel. Equal lane counts continue lane by lane, otherwise lanes split or merge.</p>
          <datalist id="ordo-signals">
            {seenSignals.map((sig) => (
              <option key={sig} value={sig} />
            ))}
          </datalist>
          <div className="b-cols">
            {columns.map(([col, list], i) => (
              <div key={col} className="b-colwrap">
                <div className="b-col">
                  {list.map((s) => (
                    <button type="button" key={s.key} className={`b-card${s.key === selected ? " on" : ""}`} onClick={() => setSelected(s.key)}>
                      <span className="label">Stage {s.code}</span>
                      <b>{s.name}</b>
                      <span className="faint small">{(s.machine && assets.find((a) => a.id === s.machine)?.name) || KIND_LABEL[s.resourceKind]}</span>
                      {s.resourceKind !== "system" && (
                        <span className={`faint small${s.outcomes.length < MIN_OUTCOMES ? " warn-t" : ""}`}>
                          {s.outcomes.map((o) => MEDIA_ICON[o.media]).join(" ") || "no outcomes"} · {s.outcomes.length}
                        </span>
                      )}
                      {noMachine.some((m) => m.code === s.code) && <span className="tag bad">No machine</span>}
                      <span className={`tag ${s.mode === "approve" ? "accent" : ""}`}>{s.mode === "auto" ? "Auto" : s.mode === "approve" ? "Approve" : "Manual"}</span>
                    </button>
                  ))}
                </div>
                {i < columns.length - 1 && <span className="b-arrow">→</span>}
              </div>
            ))}
            {!stages.length && <p className="faint">Add stages from the palette.</p>}
          </div>
          <div className="rework-edit">
            <span className="label">Rework loop</span>
            <Select size="sm" width={220} value={rework ? String(rework.from) : null} onChange={(v) => setRework({ from: Number(v), to: rework?.to ?? coded[0]!.key })} options={coded.map((s) => ({ value: String(s.key), label: `From ${s.code} ${s.name}` }))} placeholder="No rework loop" />
            <Select size="sm" width={220} value={rework ? String(rework.to) : null} onChange={(v) => rework && setRework({ ...rework, to: Number(v) })} options={coded.map((s) => ({ value: String(s.key), label: `back to ${s.code} ${s.name}` }))} placeholder="back to…" disabled={!rework} />
            {rework && (
              <button type="button" className="link" onClick={() => setRework(null)}>
                Remove loop
              </button>
            )}
          </div>
          {errors.length > 0 && stages.length > 0 && <p className="field-e">{errors.join(". ")}</p>}
          <div className="form-grid three">
            <Field label="Pipeline name">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={!editable} />
            </Field>
            <Field label="Category">
              <Select value={category} onChange={setCategory} options={[...new Set([...meta.categories, category])].map((c) => ({ value: c, label: c }))} />
            </Field>
            <Field label="Description">
              <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} disabled={!editable} />
            </Field>
          </div>
        </div>
        <aside className="inspector">
          {sel ? (
            <StageInspector
              key={sel.key}
              s={sel}
              editable={editable}
              meta={meta}
              assets={assets}
              onChange={(p) => update(sel.key, p)}
              onMove={(d) => move(sel.key, d)}
              onParallel={(d) => parallel(sel.key, d)}
              onRemove={() => remove(sel.key)}
            />
          ) : (
            <p className="faint">Select a stage to configure its agent, resource, gate and success criteria.</p>
          )}
        </aside>
      </div>
      <Modal
        open={publish}
        onClose={() => setPublish(false)}
        title="Publish pipeline"
        eyebrow={base?.origin === "custom" ? `New version of ${base.name}` : "New template for this site"}
        footer={
          <div className="btns end">
            <button type="button" className="btn" onClick={() => setPublish(false)}>
              Cancel
            </button>
            <Action
              className="btn accent"
              onClick={async () => {
                const t = await api.post<TemplateView>(path("/templates"), { templateId: base?.id, name, category, description, spec: spec(), note: note || undefined });
                toast(`Published ${t.name} v${t.version}`, "ok");
                setPublish(false);
                go(`builder/${t.id}`);
              }}
            >
              Publish
            </Action>
          </div>
        }
      >
        <p className="muted">Publishing creates a new immutable template version. Runs already in progress keep the version they started with. The spec hash is written to the ledger.</p>
        <Field label="Change note">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="What changed and why" />
        </Field>
      </Modal>
    </div>
  );
}

function StageInspector(props: {
  s: Draft & { code: string };
  editable: boolean;
  meta: ReturnType<typeof useApp>["meta"];
  assets: AssetView[];
  onChange: (p: Partial<Draft>) => void;
  onMove: (d: -1 | 1) => void;
  onParallel: (d: -1 | 1) => void;
  onRemove: () => void;
}) {
  const { s, editable, meta } = props;
  const setCrit = (i: number, p: Partial<Criterion>) => props.onChange({ criteria: s.criteria.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  const machines = props.assets.filter((a) => a.kind === s.resourceKind);
  return (
    <div className="insp">
      <div className="insp-h">
        <h2>Stage {s.code}</h2>
        {editable && (
          <span className="btns">
            <button type="button" className="icon-btn" title="Earlier column" onClick={() => props.onMove(-1)}>
              ←
            </button>
            <button type="button" className="icon-btn" title="Later column" onClick={() => props.onMove(1)}>
              →
            </button>
            <button type="button" className="link danger" onClick={props.onRemove}>
              Remove
            </button>
          </span>
        )}
      </div>
      {editable && (
        <div className="btns small">
          <button type="button" className="link" onClick={() => props.onParallel(-1)}>
            Run in parallel with previous
          </button>
          <button type="button" className="link" onClick={() => props.onParallel(1)}>
            … with next
          </button>
        </div>
      )}
      <fieldset disabled={!editable} className="plain">
        <Field label="Stage name">
          <input className="input" value={s.name} onChange={(e) => props.onChange({ name: e.target.value })} />
        </Field>
        <Field label="Assigned resource">
          <Select value={s.resourceKind} onChange={(v) => props.onChange({ resourceKind: v as AssetKind, machine: undefined })} options={meta.assetKinds.map((k) => ({ value: k.key, label: KIND_LABEL[k.key as AssetKind] ?? k.label }))} disabled={!editable} />
        </Field>
        {s.resourceKind !== "system" && (
          <Field label="Machine" hint={machines.length ? "Pin one machine, or let each run take any free machine of this kind." : undefined}>
            {machines.length ? (
              <Select
                value={s.machine ?? ""}
                onChange={(v) => props.onChange({ machine: v || undefined })}
                options={[{ value: "", label: `Any free ${KIND_LABEL[s.resourceKind].toLowerCase()}`, hint: `${machines.length} in this org` }, ...machines.map((a) => ({ value: a.id, label: a.name, hint: a.status.replaceAll("_", " ") }))]}
                disabled={!editable}
              />
            ) : (
              <p className="field-e">
                No {KIND_LABEL[s.resourceKind].toLowerCase()} in this org yet, and every stage runs on a machine. <a href={href("floor")}>Add one on the Floor</a>
              </p>
            )}
          </Field>
        )}
        <Field label="Agent">
          <Select<AgentKey> value={s.agent} onChange={(v) => props.onChange({ agent: v })} options={meta.agents.map((a) => ({ value: a.key, label: a.label, hint: a.scope }))} disabled={!editable} />
        </Field>
        <Field label="Execution mode" hint={s.mode === "auto" ? "Agent runs the stage and advances on success criteria." : s.mode === "approve" ? "Agent prepares and recommends; a person signs off before advancing." : "A person executes; the agent tracks and records."}>
          <Segmented<Mode>
            value={s.mode}
            onChange={(m) => editable && props.onChange({ mode: m })}
            options={[
              { value: "auto", label: "Auto" },
              { value: "approve", label: "Approve" },
              { value: "manual", label: "Manual" },
            ]}
          />
        </Field>
        {s.resourceKind !== "system" && <OutcomesEditor outcomes={s.outcomes} editable={editable} onChange={(outcomes) => props.onChange({ outcomes })} />}
        <div className="section-h spread">
          <span className="field-l">Parameters (success criteria)</span>
          {editable && (
            <button type="button" className="link" onClick={() => props.onChange({ criteria: [...s.criteria, { label: "Yield", kind: "yield", op: ">=", target: 98, unit: "%" }] })}>
              + Add
            </button>
          )}
        </div>
        {s.criteria.map((c, i) => {
          if (c.outcome) return null;
          const kind = kindOf(c);
          const range = c.targetMax !== undefined;
          const band = bandOf(c);
          return (
            <div key={i} className="crit2">
              <div className="crit">
                <Select<CriterionKind>
                  size="sm"
                  width={150}
                  value={kind}
                  onChange={(k) => setCrit(i, { kind: k, ...(k === "signal" ? { signal: c.signal ?? "", agg: c.agg ?? "last" } : { signal: undefined, agg: undefined }), ...(k !== "signal" && c.agg === "envelope" ? { targetMax: undefined } : {}) })}
                  options={KINDS.map((k) => ({ value: k, label: CRIT_KIND_LABEL[k] }))}
                  searchable={false}
                  disabled={!editable}
                />
                <input className="input sm" value={c.label} placeholder="Name" onChange={(e) => setCrit(i, { label: e.target.value })} />
                {editable && (
                  <button type="button" className="icon-btn" aria-label="Remove" onClick={() => props.onChange({ criteria: s.criteria.filter((_, j) => j !== i) })}>
                    ×
                  </button>
                )}
              </div>
              {kind === "signal" && (
                <div className="crit">
                  <input className="input sm sig" list="ordo-signals" value={c.signal ?? ""} placeholder="signal, as the asset reports it" aria-label="Signal" onChange={(e) => setCrit(i, { signal: e.target.value.trim().toLowerCase().replace(/\s+/g, "_") })} />
                  <Select<SignalAgg> size="sm" width={124} value={c.agg ?? "last"} onChange={(a) => setCrit(i, { agg: a, ...(a === "envelope" ? { op: ">=", targetMax: c.targetMax ?? c.target, abs: undefined } : {}) })} options={AGGS.map((a) => ({ value: a, label: AGG_LABEL[a] }))} searchable={false} disabled={!editable} />
                </div>
              )}
              <div className="crit">
                {range ? <span className="faint small">from</span> : <Select size="sm" width={58} value={c.op} onChange={(v) => setCrit(i, { op: v as Criterion["op"] })} options={[">=", "<=", "=="].map((o) => ({ value: o, label: o === ">=" ? "≥" : o === "<=" ? "≤" : "=" }))} searchable={false} disabled={!editable} />}
                <input className="input sm num" type="number" step="any" value={c.target} aria-label={range ? "Lower bound" : "Target"} onChange={(e) => setCrit(i, { target: Number(e.target.value) })} />
                {range && (
                  <>
                    <span className="faint small">to</span>
                    <input className="input sm num" type="number" step="any" value={c.targetMax} aria-label="Upper bound" onChange={(e) => setCrit(i, { targetMax: Number(e.target.value) })} />
                  </>
                )}
                <input className="input sm unit" value={c.unit} placeholder="unit" aria-label="Unit" onChange={(e) => setCrit(i, { unit: e.target.value })} />
                {editable && c.agg !== "envelope" && (
                  <button type="button" className="link small" title={range ? "Back to a single target" : "A range: lower and upper bound"} onClick={() => setCrit(i, range ? { targetMax: undefined } : { targetMax: c.target, op: ">=", abs: undefined })}>
                    {range ? "single" : "range"}
                  </button>
                )}
              </div>
              <SpecBand lo={band.lo} hi={band.hi} value={null} ok={null} unit={c.unit} label={`${c.label || CRIT_KIND_LABEL[kind]} ${targetText(c)}`} />
            </div>
          );
        })}
        <p className="faint small">
          Yield, scrap, defects (ppm), cycle time and OEE come from the stage&apos;s counts and time. A measured signal is read from the stage&apos;s asset over the stage window: its final value, minimum, maximum or mean, or it must stay within a range. &quot;Confirmed by a person&quot;
          always stops at the gate. Every measured parameter the stage meets is proven in zero knowledge on the lot passport.
        </p>
        <div className="form-grid two">
          <Field label="Timeout (min)">
            <input className="input" type="number" min={1} value={s.timeoutMin} onChange={(e) => props.onChange({ timeoutMin: Math.max(1, Number(e.target.value)) })} />
          </Field>
          <Field label="Completes when (optional)" hint="A batch process closes on its phase signal instead of its counts, e.g. execution = COMPLETE. The whole order then counts as made.">
            <div className="crit">
              <input
                className="input sm sig"
                list="ordo-signals"
                placeholder="signal"
                aria-label="Completion signal"
                value={s.completeOn?.signal ?? ""}
                disabled={!editable}
                onChange={(e) => {
                  const sig = e.target.value.trim().toLowerCase().replace(/\s+/g, "_");
                  props.onChange({ completeOn: sig ? { signal: sig, equals: s.completeOn?.equals ?? "COMPLETE" } : undefined });
                }}
              />
              <span className="faint small">=</span>
              <input className="input sm" placeholder="value" aria-label="Completion value" value={s.completeOn?.equals ?? ""} disabled={!editable || !s.completeOn} onChange={(e) => props.onChange({ completeOn: s.completeOn ? { ...s.completeOn, equals: e.target.value } : undefined })} />
            </div>
          </Field>
          <Field label="Escalate to">
            <Select<Role> value={s.escalationRole} onChange={(v) => props.onChange({ escalationRole: v })} options={meta.roles.filter((r) => r.key === "manager").map((r) => ({ value: r.key, label: r.label, hint: "Gates and misses go to a manager" }))} disabled={!editable} />
          </Field>
        </div>
      </fieldset>
    </div>
  );
}

/**
 * What the stage's machine captures, as media, and the value read from each: the value is judged like any measured
 * parameter (the server adds it to the stage's criteria as signal outcome.<key>) and proven on the lot passport.
 */
function OutcomesEditor({ outcomes, editable, onChange }: { outcomes: Outcome[]; editable: boolean; onChange: (o: Outcome[]) => void }) {
  const set = (i: number, p: Partial<Outcome>) => onChange(outcomes.map((o, j) => (j === i ? { ...o, ...p } : o)));
  const setMetric = (i: number, p: Partial<Outcome["metric"]>) => set(i, { metric: { ...outcomes[i]!.metric, ...p } });
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= outcomes.length) return;
    const next = [...outcomes];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  const add = (media: OutcomeMedia) => {
    const label = MEDIA_LABEL[media];
    onChange([...outcomes, { key: outcomeKey(label, outcomes.map((o) => o.key)), label, media, instrument: "", metric: { label: "", unit: "", op: "<=", target: 0 }, required: true }]);
  };
  return (
    <div className="outcomes-ed">
      <div className="section-h spread">
        <span className="field-l">Outcomes the machine captures</span>
        <span className={`small ${outcomes.length < MIN_OUTCOMES ? "warn-t" : "faint"}`}>
          {outcomes.length} of at least {MIN_OUTCOMES}
        </span>
      </div>
      <p className="faint small">Each outcome is a file the stage&apos;s machine records and signs: a thermal image, a micrograph, audio, video, a spectrum or a document, and the value its agent reads from it. The contributor confirms them in their proof of work.</p>
      {outcomes.map((o, i) => (
        <div key={i} className="oc-ed">
          <div className="crit">
            <Select<OutcomeMedia> size="sm" width={150} value={o.media} onChange={(m) => set(i, { media: m })} options={MEDIA.map((m) => ({ value: m, label: `${MEDIA_ICON[m]} ${MEDIA_LABEL[m]}` }))} searchable={false} disabled={!editable} />
            <input
              className="input sm"
              value={o.label}
              placeholder="Name, e.g. Jacket thermal image"
              aria-label="Outcome name"
              onChange={(e) => set(i, { label: e.target.value, ...(o.key === outcomeKey(o.label, outcomes.filter((_, j) => j !== i).map((x) => x.key)) ? { key: outcomeKey(e.target.value, outcomes.filter((_, j) => j !== i).map((x) => x.key)) } : {}) })}
            />
            {editable && (
              <span className="btns">
                <button type="button" className="icon-btn" aria-label="Move up" onClick={() => move(i, -1)} disabled={i === 0}>
                  ↑
                </button>
                <button type="button" className="icon-btn" aria-label="Remove" onClick={() => onChange(outcomes.filter((_, j) => j !== i))}>
                  ×
                </button>
              </span>
            )}
          </div>
          <div className="crit">
            <input className="input sm" value={o.instrument} placeholder="Instrument, e.g. FLIR A700" aria-label="Instrument" onChange={(e) => set(i, { instrument: e.target.value })} />
            <input className="input sm sig" value={o.key} aria-label="Key" title="The key the machine uploads under" onChange={(e) => set(i, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32) })} />
          </div>
          <div className="crit">
            <input className="input sm" value={o.metric.label} placeholder="Value read from it, e.g. Jacket ΔT" aria-label="Value read" onChange={(e) => setMetric(i, { label: e.target.value })} />
            {o.metric.targetMax !== undefined ? (
              <span className="faint small">from</span>
            ) : (
              <Select
                size="sm"
                width={58}
                value={o.metric.op}
                onChange={(v) => setMetric(i, { op: v as Outcome["metric"]["op"] })}
                options={[">=", "<=", "=="].map((x) => ({ value: x, label: x === ">=" ? "≥" : x === "<=" ? "≤" : "=" }))}
                searchable={false}
                disabled={!editable}
              />
            )}
            <input className="input sm num" type="number" step="any" value={o.metric.target} aria-label="Target" onChange={(e) => setMetric(i, { target: Number(e.target.value) })} />
            {o.metric.targetMax !== undefined && (
              <>
                <span className="faint small">to</span>
                <input className="input sm num" type="number" step="any" value={o.metric.targetMax} aria-label="Upper bound" onChange={(e) => setMetric(i, { targetMax: Number(e.target.value) })} />
              </>
            )}
            <input className="input sm unit" value={o.metric.unit} placeholder="unit" aria-label="Unit" onChange={(e) => setMetric(i, { unit: e.target.value })} />
            {editable && (
              <button type="button" className="link small" onClick={() => setMetric(i, o.metric.targetMax !== undefined ? { targetMax: undefined } : { targetMax: o.metric.target, op: ">=" })}>
                {o.metric.targetMax !== undefined ? "single" : "range"}
              </button>
            )}
          </div>
          <label className="check small">
            <input type="checkbox" checked={o.required} onChange={(e) => set(i, { required: e.target.checked })} /> Required · {metricText(o.metric)}
          </label>
        </div>
      ))}
      {editable && outcomes.length < 12 && (
        <div className="oc-add">
          {MEDIA.map((m) => (
            <button key={m} type="button" className="chip-btn" onClick={() => add(m)} title={`Add a ${MEDIA_LABEL[m].toLowerCase()}`}>
              {MEDIA_ICON[m]} {MEDIA_LABEL[m]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
