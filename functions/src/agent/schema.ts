import { z } from "zod";
import type { Intent, Sentiment } from "../types";

export const INTENTS: Intent[] = [
  "otp_scam_report", "phishing_check", "phishing_compromised", "phishing_safe", "fraud_report", "card_lost", "account_change",
  "complaint", "refund", "fee_inquiry", "wire_timing", "fx_rate", "balance", "card_activation", "greeting", "knowledge_question", "unknown",
];
export const SENTIMENTS: Sentiment[] = ["positive", "neutral", "worried", "anxious", "angry", "relieved"];

/** The structured output the classifier agent must return. */
export const ClassificationSchema = z.object({
  intent: z.enum(INTENTS as [Intent, ...Intent[]]).describe("The customer's primary intent"),
  sentiment: z.enum(SENTIMENTS as [Sentiment, ...Sentiment[]]).describe("The customer's emotional state"),
  language: z.string().describe("ISO language code of the customer's message, e.g. en"),
  confidence: z.number().min(0).max(1).describe("How sure you are about the intent, 0 to 1"),
  transcript: z.string().describe("Transcript of a voice note, or visible text of a screenshot. Empty if neither").default(""),
  urls: z.array(z.string()).describe("URLs or domains mentioned or visible").default([]),
});

export type Classification = z.infer<typeof ClassificationSchema>;
