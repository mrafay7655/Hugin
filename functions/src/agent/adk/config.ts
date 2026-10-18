export interface AdkConfig {
  /** Google Cloud project that has the Vertex AI API enabled. */
  project: string;
  /** Vertex AI location, e.g. "us-central1". */
  location: string;
  /** Gemini model id available in that location. */
  model: string;
}

/**
 * Resolves the Vertex AI configuration from the environment. Returns null when the agent
 * should run without a model (local emulators, tests), in which case the rule-based
 * understanding is used. Set GEMINI_MODE=vertex to force it on, GEMINI_MODE=off to disable.
 * Kept free of any ADK import so reading config never loads the heavy ADK package.
 */
export function adkConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AdkConfig | null {
  const inEmulator = env.FUNCTIONS_EMULATOR === "true";
  const mode = env.GEMINI_MODE ?? (inEmulator ? "off" : "vertex");
  if (mode !== "vertex") return null;
  // GEMINI_PROJECT lets the local emulators (project demo-hugin) use Gemini from the real project.
  const project = env.GEMINI_PROJECT ?? env.GCLOUD_PROJECT ?? env.GOOGLE_CLOUD_PROJECT;
  if (!project) return null;
  return {
    project,
    location: env.GEMINI_LOCATION ?? "us-central1",
    model: env.GEMINI_MODEL ?? "gemini-2.5-flash",
  };
}
