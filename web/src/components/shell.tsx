"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Activity, BookOpen, ChartNoAxesColumn, ContactRound, Ellipsis, Gauge, Inbox, LayoutDashboard, LogOut, MessageSquareText, Plug, ScrollText, SlidersHorizontal, Sparkles, UserRoundCheck, UsersRound, type LucideIcon } from "lucide-react";
import { signOut, useSession } from "@/lib/auth";
import { useCollection } from "@/lib/data";
import type { Comment, Conversation } from "@/lib/types";
import { Eye } from "./ui";

interface Item { to: string; label: string; short?: string; icon: LucideIcon; k?: string }

const NAV: { group: string; items: Item[] }[] = [
  { group: "Start", items: [
    { to: "/try", label: "Try it live", short: "Try it", icon: Sparkles },
    { to: "/demo", label: "Demo control", icon: LayoutDashboard },
  ] },
  { group: "Engage", items: [
    { to: "/inbox", label: "Inbox", icon: Inbox, k: "inbox" },
    { to: "/approvals", label: "Approvals", icon: UserRoundCheck, k: "approvals" },
    { to: "/comments", label: "Moderation", short: "Comments", icon: MessageSquareText, k: "comments" },
    { to: "/insights", label: "Social insights", short: "Insights", icon: ChartNoAxesColumn },
    { to: "/customers", label: "Customers", icon: ContactRound },
    { to: "/knowledge", label: "Knowledge", icon: BookOpen },
  ] },
  { group: "Govern", items: [
    { to: "/agents", label: "Agent dashboard", short: "Agents", icon: Gauge },
    { to: "/agent", label: "Run replay", icon: Activity },
    { to: "/channels", label: "Channels", icon: Plug },
    { to: "/policies", label: "Agent policies", icon: SlidersHorizontal },
    { to: "/audit", label: "Audit log", icon: ScrollText },
    { to: "/access", label: "Access", icon: UsersRound },
  ] },
];

/**
 * The four screens a phone keeps one tap away. Everything else is under "More".
 * A judge starts from Try it live; a manager from the Inbox and the approval queue.
 */
const TABS_FOR = { judge: ["/try", "/inbox", "/comments", "/agents"], manager: ["/inbox", "/approvals", "/comments", "/agents"] };
const ALL = NAV.flatMap((g) => g.items);

export function Shell({ children }: { children: ReactNode }) {
  const s = useSession();
  const path = usePathname();
  const TABS = TABS_FOR[s.role];
  const [moreAt, setMoreAt] = useState<string | null>(null);
  const more = moreAt === path; // opened on this page, so it closes by itself when you go somewhere else
  const convs = useCollection<Conversation>("conversations").data;
  const comments = useCollection<Comment>("comments").data;
  const counts: Record<string, number> = {
    inbox: convs.filter((c) => c.status !== "resolved").length,
    approvals: convs.filter((c) => c.approval).length,
    comments: comments.filter((c) => c.status === "new" && (c.needsReply || c.riskFlag)).length,
  };
  const initials = s.name.split(/[\s@.]/).filter(Boolean).slice(0, 2).map((x) => x[0]?.toUpperCase()).join("");
  const roleLabel = s.role === "judge" ? "Judge · view and try" : "Manager";
  const active = (to: string) => path === to || path.startsWith(to + "/");
  const onMoreScreen = !TABS.some(active);

  const User = (
    <button className="nav" style={{ width: "100%" }} onClick={() => signOut()} title="Sign out">
      <span className="av sm" style={{ background: "var(--a50)", color: "var(--a700)" }}>{initials}</span>
      <span className="grow" style={{ textAlign: "left", minWidth: 0 }}>
        <span className="ellipsis" style={{ display: "block", color: "var(--text)", fontWeight: 500, fontSize: 13 }}>{s.name}</span>
        <span className="faint" style={{ fontSize: 11.5 }}>{roleLabel}</span>
      </span>
      <LogOut size={14} />
    </button>
  );

  return (
    <>
      <div className="app">
        <aside className="side">
          <div className="brand"><Eye />HUGIN</div>
          {NAV.map((g) => (
            <div key={g.group}>
              <div className="navh">{g.group}</div>
              {g.items.map((it) => (
                <Link key={it.to} href={it.to} className={"nav" + (active(it.to) ? " active" : "")}>
                  <it.icon size={16} />
                  {it.label}
                  {it.k && counts[it.k] > 0 && <span className={"cnt" + (it.k === "comments" ? " red" : "")}>{counts[it.k]}</span>}
                </Link>
              ))}
            </div>
          ))}
          <div className="foot">{User}</div>
        </aside>

        <div className="main">{children}</div>

        <nav className="tabbar" aria-label="Main">
          {TABS.map((to) => {
            const it = ALL.find((i) => i.to === to)!;
            const n = it.k ? counts[it.k] : 0;
            return (
              <Link key={to} href={to} className={"tb" + (active(to) ? " active" : "")} aria-current={active(to) ? "page" : undefined}>
                <it.icon size={21} />
                {it.short ?? it.label}
                {n > 0 && <span className={"cnt" + (it.k === "comments" ? " red" : "")}>{n > 99 ? "99+" : n}</span>}
              </Link>
            );
          })}
          <button className={"tb" + (onMoreScreen || more ? " active" : "")} onClick={() => setMoreAt(more ? null : path)} aria-expanded={more} aria-label="More">
            <Ellipsis size={21} />
            More
          </button>
        </nav>
      </div>

      {more && (
        <>
          <div className="more-bg" onClick={() => setMoreAt(null)} />
          <div className="more" role="dialog" aria-label="More screens">
            <div className="grab" />
            {NAV.map((g) => (
              <div key={g.group}>
                <div className="navh">{g.group}</div>
                {g.items.filter((it) => !TABS.includes(it.to)).map((it) => (
                  <Link key={it.to} href={it.to} onClick={() => setMoreAt(null)} className={"nav" + (active(it.to) ? " active" : "")}>
                    <it.icon size={18} />
                    {it.label}
                  </Link>
                ))}
              </div>
            ))}
            <div className="divider" style={{ margin: "10px 0" }} />
            {User}
          </div>
        </>
      )}
    </>
  );
}

export function Topbar({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="topbar">
      <h1>{title}</h1>
      {children && <div className="row">{children}</div>}
    </div>
  );
}
