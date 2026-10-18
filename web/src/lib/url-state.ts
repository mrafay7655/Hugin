"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Screen filters live in the URL, so a refresh, the back button and a shared link all keep the screen as it was.
 * `get` returns the default when a key is absent; `set` removes a key when it is set to null, "" or "all".
 * Pages that use this must render inside a Suspense boundary.
 */
export function useQuery() {
  const sp = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const get = (k: string, d = "all") => sp.get(k) ?? d;
  /** `push` adds a history entry, so the browser's back button (a phone's back gesture) undoes the change. */
  const set = (patch: Record<string, string | null>, opts: { push?: boolean } = {}) => {
    // Start from the address bar as it is now, not from the render this closure came from, so two quick changes do not undo each other.
    const n = new URLSearchParams(typeof window === "undefined" ? sp.toString() : window.location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "" || v === "all") n.delete(k);
      else n.set(k, v);
    }
    const qs = n.toString();
    const url = qs ? `${path}?${qs}` : path;
    if (opts.push) router.push(url, { scroll: false });
    else router.replace(url, { scroll: false });
  };
  return { get, set };
}
