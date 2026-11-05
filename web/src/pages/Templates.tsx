import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../lib/app";
import { go } from "../lib/router";
import type { TemplateView } from "../types";
import { Loading, Segmented } from "../ui/kit";

/** "01 → 02a + 02b → 03" */
export function chain(t: TemplateView) {
  const cols = new Map<number, string[]>();
  for (const s of t.spec.stages) cols.set(s.column, [...(cols.get(s.column) ?? []), s.name]);
  return [...cols.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v.join(" + "));
}

export function Templates() {
  const { path, can } = useApp();
  const [list, setList] = useState<TemplateView[] | null>(null);
  const [cat, setCat] = useState("All");
  const [origin, setOrigin] = useState<"all" | "library" | "custom">("all");
  useEffect(() => {
    void api.get<TemplateView[]>(path("/templates")).then(setList);
  }, [path]);
  if (!list) return <Loading />;
  const cats = ["All", ...new Set(list.map((t) => t.category))];
  const shown = list.filter((t) => (cat === "All" || t.category === cat) && (origin === "all" || t.origin === origin));
  return (
    <div>
      <div className="eyebrow">{list.length} templates</div>
      <h1>Templates</h1>
      <p className="muted lede">Start a run from a proven pipeline, or customize one in the builder. Customizing a library template creates your site's own versioned copy.</p>
      <div className="filters">
        <Segmented size="sm" value={cat} onChange={setCat} options={cats.map((c) => ({ value: c, label: c, count: c === "All" ? list.length : list.filter((t) => t.category === c).length }))} />
        <Segmented<"all" | "library" | "custom">
          size="sm"
          value={origin}
          onChange={setOrigin}
          options={[
            { value: "all", label: "All" },
            { value: "library", label: "Library" },
            { value: "custom", label: "Your site" },
          ]}
        />
      </div>
      <div className="tgrid">
        {shown.map((t) => {
          const gates = t.spec.stages.filter((s) => s.mode === "approve").length;
          return (
            <article key={t.id} className="tcard">
              <div className="li-top">
                <span className="eyebrow">{t.category}</span>
                <span className="faint small">
                  {t.origin === "custom" ? `Custom · v${t.version}` : "Library"}
                </span>
              </div>
              <h3>{t.name}</h3>
              <p className="muted small">{t.description}</p>
              <ol className="tchain">
                {chain(t).map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ol>
              <div className="faint small">
                {t.spec.stages.length} stages · {gates} gate{gates === 1 ? "" : "s"}
                {t.spec.rework ? " · rework loop" : ""}
              </div>
              <div className="btns">
                {can("manager") && (
                  <button type="button" className="btn accent sm" onClick={() => go(`pipelines?start=${t.id}`)}>
                    Run pipeline
                  </button>
                )}
                <button type="button" className="btn sm" onClick={() => go(`builder/${t.id}`)}>
                  {can("manager") ? "Customize" : "View"}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
