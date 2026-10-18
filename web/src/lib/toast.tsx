"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { ShieldAlert, ShieldCheck, Sparkles } from "lucide-react";

type Tone = "ok" | "err" | "info";
interface Toast { id: number; tone: Tone; text: string; sub?: string }

const Ctx = createContext<(tone: Tone, text: string, sub?: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Tone, text: string, sub?: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, tone, text, sub }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.tone === "err" ? <ShieldAlert size={17} color="#F87171" /> : t.tone === "info" ? <Sparkles size={17} color="var(--a400)" /> : <ShieldCheck size={17} color="#4ADE80" />}
            <div>
              <div style={{ fontWeight: 500 }}>{t.text}</div>
              {t.sub && <div style={{ fontSize: 12, opacity: 0.7 }}>{t.sub}</div>}
            </div>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);

/** Runs a server action and reports the outcome. Returns true on success. */
export function useAction() {
  const toast = useToast();
  return useCallback(
    async (fn: () => Promise<unknown>, ok?: string) => {
      try {
        await fn();
        if (ok) toast("ok", ok);
        return true;
      } catch (e) {
        toast("err", "Not done", (e as Error).message);
        return false;
      }
    },
    [toast],
  );
}
