"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { Shell } from "@/components/shell";
import { Loading } from "@/components/ui";

/**
 * Every screen inside the app needs a signed-in manager or judge. An account that signs in without a role
 * (not approved) is signed straight back out and shown why on the login page. Firestore rules enforce the same on the server.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (auth.status === "signed-out") router.replace("/login");
  }, [auth.status, router]);

  if (auth.status === "ready") return <Shell>{children}</Shell>;
  return <div style={{ minHeight: "100dvh", display: "grid" }}><Loading /></div>;
}
