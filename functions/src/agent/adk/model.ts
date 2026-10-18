import { Gemini, type BaseLlm } from "@google/adk";
import type { AdkConfig } from "./config";

const cache = new Map<string, BaseLlm>();

/**
 * The Gemini model, served through Vertex AI using the function's service account (no API key).
 * One client per configuration, reused across messages: building a new one each time repeats the
 * connection and credential setup, which costs seconds on every message.
 */
export function vertexModel(cfg: AdkConfig): BaseLlm {
  const key = `${cfg.project}|${cfg.location}|${cfg.model}`;
  let m = cache.get(key);
  if (!m) {
    m = new Gemini({ model: cfg.model, vertexai: true, project: cfg.project, location: cfg.location });
    cache.set(key, m);
  }
  return m;
}

/**
 * Makes the first real message fast: opens the credentials and the connection to Vertex AI with a
 * one-token call, so the 5 to 9 s of first-use setup is paid when an instance starts, not by a customer.
 * Never throws; a failed warm-up only means the first message pays the cost as before.
 */
export async function prewarmGemini(cfg: AdkConfig): Promise<void> {
  try {
    vertexModel(cfg);
    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ vertexai: true, project: cfg.project, location: cfg.location });
    await ai.models.generateContent({ model: cfg.model, contents: "ok", config: { maxOutputTokens: 1, thinkingConfig: { thinkingBudget: 0 } } });
  } catch {
    /* best effort */
  }
}
