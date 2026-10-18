import { expect, type Page } from "@playwright/test";

export const MANAGER = { email: "muhammad.rafay@demo.com", password: "demo-password-1" };
export const JUDGE = { email: "judge@demo.com", password: "judge-password-1" };

/** Next's development overlay ("1 Insight") floats over the phone tab bar and eats taps. It does not exist in production. */
async function hideDevOverlay(page: Page) {
  await page.addInitScript(() => {
    const hide = () => { const st = document.createElement("style"); st.textContent = "nextjs-portal{display:none!important}"; document.head.appendChild(st); };
    if (document.head) hide(); else document.addEventListener("DOMContentLoaded", hide);
  });
}

export async function signIn(page: Page, who: { email: string; password: string } = MANAGER) {
  await hideDevOverlay(page);
  await page.goto("/login");
  await page.getByLabel("Work email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

export async function signInAndWait(page: Page, who = MANAGER) {
  await signIn(page, who);
  await expect(page).toHaveURL(who.email === JUDGE.email ? /\/try/ : /\/inbox/);
}

/**
 * Goes to a screen by its route, using whatever navigation the screen size has:
 * the sidebar on a wide window, the tab bar on a phone, or the "More" sheet for the rest.
 */
export async function nav(page: Page, href: string) {
  const side = page.locator(`.side a[href="${href}"]`);
  if (await side.isVisible()) {
    await side.click();
  } else {
    const tab = page.locator(`.tabbar a[href="${href}"]`);
    if (await tab.count()) await tab.click();
    else {
      await page.getByRole("button", { name: "More" }).click();
      await page.locator(`.more a[href="${href}"]`).click();
    }
  }
  await expect(page).toHaveURL(new RegExp(`${href.replace(/\//g, "\\/")}(\\?.*)?$`));
}

/** True when the page scrolls sideways, which on a phone means something does not fit. */
export async function overflowsHorizontally(page: Page): Promise<{ over: boolean; scrollWidth: number; innerWidth: number }> {
  return page.evaluate(() => ({
    over: document.documentElement.scrollWidth > window.innerWidth + 1 || document.body.scrollWidth > window.innerWidth + 1,
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    innerWidth: window.innerWidth,
  }));
}

/** The inbox filter tabs (All, Mine, Human, Fraud, Resolved). Scoped, because conversation rows can also say "Resolved". */
export const inboxTab = (page: Page, name: string) => page.locator(".list-head .tab", { hasText: name });

/**
 * Puts the sample data back (conversations, drafts, comments), the way the Demo screen's reset does,
 * so each test starts from the same state no matter what the one before it consumed.
 */
export async function resetDemoData() {
  const r = await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=x", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: MANAGER.email, password: MANAGER.password, returnSecureToken: true }),
  });
  const { idToken } = (await r.json()) as { idToken: string };
  const f = await fetch("http://127.0.0.1:5001/demo-hugin/us-central1/resetDemo", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` }, body: JSON.stringify({ data: {} }),
  });
  if (!f.ok) throw new Error(`could not reset the sample data: ${f.status} ${await f.text()}`);
}
