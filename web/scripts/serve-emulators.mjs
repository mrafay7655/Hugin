// Builds the app for the local Firebase emulators (project demo-hugin) and serves it on port 3001.
// Used by the browser tests when a `next dev` server is already running in this folder (only one is allowed).
import { spawnSync, spawn } from "node:child_process";

const env = { ...process.env, NEXT_PUBLIC_USE_EMULATORS: "true", NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-hugin", NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "demo-hugin.firebaseapp.com" };
const port = process.env.PORT ?? "3001";
const build = spawnSync("npx", ["next", "build"], { env, stdio: "inherit", shell: true });
if (build.status !== 0) process.exit(build.status ?? 1);
spawn("npx", ["next", "start", "-p", port], { env, stdio: "inherit", shell: true }).on("exit", (c) => process.exit(c ?? 0));
