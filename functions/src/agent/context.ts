import type { Bucket } from "@google-cloud/storage";
import type { Firestore } from "firebase-admin/firestore";
import type { AdkConfig } from "./adk/config";
import type { WhatsAppCreds } from "../whatsapp/client";
import type { TelegramCreds } from "../telegram/client";

/** Everything the agent runtime needs, injected so it can run against emulators and tests. */
export interface Ctx {
  db: Firestore;
  orgId: string;
  bucket?: Bucket;
  now: () => number;
  /** Real WhatsApp credentials. Absent in tests and the simulator. */
  whatsapp?: WhatsAppCreds;
  /** Telegram bot credentials. Absent in tests and the simulator. */
  telegram?: TelegramCreds;
  /** Vertex AI model settings. Null runs the agent on rules only. */
  adk: AdkConfig | null;
  /** Test seam: replaces the ADK understander. */
  understanderOverride?: import("./understand").AdkUnderstander | null;
  /** Meta page access token for replying to and hiding comments. Absent in tests and demo mode. */
  metaPageToken?: string;
  /** Test seam / production hook for the Gemini comment classifier. Null means rules only. */
  commentClassifier?: ((text: string) => Promise<import("../comments/classify").CommentClassification>) | null;
  /** Firebase Auth operations the manager actions need. Absent in tests, where a fake is injected. */
  accounts?: {
    uidByEmail(email: string): Promise<string | null>;
    uidsByDomain(domain: string): Promise<string[]>;
    /** Removes the account's manager claims and revokes its sessions. */
    revoke(uid: string): Promise<void>;
  };
  log: (msg: string, data?: Record<string, unknown>) => void;
}
