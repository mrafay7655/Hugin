// Seeds the running emulators with demo data and local accounts for development.
// Run with the emulators up:  node scripts/dev-seed.mjs
// Or all in one:              firebase emulators:exec --only auth,functions,firestore --project demo-hugin "node scripts/dev-seed.mjs"
import { createRequire } from "node:module";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099";
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { seedDemoData } = require("./lib/seed/demo.js");

const PROJECT = process.env.GCLOUD_PROJECT ?? "demo-hugin";
const ORG = "ravenwood";
const MANAGER = { email: "muhammad.rafay@demo.com", password: "demo-password-1", displayName: "Muhammad Rafay" };
const JUDGE = { email: "judge@demo.com", password: "judge-password-1", displayName: "Hackathon Judge" };
// The outsider exists only to prove that sign-in refuses non-approved domains.
const OUTSIDER = { email: "outsider@gmail.com", password: "outsider-pass-1" };

initializeApp({ projectId: PROJECT });
const db = getFirestore();
const out = await seedDemoData({ db, orgId: ORG, now: () => Date.now(), adk: null, log: () => {} });

// The judge is an explicit invite with the restricted role. (The manager comes in through the approved demo.com domain.)
await db.doc(`orgs/${ORG}/invites/${JUDGE.email}`).set({ by: "dev-seed", at: Date.now(), role: "judge" });

for (const u of [{ ...MANAGER, emailVerified: true }, { ...JUDGE, emailVerified: true }, { ...OUTSIDER, emailVerified: true }]) {
  try {
    await getAuth().createUser(u);
  } catch (e) {
    if (e.code !== "auth/email-already-exists") throw e;
  }
}
console.log(`seeded ${JSON.stringify(out)}; manager ${MANAGER.email} / ${MANAGER.password}; judge ${JUDGE.email} / ${JUDGE.password}`);
