import { FunctionTool } from "@google/adk";
import { z } from "zod";
import { checkDomain } from "../../policy/domain";
import type { Retrieval } from "../../types";

/**
 * Dependencies the read-only tools need. Injected per message so the tools are scoped
 * to one organization and one customer, and so tests can fake them.
 */
export interface AdkDeps {
  officialDomains: string[];
  searchPolicy(query: string): Promise<Retrieval | null>;
  customerContext(): Promise<{ tier: string; customerSinceYear: number; recentIntents: string[]; cardLocked: boolean }>;
}

/**
 * Tools the model may call on its own. They are READ-ONLY on purpose: anything that changes
 * state (locking a card, opening a case, sending a message) is done by the policy engine
 * after the decision, never by a model-chosen tool call.
 */
export function readOnlyTools(deps: AdkDeps): FunctionTool[] {
  return [
    new FunctionTool({
      name: "search_policy",
      description:
        "Searches Ravenwood Bank's approved policy and fee documents. Returns the best matching passage with its document, section and a relevance score from 0 to 1. A score below 0.6 means there is no usable source.",
      parameters: z.object({ query: z.string().describe("The customer's question, in plain words") }),
      execute: async ({ query }) => {
        const r = await deps.searchPolicy(query);
        return r ? { found: true, doc: r.doc, section: r.section, text: r.text, score: r.score } : { found: false };
      },
    }),
    new FunctionTool({
      name: "check_domain",
      description:
        "Checks whether a web domain from the customer's message is Ravenwood's official site, a lookalike imitating it, or unrelated. Call it once for every domain or link in the message.",
      parameters: z.object({ domain: z.string().describe("A domain such as example.com, without a path") }),
      execute: async ({ domain }) => checkDomain(domain.replace(/^https?:\/\//, "").split(/[/?#]/)[0], deps.officialDomains),
    }),
    new FunctionTool({
      name: "get_customer_context",
      description:
        "Returns what is known about the customer talking to us: tier, how long they have banked with us, recent conversation intents, and whether their card is already locked.",
      parameters: z.object({}),
      execute: async () => deps.customerContext(),
    }),
  ];
}
