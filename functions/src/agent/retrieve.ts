import type { Retrieval } from "../types";

export interface KbDoc {
  id: string;
  title: string;
  status: "active" | "retired";
  sections: { id: string; title: string; text: string }[];
}

const STOP = new Set([
  "the", "and", "for", "you", "your", "what", "whats", "how", "does", "can", "are", "is", "do", "to", "of", "a", "an", "in", "on", "it", "my", "me", "much", "i", "with", "this", "that", "have",
]);

export function tokens(q: string): string[] {
  return (q.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w) => !STOP.has(w));
}

const stem = (w: string) => w.replace(/(ing|es|s)$/, "");

/**
 * Keyword retrieval over the approved knowledge base. Only active documents are searched,
 * so a retired document is never cited. This is the fallback implementation of the Retriever
 * interface; the Vertex AI Search implementation plugs in behind the same shape.
 */
export function retrieveFromDocs(query: string, docs: KbDoc[]): Retrieval | null {
  const q = tokens(query);
  if (q.length === 0) return null;
  let best: Retrieval | null = null;
  for (const d of docs) {
    if (d.status !== "active") continue;
    for (const s of d.sections) {
      // The document title counts too: "fee" is only in the title of the Fee Schedule.
      const hay = `${d.title} ${s.title} ${s.text}`.toLowerCase();
      const hits = q.filter((w) => hay.includes(stem(w))).length;
      const overlap = hits / q.length;
      if (overlap === 0) continue;
      // Map word overlap to a 0..1 relevance score. Below ~0.34 overlap there is no usable source.
      const score = overlap < 0.34 ? overlap : Math.min(0.97, 0.55 + 0.45 * overlap);
      if (!best || score > best.score) best = { doc: d.title, section: s.id, text: s.text, score: +score.toFixed(2) };
    }
  }
  return best;
}
