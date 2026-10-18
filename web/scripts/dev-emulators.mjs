// Starts Next.js against the local Firebase emulators (project demo-hugin) on port 3001.
import { spawn } from "node:child_process";

const env = { ...process.env, NEXT_PUBLIC_USE_EMULATORS: "true", NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-hugin", NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "demo-hugin.firebaseapp.com" };
const port = process.env.PORT ?? "3001";
spawn("npx", ["next", "dev", "-p", port], { env, stdio: "inherit", shell: true }).on("exit", (c) => process.exit(c ?? 0));
