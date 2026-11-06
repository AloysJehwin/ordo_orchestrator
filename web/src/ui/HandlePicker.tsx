import { useEffect, useState } from "react";
import { api } from "../api";
import type { HandleCheck } from "../types";

/**
 * Pick the handle a person's ENS names use (priya → priya.acme.ordo.eth, and priya.validators.acme.ordo.eth for a
 * role they hold). It is checked as it is typed: format, reserved words, and whether someone has it. Empty is allowed:
 * the server then gives the wallet a member-<hex> handle.
 */
export function HandlePicker({
  value,
  onChange,
  onValid,
  org,
  suggestion,
  label = "Your handle",
}: {
  value: string;
  onChange: (v: string) => void;
  /** told whether the current value can be used (an empty value counts as usable) */
  onValid?: (ok: boolean) => void;
  /** the org's name, for the preview (acme.ordo.eth); a placeholder when the org does not exist yet */
  org?: string | null;
  suggestion?: string | null;
  label?: string;
}) {
  const [check, setCheck] = useState<HandleCheck | null>(null);
  const h = value.trim().toLowerCase();
  useEffect(() => {
    setCheck(null);
    if (!h) {
      onValid?.(true);
      return;
    }
    onValid?.(false);
    const t = setTimeout(() => {
      api
        .get<HandleCheck>(`/v1/handles/${encodeURIComponent(h)}`)
        .then((c) => {
          setCheck(c);
          onValid?.(c.available);
        })
        .catch(() => onValid?.(false));
    }, 300);
    return () => clearTimeout(t);
    // onValid is a callback prop: re-checking on its identity would loop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [h]);
  const preview = `${h || "you"}.${org ?? "your-org.ordo.eth"}`;
  return (
    <div className="field handle-picker">
      <span className="field-l">{label}</span>
      <div className="handle-row">
        <input
          aria-label={label}
          className="mono"
          value={value}
          maxLength={32}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          placeholder={suggestion ?? "priya"}
          onChange={(e) => onChange(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
        />
        {!value && suggestion && (
          <button type="button" className="btn sm" onClick={() => onChange(suggestion)}>
            Use {suggestion}
          </button>
        )}
      </div>
      <div className="small muted">
        Your ENS name: <span className="mono">{preview}</span>
        {check && !check.available && (
          <span className="field-e">
            {" "}
            · {check.reason ?? "taken"}
            {check.suggestion && (
              <>
                {" "}
                <button type="button" className="link" onClick={() => onChange(check.suggestion!)}>
                  use {check.suggestion}
                </button>
              </>
            )}
          </span>
        )}
        {check?.available && <span className="ok-text"> · available</span>}
      </div>
      <div className="small faint">Handles are public on Sepolia ENS and stay in its history for good. Your display name never goes on-chain.</div>
    </div>
  );
}
