"use client";

import { useEffect, useState } from "react";
import {
  collection,
  doc,
  limit as qLimit,
  onSnapshot,
  orderBy,
  query,
  updateDoc,
  type QueryConstraint,
} from "firebase/firestore";
import { FunctionsError, httpsCallable } from "firebase/functions";
import { firebase } from "./firebase/client";
import { useSession } from "./auth";
import type { WithId } from "./types";

interface Live<T> {
  data: T;
  loading: boolean;
  error: string | null;
}

/** Live collection under orgs/{orgId}/{path}. Pass null to skip. */
export function useCollection<T>(path: string | null, opts: { order?: [string, "asc" | "desc"]; limit?: number } = {}): Live<WithId<T>[]> {
  const { orgId } = useSession();
  const [state, setState] = useState<Live<WithId<T>[]>>({ data: [], loading: true, error: null });
  const key = `${orgId}/${path}/${opts.order?.join(":")}/${opts.limit}`;
  useEffect(() => {
    if (!path) return;
    const cons: QueryConstraint[] = [];
    if (opts.order) cons.push(orderBy(opts.order[0], opts.order[1]));
    if (opts.limit) cons.push(qLimit(opts.limit));
    const q = query(collection(firebase().db, "orgs", orgId, ...path.split("/")), ...cons);
    return onSnapshot(
      q,
      (snap) => setState({ data: snap.docs.map((d) => ({ id: d.id, ...(d.data() as T) })), loading: false, error: null }),
      (e) => setState({ data: [], loading: false, error: e.message }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return path ? state : { data: [], loading: false, error: null };
}

/** Live document at orgs/{orgId}/{path}, or the org itself when path is "". */
export function useDoc<T>(path: string | null): Live<WithId<T> | null> {
  const { orgId } = useSession();
  const [state, setState] = useState<Live<WithId<T> | null>>({ data: null, loading: true, error: null });
  useEffect(() => {
    if (path === null) return;
    const ref = path ? doc(firebase().db, "orgs", orgId, ...path.split("/")) : doc(firebase().db, "orgs", orgId);
    return onSnapshot(
      ref,
      (s) => setState({ data: s.exists() ? { id: s.id, ...(s.data() as T) } : null, loading: false, error: null }),
      (e) => setState({ data: null, loading: false, error: e.message }),
    );
  }, [orgId, path]);
  return state;
}

/** The one client write the rules allow. */
export async function markRead(orgId: string, convId: string) {
  await updateDoc(doc(firebase().db, "orgs", orgId, "conversations", convId), { unread: false }).catch(() => {});
}

/** Calls a manager Cloud Function. Errors come back as readable messages. */
export async function call<T = unknown>(name: string, data: Record<string, unknown> = {}): Promise<T> {
  try {
    const r = await httpsCallable(firebase().functions, name)(data);
    return r.data as T;
  } catch (e) {
    if (e instanceof FunctionsError) throw new Error(e.message.replace(/\s*\[\d{3}\]$/, "")); // drop a trailing HTTP status
    throw e;
  }
}
