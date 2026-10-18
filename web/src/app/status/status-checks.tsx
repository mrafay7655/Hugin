"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react";
import { doc, getDoc } from "firebase/firestore";
import { firebase, firebaseProjectId, hasFirebaseConfig } from "@/lib/firebase/client";

type Result = { state: "run" | "ok" | "warn" | "err"; detail: string };
type Row = { id: string; label: string; result: Result };

const initial: Row[] = [
  { id: "config", label: "Firebase config loaded", result: { state: "run", detail: "" } },
  { id: "auth", label: "Authentication SDK initialized", result: { state: "run", detail: "" } },
  { id: "firestore", label: "Firestore reachable", result: { state: "run", detail: "" } },
  { id: "storage", label: "Cloud Storage bucket configured", result: { state: "run", detail: "" } },
];

export function StatusChecks() {
  const [rows, setRows] = useState<Row[]>(initial);
  const set = (id: string, result: Result) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, result } : r)));

  useEffect(() => {
    async function run() {
      await Promise.resolve(); // yield: the Firebase SDK is client-only, never touch it during render
      if (!hasFirebaseConfig) {
        set("config", { state: "err", detail: "Missing NEXT_PUBLIC_FIREBASE_* values in .env.local" });
        return;
      }
      set("config", { state: "ok", detail: `Project ${firebaseProjectId}` });
      try {
        const { auth, db, storage } = firebase();
        set("auth", { state: "ok", detail: `Auth domain ${auth.config.authDomain}` });
        set("storage", { state: "ok", detail: storage.app.options.storageBucket ?? "" });
        // Read a path that should not exist. "permission-denied" proves we reached Firestore
        // and the rules are enforcing; a clean read means reads are open.
        try {
          await getDoc(doc(db, "_status", "ping"));
          set("firestore", { state: "warn", detail: "Reachable, but reads are currently allowed. Deploy locked-down rules." });
        } catch (e) {
          const err = e as { code?: string; message?: string };
          if (err.code === "permission-denied") {
            set("firestore", { state: "ok", detail: "Reachable. Security rules are denying anonymous reads." });
          } else {
            set("firestore", { state: "err", detail: err.code ?? err.message ?? "Unknown error" });
          }
        }
      } catch (e) {
        set("auth", { state: "err", detail: (e as Error).message });
      }
    }
    void run();
  }, []);

  return (
    <div className="card" style={{ padding: 0 }}>
      {rows.map((r) => (
        <div key={r.id} className="row" style={{ padding: "14px 18px", borderBottom: "1px solid var(--n100)", alignItems: "flex-start" }}>
          <span style={{ marginTop: 1 }}>
            {r.result.state === "run" && <Loader2 size={18} className="spin faint" />}
            {r.result.state === "ok" && <CheckCircle2 size={18} color="var(--ok)" />}
            {r.result.state === "warn" && <CircleAlert size={18} color="var(--warn)" />}
            {r.result.state === "err" && <CircleAlert size={18} color="var(--err)" />}
          </span>
          <div className="grow">
            <b style={{ fontWeight: 500 }}>{r.label}</b>
            <div className="faint" style={{ fontSize: 12.5, wordBreak: "break-all" }}>{r.result.detail || "Checking…"}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
