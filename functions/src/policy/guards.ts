/**
 * Output guards. These run in code on every outbound message, so the rules hold even
 * if a prompt is manipulated. Customer text is data, never instructions.
 *
 * Three layers: the text is normalised first (so "P I N", "ＰＩＮ" and "p1n" are read as PIN),
 * then checked for a request for a secret, a promise of money back, and a link to a site
 * that is not the bank's. Statements that tell people to PROTECT a secret ("we never ask for
 * your PIN") are allowed.
 */
import { checkDomain } from "./domain";

const ZERO_WIDTH = /[​-‏⁠﻿]/g;

/** Lower-cases and removes the usual ways of disguising a word. For matching only, never for display. */
export function normalizeForGuard(text: string): string {
  let t = text.normalize("NFKC").replace(ZERO_WIDTH, "").toLowerCase();
  // Spelled-out letters: "p i n", "o.t.p", "c-v-v".
  t = t.replace(/\b(?:[a-z][\s.\-_]){2,}[a-z]\b/g, (m) => m.replace(/[\s.\-_]/g, ""));
  // Look-alike digits inside a word: "p1n", "0tp", "c0de". Plain numbers are left alone.
  t = t.replace(/[a-z0-9@$]+/g, (w) => (/[a-z]/.test(w) && /[0-9@$]/.test(w) && w.length <= 14 ? w.replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e").replace(/4/g, "a").replace(/5/g, "s").replace(/@/g, "a").replace(/\$/g, "s") : w));
  // Chat shorthand.
  return t.replace(/\bur\b/g, "your").replace(/\bu\b/g, "you").replace(/\b(?:pls|plz)\b/g, "please");
}

// Things nobody should ever be asked for in a chat with a bank.
const SECRET = String.raw`(?:otp|one[\s-]?time[\s-]?(?:code|passcode|password|pass|pin|token)|(?:verification|security|authentication|auth|login|sign[\s-]?in|confirmation|access|sms|text|2fa|two[\s-]?factor|\d+[\s-]?digit|(?:four|five|six|seven|eight)[\s-]?digit)[\s-]?(?:code|pin|number|passcode)|pin|passcode|password|passwd|cvv2?|cvc2?|card\s+(?:number|details|info(?:rmation)?|expir\w*|pin)|ssn|social\s+security(?:\s+number)?|account\s+(?:number|login|credentials|password)|routing\s+number|(?:online\s+banking\s+|login\s+)?credentials|mother'?s\s+maiden\s+name|security\s+(?:question|answer)|secret\s+(?:answer|word|phrase)|last\s+(?:4|four)\s+digits|expiry\s+date)s?`;
// "the code you just received", "the code we texted": a code without a name, but clearly a secret one.
const CODE_BY_CONTEXT = String.raw`codes?(?=\s+(?:you|we|that|just|sent|texted|emailed|received))`;
const VERBS = String.raw`(?:share|send|give|provide|tell|reply(?:\s+with)?|respond\s+with|text|enter|type|input|key\s+in|submit|confirm|verify|read(?:\s+out)?|forward|dm|message|supply|state|say|speak|need|require|want|ask(?:\s+you)?(?:\s+for)?|let\s+(?:me|us)\s+know|what(?:'?s|\s+is|\s+are|\s+was)|(?:may|can|could)\s+i\s+(?:have|get)|i'?ll\s+need|give\s+me|get\s+me)`;
const REQUEST_SECRET = new RegExp(String.raw`\b${VERBS}\b[^.?!\n;]{0,60}?\b(?:${SECRET}|${CODE_BY_CONTEXT})\b`, "g");

const PROMISES: RegExp[] = [
  /\b(?:we|i)(?:\s+(?:will|shall|can|are\s+going\s+to|am\s+going\s+to)|'ll|'re|\s+are|\s+am|'m)?\s+(?:refund(?:ing)?|reimburs\w+|revers(?:e|ing)|credit(?:ing)?|pay(?:ing)?\s+(?:you\s+)?back|return(?:ing)?\s+(?:your|the)\s+(?:money|funds|fee|charge))\b/g,
  /\b(?:refund|reimbursement|reversal|credit)\s+(?:has\s+(?:now\s+)?been|is|was|will\s+be)\s+(?:processed|approved|issued|completed|sent|on\s+its\s+way|applied|granted)/g,
  /\byou(?:'ll|\s+will|'re\s+going\s+to)\s+(?:get|receive|have|be\s+refunded|be\s+reimbursed)\b[^.?!\n]{0,25}\b(?:money|funds|fee|charge|refund|payment)\b/g,
  /\b(?:money|funds)\s+back\b/g,
  /\bguarantee\w*\s+(?:a\s+)?(?:refund|reimbursement)/g,
];

const NEG = /\b(?:never|don'?t|do\s+not|doesn'?t|does\s+not|won'?t|will\s+not|wouldn'?t|would\s+not|can'?t|cannot|can\s+not|not|no\s+one|nobody|without|refuse\s+to)\b/g;
/** Words that end the protective clause: "not sure, but please send…" is not a negation. */
const CLAUSE_BREAK = /[,:]|\b(?:but|however|now|so|just|please|then)\b/;

/** True when the match is inside a protective statement like "we never ask you to share your PIN". */
function negated(text: string, at: number): boolean {
  const seg = text.slice(0, at).split(/[.?!;\n]/).pop() ?? "";
  const tail = seg.slice(-45);
  let last: RegExpMatchArray | undefined;
  for (const m of tail.matchAll(NEG)) {
    if (tail.slice((m.index ?? 0) + m[0].length).startsWith(" mind")) continue; // "never mind"
    last = m;
  }
  if (!last || last.index === undefined) return false;
  return !CLAUSE_BREAK.test(tail.slice(last.index + last[0].length));
}

function hasUnnegated(text: string, re: RegExp): boolean {
  const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = r.exec(text)) !== null) {
    if (!negated(text, m.index)) return true;
    if (m[0].length === 0) r.lastIndex++;
  }
  return false;
}

const TLDS = "com|net|org|co|io|app|us|info|xyz|top|click|link|online|site|bank|biz|gov|edu|me|ly|to|cc|ru|cn|tk|ml|ga|cf|gq|support|help|live|shop|store|tech|dev|page|cloud|email|ws|vip|club|pw|uk|in|pk";
const LINK = new RegExp(String.raw`\b(?:https?:\/\/)?((?:[a-z0-9][a-z0-9-]*\.)+(?:${TLDS}))\b(?:[/:?#]\S*)?`, "gi");

export interface GuardResult {
  ok: boolean;
  violations: string[];
}

export interface GuardOptions {
  /** A person may promise a refund they have the authority to give. The agent never may. */
  allowRefundLanguage?: boolean;
  /** The bank's own domains. When given, links are checked against them. */
  officialDomains?: string[];
  /** "official-only": every link must be ours (the agent). "no-lookalikes": other sites are fine, imitations are not (a person). */
  linkPolicy?: "official-only" | "no-lookalikes";
  /** Domains the message is warning about ("ravenw00d-verify.com is not ours"). Quoting them is allowed. */
  allowWarnedDomains?: string[];
}

/** Checks an outbound message against the "agent will never" rules. */
export function checkOutbound(text: string, opts: GuardOptions = {}): GuardResult {
  const t = normalizeForGuard(text);
  const violations: string[] = [];
  if (hasUnnegated(t, REQUEST_SECRET)) violations.push("asks for a one-time code, PIN, password or card or account details");
  if (!opts.allowRefundLanguage && PROMISES.some((p) => hasUnnegated(t, p))) violations.push("promises a refund");

  if (opts.officialDomains?.length) {
    const seen = new Set<string>();
    for (const m of text.normalize("NFKC").matchAll(LINK)) {
      const d = m[1].toLowerCase();
      if (seen.has(d) || opts.allowWarnedDomains?.some((w) => w.toLowerCase() === d)) continue;
      seen.add(d);
      const v = checkDomain(d, opts.officialDomains).verdict;
      if (v === "lookalike") violations.push(`links to ${d}, which imitates the bank's site`);
      else if (v === "unrelated" && (opts.linkPolicy ?? "official-only") === "official-only") violations.push(`links to ${d}, which is not the bank's site`);
    }
  }
  return { ok: violations.length === 0, violations };
}

/** WhatsApp free-form replies are allowed for 24 hours after the customer's last message. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;
export function windowOpen(lastCustomerMessageAt: number | null | undefined, now = Date.now()): boolean {
  return typeof lastCustomerMessageAt === "number" && now - lastCustomerMessageAt < WINDOW_MS;
}
