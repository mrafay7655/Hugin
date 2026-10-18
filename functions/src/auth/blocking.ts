import { HttpsError } from "firebase-functions/v2/https";
import { beforeUserCreated, beforeUserSignedIn } from "firebase-functions/v2/identity";
import { logger } from "firebase-functions";
import { getFirestore } from "firebase-admin/firestore";
import { evaluateAccess, type OrgAccess } from "./authorize";
import { ORG_ID, REGION } from "../runtime";
import { org } from "../lib/paths";

async function loadAccess(orgId: string): Promise<OrgAccess | null> {
  const db = getFirestore();
  const snap = await org(db, orgId).get();
  if (!snap.exists) return null;
  const invites = await org(db, orgId).collection("invites").get();
  return {
    allowedDomains: (snap.data()?.allowedDomains as string[] | undefined) ?? [],
    invites: invites.docs.map((d) => d.id),
    judges: invites.docs.filter((d) => d.data().role === "judge").map((d) => d.id),
  };
}

async function authorize(email: string | undefined, verified: boolean | undefined) {
  const orgId = ORG_ID.value();
  const access = await loadAccess(orgId);
  if (!access) throw new HttpsError("failed-precondition", "This workspace is not set up yet.");
  const decision = evaluateAccess(email, verified, access);
  if (!decision.allowed) {
    logger.warn("sign-in refused", { email, reason: decision.reason });
    // Deliberately vague to the caller; the reason is in the logs.
    throw new HttpsError("permission-denied", "This email is not approved for this workspace. Ask your administrator for access.");
  }
  return { orgId, reason: decision.reason, role: decision.role ?? "manager" };
}

/** Public sign-up is disabled: an account can only be created for an approved domain or an invite. */
export const authBeforeCreate = beforeUserCreated({ region: REGION }, async (event) => {
  const u = event.data;
  if (!u) throw new HttpsError("invalid-argument", "Missing user");
  const { orgId, role } = await authorize(u.email, u.emailVerified);
  return { customClaims: { orgId, role } };
});

/** Re-checked on every sign-in, so removing a domain or invite takes effect immediately. */
export const authBeforeSignIn = beforeUserSignedIn({ region: REGION }, async (event) => {
  const u = event.data;
  if (!u) throw new HttpsError("invalid-argument", "Missing user");
  const { orgId, role } = await authorize(u.email, u.emailVerified);
  const db = getFirestore();
  // revoked: false clears a past removal, so a person who is approved again can sign back in.
  await org(db, orgId).collection("members").doc(u.uid).set({ email: u.email, name: u.displayName ?? u.email, role, revoked: false, lastSignIn: Date.now() }, { merge: true });
  return { sessionClaims: { orgId, role } };
});
