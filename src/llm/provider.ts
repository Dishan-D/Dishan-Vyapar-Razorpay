import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type LlmProvider = "groq" | "claude" | "none";

/**
 * An environment variable set to the empty string is unset, not an override.
 *
 * `??` only falls back on undefined, so a stray `GROQ_MODEL=` line in .env — the
 * shape every commented-out example turns into if someone uncomments it without
 * filling it in — silently replaced the default with "", and every request came
 * back 404 "the model `` does not exist". The failure surfaced three layers away
 * as "the agent stopped using the model".
 */
const env = (name: string, fallback: string): string => {
  const raw = process.env[name];
  return raw && raw.trim() !== "" ? raw.trim() : fallback;
};

/** Model defaults, overridable per provider via env. */
export const GROQ_MODEL = env("GROQ_MODEL", "qwen/qwen3.8-27b");
export const CLAUDE_MODEL = env("CLAUDE_MODEL", "claude-opus-5");
export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

function anthropicProfileExists(): boolean {
  const configHome =
    process.env.XDG_CONFIG_HOME ?? (homedir() ? path.join(homedir(), ".config") : undefined);
  return configHome ? existsSync(path.join(configHome, "anthropic")) : false;
}

/**
 * Which model provider this run can actually use.
 *
 * `LLM_PROVIDER` forces a choice; otherwise whichever key is present wins, Groq
 * first. Both providers are equally supported — the pipeline's substance is the
 * mandate chain and the negotiation bounds, and neither depends on who does the
 * extraction. "none" is a legitimate answer: the fixtures take over and every
 * stage below Stage 1 runs unchanged.
 */
export function activeProvider(): LlmProvider {
  const forced = env("LLM_PROVIDER", "").toLowerCase();
  if (forced === "groq") return "groq";
  if (forced === "claude" || forced === "anthropic") return "claude";
  if (forced === "none" || forced === "fixture") return "none";

  if (process.env.GROQ_API_KEY) return "groq";
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return "claude";
  if (anthropicProfileExists()) return "claude";
  return "none";
}

export function providerLabel(p: LlmProvider): string {
  return p === "groq" ? `Groq ${GROQ_MODEL}` : p === "claude" ? `Claude ${CLAUDE_MODEL}` : "no model";
}

/**
 * A JSON Schema Groq's strict mode will accept: every property required, no
 * additional properties, and no `$schema` key (which it rejects).
 */
export function strictJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema, ...rest } = schema as { $schema?: unknown } & Record<string, unknown>;
  return rest;
}
