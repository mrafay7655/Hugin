"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  GoogleAuthProvider,
  onIdTokenChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as fbSignOut,
  type User,
} from "firebase/auth";
import { firebase } from "./firebase/client";

/** A manager can change anything. A judge can look around and try the demo tools on simulated data only. */
export type Role = "manager" | "judge";

export interface Session {
  user: User;
  orgId: string;
  role: Role;
  name: string;
  email: string;
}

/** "denied" carries the email of an account that signed in but is not approved. It was signed straight back out. */
type State = { status: "loading" } | { status: "signed-out"; denied?: string } | { status: "ready"; session: Session };

const Ctx = createContext<State>({ status: "loading" });

/** Tracks the signed-in user and their role claims. Claims are set by the sign-in blocking function. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading" });
  useEffect(() => {
    const { auth } = firebase();
    return onIdTokenChanged(auth, async (user) => {
      // Keep the "not approved" message through the sign-out event that follows it.
      if (!user) return setState((prev) => (prev.status === "signed-out" && prev.denied ? prev : { status: "signed-out" }));
      const { claims } = await user.getIdTokenResult();
      if ((claims.role !== "manager" && claims.role !== "judge") || typeof claims.orgId !== "string") {
        setState({ status: "signed-out", denied: user.email ?? "this account" });
        await fbSignOut(auth);
        return;
      }
      setState({
        status: "ready",
        session: { user, orgId: claims.orgId, role: claims.role, name: user.displayName || user.email || "Manager", email: user.email ?? "" },
      });
    });
  }, []);
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);

/** True for a judge: they can read everything and try the demo tools, but cannot change settings, knowledge or access. */
export const useIsJudge = () => useSession().role === "judge";

/** The session inside the signed-in app. The (app) layout guarantees it exists. */
export function useSession(): Session {
  const s = useContext(Ctx);
  if (s.status !== "ready") throw new Error("useSession used outside the signed-in app");
  return s.session;
}

/** Turns Firebase Auth errors, including blocking-function refusals, into plain sentences. */
export function authErrorMessage(e: unknown): string {
  const code = (e as { code?: string }).code ?? "";
  const msg = (e as { message?: string }).message ?? "";
  if (code.includes("blocking") || msg.includes("BLOCKING_FUNCTION") || code === "auth/internal-error") {
    const m = msg.match(/"message":"([^"]+)"/);
    return m?.[1] ?? "This account is not approved for this workspace. Ask a manager to invite you.";
  }
  if (["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-email"].includes(code)) return "Email or password is incorrect.";
  if (code === "auth/too-many-requests") return "Too many attempts. Wait a minute and try again.";
  if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") return "";
  if (code === "auth/operation-not-allowed") return "This sign-in method is not enabled for the project yet.";
  return "Sign-in failed. Please try again.";
}

export async function signInWithPassword(email: string, password: string) {
  await signInWithEmailAndPassword(firebase().auth, email.trim(), password);
}

export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  await signInWithPopup(firebase().auth, provider);
}

export const signOut = () => fbSignOut(firebase().auth);
