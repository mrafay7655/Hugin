/**
 * Decides whether an email may have an account in an organization.
 * Public sign-up is off: the only way in is an approved domain or an explicit invite.
 */
export interface OrgAccess {
  allowedDomains: string[];
  invites: string[];
  /** Invited addresses that get the restricted judge role instead of manager. */
  judges?: string[];
}

/** A manager can change anything. A judge can read everything and use the demo tools on simulated data only. */
export type Role = "manager" | "judge";

export interface AccessDecision {
  allowed: boolean;
  reason: string;
  role?: Role;
}

/** Consumer mailbox providers. Anyone can register there, so they can never be an approved domain. */
export const PUBLIC_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com", "icloud.com", "me.com",
  "aol.com", "proton.me", "protonmail.com", "gmx.com", "mail.com", "zoho.com", "yandex.com",
]);

/** The domain part of an email, or null if the address is not a single plain user@domain. */
export function domainOf(email: string): string | null {
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  if (e.split("@").length !== 2) return null;
  return e.split("@")[1];
}

export function evaluateAccess(email: string | undefined | null, emailVerified: boolean | undefined, access: OrgAccess): AccessDecision {
  if (!email) return { allowed: false, reason: "No email address on the account" };
  const domain = domainOf(email);
  if (!domain) return { allowed: false, reason: "Not a valid email address" };
  if (!emailVerified) return { allowed: false, reason: "Email address is not verified" };

  const e = email.trim().toLowerCase();
  if (access.invites.map((i) => i.toLowerCase()).includes(e)) {
    const judge = (access.judges ?? []).map((j) => j.toLowerCase()).includes(e);
    return { allowed: true, reason: judge ? "Invited as judge" : "Invited", role: judge ? "judge" : "manager" };
  }
  // Exact match on the whole domain. "demo.com.evil.net" and "evildemo.com" must not pass.
  if (access.allowedDomains.map((d) => d.toLowerCase()).includes(domain)) return { allowed: true, reason: `Approved domain ${domain}`, role: "manager" };
  return { allowed: false, reason: `${domain} is not an approved domain` };
}

/** Validates a domain an admin wants to approve. Public mail providers are refused. */
export function validateAllowedDomain(raw: string): { ok: true; domain: string } | { ok: false; error: string } {
  const d = raw.trim().toLowerCase().replace(/^@/, "");
  if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(d)) return { ok: false, error: "That does not look like a domain, for example demo.com" };
  if (PUBLIC_MAIL_DOMAINS.has(d)) return { ok: false, error: `${d} is a public mail provider. Invite individual addresses instead` };
  return { ok: true, domain: d };
}
