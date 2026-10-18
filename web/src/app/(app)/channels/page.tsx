"use client";

import Link from "next/link";
import { CheckCircle2, CircleDashed } from "lucide-react";
import { useCollection } from "@/lib/data";
import type { Comment, Conversation } from "@/lib/types";
import { Topbar } from "@/components/shell";
import { CHANNELS, PLATFORMS } from "@/components/ui";

const LIVE: Record<string, string> = {
  whatsapp: "WhatsApp Cloud API webhook. Signed, deduplicated, 24-hour window enforced.",
  telegram: "Telegram bot (@ravenwood_hugin_bot). Secret-token webhook, deduplicated, voice notes and screenshots read by Gemini.",
  instagram: "Comments via the Meta webhook. Direct messages through the simulator for now.",
  facebook: "Page comments via the Meta webhook. Messenger through the simulator for now.",
};

export default function ChannelsPage() {
  const convs = useCollection<Conversation>("conversations").data;
  const comments = useCollection<Comment>("comments").data;
  const realWa = convs.some((c) => c.transport === "whatsapp");
  const realTg = convs.some((c) => c.transport === "telegram");
  const realComments = (p: string) => comments.some((c) => c.platform === p && !c.sample);
  const all = Array.from(new Set([...Object.keys(CHANNELS), ...Object.keys(PLATFORMS)]));
  return (
    <>
      <Topbar title="Channels" />
      <div className="page page-narrow" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>Where HUGIN listens. A channel shows Live once real traffic has arrived on it; until then the demo uses simulated messages, clearly labelled.</p>
        {all.map((k) => {
          const meta = CHANNELS[k as keyof typeof CHANNELS] ?? PLATFORMS[k as keyof typeof PLATFORMS];
          const live = (k === "whatsapp" && realWa) || (k === "telegram" && realTg) || realComments(k);
          const msgs = convs.filter((c) => c.channel === k).length;
          const cmts = comments.filter((c) => c.platform === k).length;
          return (
            <div key={k} className="card row" style={{ gap: 12, flexWrap: "wrap" }}>
              <span className="dot" style={{ background: meta.color, width: 10, height: 10 }} />
              <div className="grow" style={{ minWidth: 200 }}>
                <b style={{ fontWeight: 500 }}>{k === "facebook" ? "Facebook and Messenger" : meta.label}</b>
                <div className="faint" style={{ fontSize: 12.5 }}>{LIVE[k] ?? "Simulator only in this build."} · {msgs} conversations · {cmts} comments</div>
              </div>
              {k === "telegram" && <Link href="/channels/telegram" className="btn primary sm">Try the live bot</Link>}
              {live ? <span className="badge b-ok"><CheckCircle2 />Live</span> : <span className="badge b-n"><CircleDashed />Simulated</span>}
            </div>
          );
        })}
      </div>
    </>
  );
}
