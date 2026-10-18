"use client";

import { useState } from "react";
import { Lock, ShieldCheck } from "lucide-react";
import { useIsJudge } from "@/lib/auth";
import { call, useDoc } from "@/lib/data";
import { useAction } from "@/lib/toast";
import type { Policy } from "@/lib/types";
import { Topbar } from "@/components/shell";
import { Loading, ReadOnlyNote, human } from "@/components/ui";

const LOCKED = ["account_change"];
const HUMAN_OPTIONS = ["account_change", "refund", "money_movement", "identity", "complaint"];
const RULES = [
  ["P-07", "Clear fraud or one-time-code report", "Lock the card, reassure, open a case, notify Fraud. At once."],
  ["P-05", "Possible fraud, not confirmed", "A keyword alone never locks a card. A person reviews it first."],
  ["P-08", "Suspicious link or screenshot", "Check the domain against the official one; lookalikes are treated as phishing."],
  ["P-04", "Always-human intents", "Draft only. A person approves before anything is sent."],
  ["P-01", "Confident and sourced", "Auto-send, with the approved source cited."],
  ["P-06", "Unsure", "Draft for a person."],
  ["P-02", "No approved source", "Honest fallback and hand to a person. Never guess."],
  ["P-99", "Anything fails", "Fail safe: hand to a person."],
];

export default function PoliciesPage() {
  const act = useAction();
  const judge = useIsJudge();
  const { data: policy, loading } = useDoc<Policy>("settings/policy");
  // Only what the manager has changed is kept here; everything else follows the saved policy.
  const [edit, setEdit] = useState<Partial<Pick<Policy, "autoSend" | "draft" | "alwaysHuman">>>({});
  if (loading || !policy) return <Loading />;

  const p = { ...policy, ...edit };
  const changed = (edit.autoSend !== undefined && edit.autoSend !== policy.autoSend) || (edit.draft !== undefined && edit.draft !== policy.draft) || (edit.alwaysHuman !== undefined && edit.alwaysHuman.join() !== policy.alwaysHuman.join());
  const dirty = !judge && changed && p.draft < p.autoSend;
  const save = async () => { if (await act(() => call("updatePolicy", { autoSend: p.autoSend, draft: p.draft, alwaysHuman: p.alwaysHuman }), "Policy saved and audited")) setEdit({}); };
  const toggle = (k: string) => setEdit({ ...edit, alwaysHuman: p.alwaysHuman.includes(k) ? p.alwaysHuman.filter((x) => x !== k) : [...p.alwaysHuman, k] });

  return (
    <>
      <Topbar title="Agent policies">{!judge && <button className="btn primary sm" disabled={!dirty} onClick={save}>Save changes</button>}</Topbar>
      <div className="page page-narrow" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {judge && <ReadOnlyNote what="the agent's policy" />}
        <div className="card">
          <h3 style={{ margin: "0 0 4px" }}>Confidence thresholds</h3>
          <p className="muted" style={{ fontSize: 13, margin: "0 0 14px" }}>The model proposes, the policy decides. Above auto-send, sourced answers go out. Between the two, a person approves. Below draft, it is handed over.</p>
          <Slider label="Auto-send at or above" v={p.autoSend} min={0.6} max={0.99} disabled={judge} onChange={(v) => setEdit({ ...edit, autoSend: v })} />
          <Slider label="Draft at or above" v={p.draft} min={0.4} max={0.95} disabled={judge} onChange={(v) => setEdit({ ...edit, draft: v })} />
          {p.draft >= p.autoSend && <div className="banner" role="alert" style={{ background: "var(--err-bg)", color: "#8F2424", fontSize: 13, marginTop: 8 }}>The draft threshold must be lower than auto-send.</div>}
        </div>
        <div className="card">
          <h3 style={{ margin: "0 0 10px" }}>Always needs a person</h3>
          {HUMAN_OPTIONS.map((k) => (
            <label key={k} className="kv" style={{ cursor: LOCKED.includes(k) || judge ? "not-allowed" : "pointer", minHeight: 40, alignItems: "center" }}>
              <span>{human(k)}{LOCKED.includes(k) && <span className="faint" style={{ fontSize: 12 }}> <Lock size={11} /> locked by compliance</span>}</span>
              <input type="checkbox" style={{ width: 20, height: 20 }} checked={p.alwaysHuman.includes(k)} disabled={LOCKED.includes(k) || judge} onChange={() => toggle(k)} />
            </label>
          ))}
        </div>
        <div className="card">
          <h3 style={{ margin: "0 0 10px" }}>Rules, in order</h3>
          {RULES.map(([id, when, then]) => (
            <div key={id} style={{ padding: "9px 0", borderTop: "1px solid var(--n100)" }}>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}><span className="mono badge b-out">{id}</span><b style={{ fontWeight: 500, fontSize: 13.5 }}>{when}</b></div>
              <div className="muted" style={{ fontSize: 13, marginTop: 3 }}>{then}</div>
            </div>
          ))}
        </div>
        <div className="card">
          <h3 style={{ margin: "0 0 10px" }}><ShieldCheck size={14} style={{ verticalAlign: -2 }} /> Never sent, by anyone</h3>
          <p className="muted" style={{ fontSize: 13, margin: "0 0 8px" }}>Every outgoing message, from the agent or a person, passes this check in code.</p>
          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
            {[...p.blocked, "Ask for a card or account number", "Ask for an SSN", "Link to a site that is not the bank's", "Link to a lookalike of the bank's site"].map((b) => <span key={b} className="chip">{b}</span>)}
          </div>
        </div>
      </div>
    </>
  );
}

function Slider({ label, v, min, max, onChange, disabled }: { label: string; v: number; min: number; max: number; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="row" style={{ justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}><label htmlFor={label}>{label}</label><span className="mono">{v.toFixed(2)}</span></div>
      <input id={label} type="range" min={min} max={max} step={0.01} value={v} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} style={{ width: "100%", height: 28 }} />
    </div>
  );
}
