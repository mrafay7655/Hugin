// One-time setup of the LIVE project: demo data, who may sign in, and the manager and judge accounts.
// Sign-in is refused until the org document exists, so run this once before the first login.
//
// Needs Google application-default credentials:  gcloud auth application-default login
// Run from the hugin folder, after `npm run build` in functions:
//   MANAGER_PASSWORD='<choose one>' JUDGE_PASSWORD='<a different one>' OWNER_EMAIL='you@gmail.com' node scripts/prod-seed.mjs
// Safe to run again: the seed is idempotent. Existing accounts keep their password unless you pass ROTATE_PASSWORDS=1.
//
// Access model:
//  - Nobody signs in through an approved DOMAIN here. "demo.com" is a real domain somebody else owns, so it is not approved.
//    Every person is an explicit INVITE with a role.
//  - manager: can change anything.   judge: can read everything and use the demo tools on simulated data only.
import { createRequire } from "node:module";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { seedDemoData } = require("../functions/lib/seed/demo.js");

const PROJECT = process.env.GCLOUD_PROJECT ?? "hugin-b1ff5";
const ORG = process.env.ORG_ID ?? "ravenwood";
const OWNER_EMAIL = process.env.OWNER_EMAIL?.trim().toLowerCase();
const ROTATE = process.env.ROTATE_PASSWORDS === "1";
const APPROVED_DOMAINS = ["ravenwoodbank.com"]; // a fictional bank: nobody can receive mail there, so nobody gets in by domain

const MANAGER = { email: "muhammad.rafay@demo.com", password: process.env.MANAGER_PASSWORD, displayName: "Muhammad Rafay", role: "manager" };
const JUDGE = { email: "judge@demo.com", password: process.env.JUDGE_PASSWORD, displayName: "Hackathon Judge", role: "judge" };

if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error("Emulator variables are set. This script is for the live project; use dev-seed.mjs for emulators.");
}
for (const u of [MANAGER, JUDGE]) {
  if (!u.password || u.password.length < 12) throw new Error(`Set ${u.role === "judge" ? "JUDGE_PASSWORD" : "MANAGER_PASSWORD"} (at least 12 characters).`);
}
if (MANAGER.password === JUDGE.password) throw new Error("The manager and the judge must have different passwords.");

initializeApp({ credential: applicationDefault(), projectId: PROJECT });
const db = getFirestore();
const auth = getAuth();

const out = await seedDemoData({ db, orgId: ORG, now: () => Date.now(), adk: null, log: () => {} }, { allowedDomains: APPROVED_DOMAINS });

// An org that already exists keeps its settings when the demo is re-seeded, so fix the approved domains explicitly.
await db.doc(`orgs/${ORG}`).update({ allowedDomains: APPROVED_DOMAINS });

// Everyone who can sign in is an explicit invite with a role. Existing invites for other people are left alone.
const invites = [{ email: MANAGER.email, role: "manager" }, { email: JUDGE.email, role: "judge" }, ...(OWNER_EMAIL ? [{ email: OWNER_EMAIL, role: "manager" }] : [])];
for (const i of invites) await db.doc(`orgs/${ORG}/invites/${i.email}`).set({ by: "prod-seed", at: Date.now(), role: i.role });

// Admin-created accounts count as verified. The claims are also set here so the dashboard works even if the sign-in
// blocking functions are not registered with Identity Platform (they set the same claims on every sign-in once they are).
for (const u of [MANAGER, JUDGE]) {
  let uid;
  try {
    uid = (await auth.createUser({ email: u.email, password: u.password, displayName: u.displayName, emailVerified: true })).uid;
    console.log(`created ${u.email} (${u.role})`);
  } catch (e) {
    if (e.code !== "auth/email-already-exists") throw e;
    uid = (await auth.getUserByEmail(u.email)).uid;
    if (ROTATE) {
      await auth.updateUser(uid, { password: u.password });
      console.log(`${u.email} already exists: password rotated`);
    } else console.log(`${u.email} already exists (password unchanged)`);
  }
  await auth.setCustomUserClaims(uid, { orgId: ORG, role: u.role });
  // A role change or a rotated password must not leave old sessions alive.
  if (ROTATE) await auth.revokeRefreshTokens(uid);
  await db.doc(`orgs/${ORG}/members/${uid}`).set({ email: u.email, name: u.displayName, role: u.role, revoked: false }, { merge: true });
}

console.log(`seeded ${PROJECT}/${ORG}: ${JSON.stringify(out)}; approved domains ${APPROVED_DOMAINS.join(", ")}; invited ${invites.map((i) => `${i.email} (${i.role})`).join(", ")}`);
