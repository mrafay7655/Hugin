// Mirrors functions/src/lib/model.ts and functions/src/comments/ingest.ts. Keep in sync.

export type Channel = "whatsapp" | "instagram" | "facebook" | "x" | "tiktok" | "telegram" | "webchat";
/** Where a conversation or comment came from: seeded sample data, the demo tools or web chat, or a real channel. */
export type Origin = "sample" | "simulated" | "live";
export type DecisionLabel = "auto_resolved" | "draft_ready" | "needs_human" | "fraud_risk" | "phishing" | "no_source" | "resolved" | "human";
export type ConvStatus = "open" | "needs_human" | "fraud" | "resolved";
export type WithId<T> = T & { id: string };

export interface Customer {
  name: string;
  initials: string;
  color: [string, string];
  phoneMasked: string;
  handle?: string;
  tier: string;
  since: number;
  city: string;
  language: string;
  csat: number;
  churn: "Low" | "Medium" | "High";
  segment: string;
  traits: string[];
  summary: string;
  sample?: boolean;
}

export interface Conversation {
  customerId: string;
  channel: Channel;
  transport: "whatsapp" | "telegram" | "sim";
  status: ConvStatus;
  decision: DecisionLabel;
  intent: string;
  unread: boolean;
  thinking: boolean;
  mode: "agent" | "human";
  lastAt: number;
  lastPreview: string;
  lastKind: "text" | "voice" | "image";
  lastCustomerMessageAt: number | null;
  assignee?: string | null;
  caseId?: string | null;
  approval?: { draft: string; reason: string; createdAt: number } | null;
  sample?: boolean;
  origin?: Origin;
}

export interface Message {
  dir: "in" | "out";
  author: "customer" | "ai" | "human" | "system";
  authorName?: string;
  kind: "text" | "voice" | "image";
  text: string;
  voiceSecs?: number;
  imageText?: string;
  transcript?: string;
  buttons?: string[];
  cite?: { doc: string; section: string };
  at: number;
  status: "received" | "sent" | "delivered" | "read" | "failed";
  error?: string;
}

export interface TraceStep {
  label: string;
  detail: string;
  tone?: "ok" | "warn";
}

export interface AdkTrace {
  model: string;
  agents: string[];
  toolCalls: { name: string; args: string; result: string }[];
  modelReading: { intent: string; sentiment: string; confidence: number } | null;
  rulesReading: { intent: string; sentiment: string; confidence: number };
  overridden: boolean;
  modelError: string | null;
  understandMs: number;
}

export interface Trace {
  afterMsg: string;
  intent: string;
  sentiment: string;
  confidence: number;
  policyId: string;
  policy: string;
  action: string;
  summary: string;
  steps: TraceStep[];
  tools: string[];
  source: "gemini" | "heuristic";
  latencyMs: number;
  at: number;
  adk?: AdkTrace;
}

export type CommentPlatform = "instagram" | "facebook" | "youtube" | "x" | "tiktok";
export type CommentSentiment = "positive" | "neutral" | "negative" | "mixed";

export interface Comment {
  platform: CommentPlatform;
  externalId: string;
  postId: string;
  postLabel: string;
  author: string;
  text: string;
  at: number;
  sentiment: CommentSentiment;
  score: number;
  emotion: string;
  topic: string;
  intent: string;
  sarcasm: boolean;
  toxicity: number;
  needsReply: boolean;
  riskFlag: boolean;
  riskReason: string;
  /** Links and domains found in the comment. */
  urls?: string[];
  source: "gemini" | "heuristic";
  status: "new" | "handled" | "hidden";
  draft: string | null;
  draftCite: { doc: string; section: string } | null;
  suggestHide: boolean;
  sample: boolean;
  origin?: Origin;
  reply?: { text: string; by: string; at: number } | null;
}

export interface Post {
  platform: CommentPlatform;
  /** What the post is for, set by a manager or the seed. Missing means Uncategorised. */
  campaign?: string;
  postId: string;
  label: string;
  total: number;
  positive?: number;
  neutral?: number;
  negative?: number;
  mixed?: number;
  needsReply?: number;
  risk?: number;
  scoreSum: number;
  lastAt?: number;
}

export interface KbDoc {
  title: string;
  status: "active" | "retired";
  updated?: number;
  sections: { id: string; title: string; text: string }[];
}

export interface Policy {
  autoSend: number;
  draft: number;
  alwaysHuman: string[];
  perIntent: Record<string, number>;
  blocked: string[];
}

export interface AuditEntry {
  at: number;
  actor: string;
  action: string;
  detail: string;
  value: string | null;
}

export interface Alert {
  at: number;
  tone: "ok" | "err" | "info";
  text: string;
  sub: string | null;
}

export interface Org {
  name: string;
  allowedDomains: string[];
  officialDomains: string[];
  demoMode: boolean;
}

/** One agent's health record (orgs/{org}/health/{agent}). */
export interface AgentHealth {
  agent: string;
  lastOkAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  lastDetail?: string;
  okCount?: number;
  errorCount?: number;
}

/** One day's operating counters (orgs/{org}/metrics/{YYYY-MM-DD}). Missing counters are zero. */
export interface DayMetrics {
  day: string;
  runs?: number;
  runsLive?: number;
  runsSimulated?: number;
  action?: Record<string, number>;
  policy?: Record<string, number>;
  understoodByGemini?: number;
  understoodByRules?: number;
  modelErrors?: number;
  rulesOverrodeModel?: number;
  agentErrors?: number;
  latencyMsSum?: number;
  understandMsSum?: number;
  repliesSent?: number;
  firstReplyMsSum?: number;
  draftsQueued?: number;
  draftsApproved?: number;
  casesOpened?: number;
  cardsLocked?: number;
  cardsUnlocked?: number;
  takeOvers?: number;
  mediaRead?: number;
  guardBlocks?: number;
  guardBlocksAgent?: number;
  guardBlocksPeople?: number;
  messagesSent?: number;
  comments?: number;
  commentsLive?: number;
  commentsSimulated?: number;
  commentsByGemini?: number;
  commentsByRules?: number;
  commentsRisky?: number;
  commentModelErrors?: number;
  sent?: Record<string, number>;
  sentByAgent?: number;
  sentByPeople?: number;
  received?: Record<string, number>;
  rejected?: Record<string, number>;
  limited?: Record<string, number>;
  sweptConversations?: number;
}
