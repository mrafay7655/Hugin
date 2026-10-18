"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Ban, Bot, Check, CheckCheck, ChevronDown, CircleAlert, ShieldAlert, Sparkles, UserRoundCheck, type LucideIcon } from "lucide-react";
import type { Channel, CommentPlatform, CommentSentiment, Customer, DecisionLabel, Origin, Trace } from "@/lib/types";

export const Eye = ({ size = 18 }: { size?: number }) => <span className="eye" style={{ width: size, height: size }} />;

export const CHANNELS: Record<Channel, { label: string; color: string }> = {
  whatsapp: { label: "WhatsApp", color: "#25A366" },
  instagram: { label: "Instagram", color: "#D6457A" },
  facebook: { label: "Messenger", color: "#3B6FD8" },
  x: { label: "X", color: "#18181B" },
  tiktok: { label: "TikTok", color: "#10B5AE" },
  telegram: { label: "Telegram", color: "#2AA3D6" },
  webchat: { label: "Web chat", color: "#4A54CF" },
};

export const PLATFORMS: Record<CommentPlatform, { label: string; color: string }> = {
  instagram: { label: "Instagram", color: "#D6457A" },
  facebook: { label: "Facebook", color: "#3B6FD8" },
  youtube: { label: "YouTube", color: "#E5484D" },
  x: { label: "X", color: "#18181B" },
  tiktok: { label: "TikTok", color: "#10B5AE" },
};

export function timeAgo(at: number) {
  const s = Math.max(1, Math.round((Date.now() - at) / 1000));
  if (s < 45) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m";
  const h = Math.round(m / 60);
  if (h < 24) return h + "h";
  return Math.round(h / 24) + "d";
}
/** True when `at` is less than `ms` ago. */
export const within = (at: number, ms: number) => Date.now() - at < ms;
export const ago = (at: number) => {
  const t = timeAgo(at);
  return t === "now" ? "just now" : t + " ago";
};
export const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
export const human = (s: string) => s.replace(/_/g, " ");

