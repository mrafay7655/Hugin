/** Lookalike-domain detection for phishing links. Pure, no network. */

const CONFUSABLES: Record<string, string> = { "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", $: "s" };

export interface DomainVerdict {
  domain: string;
  verdict: "official" | "lookalike" | "unrelated";
  reason: string;
}

export function extractDomains(text: string): string[] {
  const re = /\b((?:[a-z0-9-]+\.)+(?:com|co|net|org|info|xyz|io|app|us|top|click|link|online|site|bank))(?:[/:?#]\S*)?/gi;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) found.add(m[1].toLowerCase());
  return [...found];
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[0134578@$]/g, (c) => CONFUSABLES[c] ?? c)
    .replace(/[^a-z]/g, "");
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

/**
 * Compares a domain to the official one(s). Exact registrable-domain match (including
 * subdomains of it) is official. A near match after de-obfuscating digits is a lookalike.
 */
export function checkDomain(domain: string, official: string[]): DomainVerdict {
  const d = domain.toLowerCase().replace(/^www\./, "");
  for (const o of official) {
    if (d === o || d.endsWith("." + o)) return { domain: d, verdict: "official", reason: `Matches ${o}` };
  }
  const label = d.split(".").slice(0, -1).join("");
  const n = normalize(label);
  for (const o of official) {
    const t = normalize(o.split(".").slice(0, -1).join(""));
    // The brand is the name without a generic suffix ("ravenwoodbank" -> "ravenwood").
    const brand = t.length > 8 && t.endsWith("bank") ? t.slice(0, -4) : t;
    // Contains the brand, or is within two edits of the full name.
    if (n.includes(brand) || levenshtein(n, t) <= 2) {
      return { domain: d, verdict: "lookalike", reason: `Looks like ${o} but is not it` };
    }
  }
  return { domain: d, verdict: "unrelated", reason: "Not an official domain" };
}
