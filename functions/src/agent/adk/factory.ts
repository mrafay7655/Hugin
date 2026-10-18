import type { CommentClassification } from "../../comments/classify";
import type { AdkUnderstander } from "../understand";
import type { AdkConfig } from "./config";
import type { AdkDeps } from "./tools";

/**
 * Builds the ADK-backed understander. ADK is imported lazily, on first use, so the webhook
 * and Firebase's deploy-time function discovery never pay for loading it.
 */
export function createAdkUnderstander(cfg: AdkConfig | null, deps: AdkDeps): AdkUnderstander | null {
  if (!cfg) return null;
  return async (input) => {
    const [{ vertexModel }, { runUnderstanding }] = await Promise.all([import("./model"), import("./pipeline")]);
    return runUnderstanding(vertexModel(cfg), input, deps);
  };
}

/** The ADK-backed comment classifier, loaded lazily for the same reason. */
export function createAdkCommentClassifier(cfg: AdkConfig | null): ((text: string) => Promise<CommentClassification>) | null {
  if (!cfg) return null;
  return async (text) => {
    const [{ vertexModel }, { classifyCommentWithAdk }] = await Promise.all([import("./model"), import("./comments")]);
    return classifyCommentWithAdk(vertexModel(cfg), text);
  };
}
