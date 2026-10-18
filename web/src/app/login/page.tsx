"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Lock, ScrollText, ShieldCheck } from "lucide-react";
import { authErrorMessage, signInWithGoogle, signInWithPassword, useAuth } from "@/lib/auth";
import { Eye } from "@/components/ui";

/** The Google button only shows once Google sign-in is switched on for the Firebase project (NEXT_PUBLIC_GOOGLE_SIGNIN=true). */
const GOOGLE = process.env.NEXT_PUBLIC_GOOGLE_SIGNIN === "true";

export default function LoginPage() {
  const auth = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // A judge starts on Try it live; a manager on the Inbox.
  const home = auth.status === "ready" ? (auth.session.role === "judge" ? "/try" : "/inbox") : null;
  useEffect(() => {
    if (home) router.replace(home);
  }, [auth.status, home, router]);
  const denied = auth.status === "signed-out" && auth.denied ? `${auth.denied} is not approved for this workspace.` : "";

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr(authErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth-form">
        <div className="brand" style={{ padding: 0 }}><Eye />HUGIN</div>
        <div className="auth-inner">
          <h1>Welcome back</h1>
          <p className="faint" style={{ margin: "6px 0 28px" }}>Sign in to the Ravenwood Bank workspace.</p>
          {GOOGLE && (
            <>
              <button type="button" className="btn secondary auth-btn" onClick={() => run(signInWithGoogle)} disabled={busy}>Continue with Google</button>
              <div className="auth-or"><span>or</span></div>
            </>
          )}
          <form onSubmit={(e) => { e.preventDefault(); if (email && pw) run(() => signInWithPassword(email, pw)); }}>
            <label className="label" htmlFor="email">Work email</label>
            <input id="email" className="input auth-in" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@ravenwoodbank.com" />
            <label className="label" htmlFor="pw" style={{ marginTop: 14 }}>Password</label>
            <input id="pw" className="input auth-in" style={{ marginTop: 5 }} type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
            {(err || denied) && <div className="banner" role="alert" style={{ marginTop: 14, background: "var(--err-bg)", color: "#8F2424", fontSize: 13 }}>{err || denied}</div>}
            <button type="submit" className="btn primary auth-btn" style={{ marginTop: 22 }} disabled={busy || !email || !pw}>
              {busy && <Loader2 size={16} className="spin" />}
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
          <p className="faint" style={{ fontSize: 12.5, marginTop: 18, textAlign: "center" }}>
            <Lock size={12} style={{ verticalAlign: -1 }} /> Access is by invitation or approved bank domain. There is no public sign-up.
          </p>
        </div>
        <span className="faint" style={{ fontSize: 12 }}>Ravenwood Bank is a fictional demo institution.</span>
      </div>
      <div className="auth-art">
        <div className="auth-glow" />
        <div className="auth-grid" />
        <div className="auth-art-in">
          <span className="eye" style={{ width: 76, height: 76, borderWidth: 6, color: "#fff" }} />
          <h2>Sees every channel.<br /><span>Reports back calmly.</span></h2>
          <div className="auth-float f1">
            <div className="row"><span className="av sm" style={{ background: "#FDECEC", color: "#B42E2E" }}>MR</span><b style={{ fontWeight: 500 }}>Marcus Reed</b><span className="badge b-err" style={{ marginLeft: "auto" }}>Fraud risk</span></div>
            <div className="faint" style={{ fontSize: 12.5, marginTop: 6 }}>&ldquo;Someone asked for my one-time code…&rdquo;</div>
          </div>
          <div className="auth-float f2">
            <div className="row" style={{ gap: 8 }}><ShieldCheck size={16} color="#4ADE80" /><div><b style={{ fontWeight: 500 }}>Fraud team notified</b><div style={{ fontSize: 12, color: "#A1A1AA" }}>Card locked · case opened</div></div></div>
          </div>
          <div className="auth-float f3">
            <div className="row" style={{ gap: 8 }}><ScrollText size={15} color="var(--a300)" /><span style={{ fontSize: 12.5 }}>Every decision logged, nothing editable</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}