export function useTick(ms = 30000) {
  const [, f] = useState(0);
  useEffect(() => {
    const t = setInterval(() => f((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

const FALLBACK: Pick<Customer, "initials" | "color"> = { initials: "?", color: ["#EFEFF1", "#3F3F46"] };

export function Avatar({ c, size = "", ch }: { c?: Pick<Customer, "initials" | "color">; size?: "" | "sm" | "lg"; ch?: Channel }) {
  const v = c ?? FALLBACK;
  return (
    <span className={"av " + size} style={{ background: v.color[0], color: v.color[1] }}>
      {v.initials}
      {ch && <span className="ch" style={{ background: CHANNELS[ch]?.color }} />}
    </span>
  );
}

export function ChannelBadge({ ch }: { ch: Channel }) {
  return (
    <span className="badge b-out">
      <span className="dot" style={{ background: CHANNELS[ch]?.color }} />
      {CHANNELS[ch]?.label ?? ch}
    </span>
  );
}

const DEC: Record<DecisionLabel, [string, string, LucideIcon]> = {
  auto_resolved: ["b-ok", "Auto-resolved", Check],
  resolved: ["b-n", "Resolved", CheckCheck],
  draft_ready: ["b-acc", "Draft ready", Sparkles],
  needs_human: ["b-warn", "Needs human", UserRoundCheck],
  fraud_risk: ["b-err", "Fraud risk", ShieldAlert],
  phishing: ["b-err", "Phishing", ShieldAlert],
  no_source: ["b-n", "No source", Ban],
  human: ["b-n", "Human handled", UserRoundCheck],
};
export function DecisionBadge({ d, pulse }: { d: DecisionLabel; pulse?: boolean }) {
  const [cls, label, Icon] = DEC[d] ?? DEC.human;
  return (
    <span className={"badge " + cls} style={pulse ? { boxShadow: "0 0 0 3px rgba(217,63,63,.15)" } : undefined}>
      <Icon />
      {label}
    </span>
  );
}

const SENT: Record<CommentSentiment, string> = { positive: "b-ok", neutral: "b-n", negative: "b-err", mixed: "b-warn" };
export function SentimentBadge({ s, sarcasm }: { s: CommentSentiment; sarcasm?: boolean }) {
  return (
    <span className={"badge " + SENT[s]}>
      {s[0].toUpperCase() + s.slice(1)}
      {sarcasm ? " · sarcasm" : ""}
    </span>
  );
}

export function ConfidenceBadge({ v }: { v: number }) {
  const cls = v >= 0.85 ? "b-ok" : v >= 0.6 ? "b-warn" : "b-err";
  return <span className={"badge mono " + cls}>{v.toFixed(2)}</span>;
}

/** Where an item came from. Sample data is ours; simulated is typed in the demo tools; live came in on a real channel. */
export function originOf(x: { origin?: Origin; sample?: boolean; transport?: string }): Origin {
  if (x.origin) return x.origin;
  if (x.sample) return "sample";
  return x.transport === "sim" ? "simulated" : "live";
}

export function OriginBadge({ o }: { o: Origin }) {
  if (o === "sample") return <span className="b-sample">SAMPLE</span>;
  if (o === "simulated") return <span className="b-sample" style={{ background: "var(--a50)", color: "var(--a700)" }}>SIMULATED</span>;
  return <span className="b-sample" style={{ background: "var(--ok-bg)", color: "var(--ok-fg)" }}>LIVE</span>;
}

/** Which brain read the message: Gemini (with its model and time), or the rules when the model was not used or failed. */
export function ModelBadge({ t }: { t: Trace }) {
  const a = t.adk;
  if (t.source === "gemini") {
    const model = a?.model && a.model !== "rules-only" ? a.model.replace(/^gemini-/, "Gemini ").replace(/-flash/, " Flash").replace(/-pro/, " Pro") : "Gemini";
    return <span className="badge b-acc" title="Understood by Gemini through Google ADK">{model}{a?.understandMs ? ` · ${(a.understandMs / 1000).toFixed(1)}s` : ""}</span>;
  }
  return <span className="badge b-n" title={a?.modelError ?? "No model configured"}>{a?.modelError ? "Rules (model unavailable)" : "Rules only"}</span>;
}

export function TraceCard({ t, open: openInit = false }: { t: Trace; open?: boolean }) {
  const [open, setOpen] = useState(openInit);
  return (
    <div className="trace">
      <div className="trace-h" onClick={() => setOpen((o) => !o)}>
        <Bot size={15} />
        <b style={{ fontWeight: 500 }}>{t.summary || human(t.action)}</b>
        <span className="faint grow ellipsis">
          · {human(t.intent)} · {t.policyId} {t.policy}
        </span>
        <ModelBadge t={t} />
        <ConfidenceBadge v={t.confidence} />
        <ChevronDown size={15} className="faint" style={{ transform: open ? "rotate(180deg)" : "", transition: "transform .2s" }} />
      </div>
      {open && (
        <div className="trace-b">
          {t.adk?.overridden && t.adk.modelReading && (
            <div className="banner" style={{ background: "var(--warn-bg)", color: "var(--warn-fg)", fontSize: 12, padding: "6px 10px", margin: "4px 0 6px" }}>
              Gemini read this as {human(t.adk.modelReading.intent)}; the safety rules kept the more cautious {human(t.intent)}.
            </div>
          )}
          {t.steps.map((s, i) => (
            <div className="step" key={i}>
              <span className={"n " + (s.tone === "warn" ? "warn" : "")}>
                {s.tone === "warn" ? <CircleAlert size={11} /> : <Check size={11} strokeWidth={2.6} />}
              </span>
              <div>
                <b style={{ fontWeight: 500 }}>{s.label}</b> <span className="faint">· {s.detail}</span>
              </div>
            </div>
          ))}
          <div className="row" style={{ marginTop: 6, fontSize: 11.5 }}>
            <span className="faint">Confidence</span>
            <div className="bar grow" style={{ maxWidth: 220 }}>
              <i style={{ width: t.confidence * 100 + "%" }} />
            </div>
            <span className="mono">{t.confidence.toFixed(2)}</span>
            <span className="faint" style={{ marginLeft: "auto" }}>
              {t.source === "gemini" ? "Gemini" : "Rules"} · {t.tools.length ? t.tools.join(" · ") + " · " : ""}
              {(t.latencyMs / 1000).toFixed(1)}s
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="card stat">
      <div className="l">{label}</div>
      <div className="v">{value}</div>
      {sub && <div className="faint" style={{ fontSize: 12 }}>{sub}</div>}
    </div>
  );
}

export function Empty({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Icon size={28} />
      <b>{title}</b>
      {children}
    </div>
  );
}

/** Shown where a judge sees a screen but cannot change it. */
export function ReadOnlyNote({ what = "settings" }: { what?: string }) {
  return (
    <div className="banner" style={{ background: "var(--warn-bg)", color: "var(--warn-fg)", fontSize: 13 }}>
      You are signed in as a judge. You can look at everything here, but only a manager can change {what}.
    </div>
  );
}

export function Loading() {
  return (
    <div className="empty" style={{ margin: "auto" }}>
      <span className="eye spin" style={{ width: 22, height: 22 }} />
    </div>
  );
}
