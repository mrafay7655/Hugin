// Checks, and with --apply fixes, the live project's sign-in lockdown. Read-only unless you pass --apply.
//
//   node scripts/lock-auth.mjs            show what is configured and what would change
//   node scripts/lock-auth.mjs --apply    switch off self-service sign-up
//
// What it checks on the Identity Platform config of the project:
//  1. Self-service sign-up is OFF (client.permissions.disabledUserSignup). Accounts are created by an administrator only.
//  2. The sign-in blocking functions are REGISTERED (authBeforeCreate, authBeforeSignIn). They are registered by
//     `firebase deploy --only functions`, not by this script, so this only reports whether they are there.
// Needs application-default credentials:  gcloud auth application-default login
import { createRequire } from "node:module";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const { initializeApp, applicationDefault } = require("firebase-admin/app");

const PROJECT = process.env.GCLOUD_PROJECT ?? "hugin-b1ff5";
const APPLY = process.argv.includes("--apply");
const BASE = `https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/config`;

const app = initializeApp({ credential: applicationDefault(), projectId: PROJECT });
const token = (await app.options.credential.getAccessToken()).access_token;
const headers = { Authorization: `Bearer ${token}`, "x-goog-user-project": PROJECT, "content-type": "application/json" };

const get = async () => {
  const r = await fetch(BASE, { headers });
  if (!r.ok) throw new Error(`could not read the config: ${r.status} ${await r.text()}`);
  return r.json();
};

const show = (c) => {
  const signUpOff = c.client?.permissions?.disabledUserSignup === true;
  const triggers = c.blockingFunctions?.triggers ?? {};
  const registered = Object.keys(triggers);
  console.log(`project ${PROJECT}`);
  console.log(`  self-service sign-up:        ${signUpOff ? "OFF (good)" : "ON  (anyone can create an account)"}`);
  console.log(`  blocking functions:          ${registered.length ? registered.join(", ") : "NONE registered"}`);
  console.log(`  email/password sign-in:      ${c.signIn?.email?.enabled ? "enabled" : "disabled"}`);
  return { signUpOff, registered };
};

const before = show(await get());
const notes = [];
if (!before.signUpOff) notes.push("self-service sign-up is on");
if (!before.registered.includes("beforeCreate") || !before.registered.includes("beforeSignIn")) notes.push("the blocking functions are not registered: run `firebase deploy --only functions` (the project must be on Identity Platform)");

if (!APPLY) {
  console.log(notes.length ? `\nProblems: ${notes.join("; ")}.\nRun with --apply to switch off sign-up.` : "\nNothing to change.");
  process.exit(0);
}

if (!before.signUpOff) {
  const r = await fetch(`${BASE}?updateMask=client.permissions.disabledUserSignup`, { method: "PATCH", headers, body: JSON.stringify({ client: { permissions: { disabledUserSignup: true } } }) });
  if (!r.ok) throw new Error(`could not switch off sign-up: ${r.status} ${await r.text()}`);
  console.log("\nSwitched off self-service sign-up.");
}
show(await get());
if (notes.some((n) => n.startsWith("the blocking"))) console.log("\nStill to do: deploy the functions so the blocking functions get registered.");
