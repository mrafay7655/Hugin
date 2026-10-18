import { defineConfig, devices } from "@playwright/test";

// Run from hugin/:  firebase emulators:exec --only auth,functions,firestore --project demo-hugin "node scripts/dev-seed.mjs && cd web && npx playwright test"
// Needs the Firebase emulators (auth, functions, firestore) seeded by scripts/dev-seed.mjs.
//
// Two projects run the same app: a desktop window, and a phone (390 x 844, touch). The phone tests are the
// mobile-first checks: navigation, no sideways scrolling, finger-sized controls, and the screens that become sheets.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:3001", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    // Screenshots for the landing page. Only when asked for: PW_SHOTS=1 (see design/landing).
    ...(process.env.PW_SHOTS ? [{ name: "shots", testMatch: /shots\.spec\.ts/, timeout: 600_000 }] : []),
    { name: "desktop", testMatch: /app\.spec\.ts/, use: { viewport: { width: 1440, height: 900 } } },
    {
      name: "phone",
      testMatch: /mobile\.spec\.ts/,
      // The phone profile's viewport, touch and user agent, but in the Chromium that is installed here.
      use: { ...devices["iPhone 14"], defaultBrowserType: "chromium" },
    },
  ],
  // PW_SERVE=build tests a production build instead of `next dev` (needed when a dev server is already running here).
  webServer: {
    command: process.env.PW_SERVE === "build" ? "node scripts/serve-emulators.mjs" : "node scripts/dev-emulators.mjs",
    url: "http://localhost:3001/login",
    reuseExistingServer: true,
    timeout: 400_000,
  },
});
