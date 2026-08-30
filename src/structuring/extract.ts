import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  ExtractionSchema,
  type Extraction,
  type ExtractionRecord,
  type RawProduct,
} from "./extraction.js";

export const MODEL = "claude-opus-5";

const SYSTEM_PROMPT = `You are reading a small Indian merchant's own description of something they sell — a phone photo, a filename, and a voice note transcribed as-is. The voice note is usually Hindi/Hinglish; the shopkeeper is talking to a customer, not filling in a form.

Turn that into one structured catalog record.

The confidence scores are the part that matters. They are read by a gate: anything you score below 0.6 on price or stock is held back and shown to the merchant to confirm before an AI buyer can transact on it. So:

- Score what the input actually supports, not what a plausible product of this kind would cost. A stated number said plainly ("yeh 1200 ka hai") is high confidence. A hedge, a range, a "dekh ke bataunga", a price you inferred from the photo rather than read — low.
- Distinguish "the merchant told me" from "I guessed". Guessing is allowed; scoring a guess as though it were stated is not.
- If a price or stock count is genuinely not stated, return null for it rather than inventing a number. Null is a useful answer here; a confident wrong number is the expensive one.
- Attributes: only what is stated or plainly visible. Do not pad the record with likely-sounding attributes.
- Write the product name in English as a shopper would search for it, even though the input is Hinglish.

In notes, say in one line what each uncertain reading was based on.`;

const MEDIA_TYPES: Record<string, "image/png" | "image/jpeg" | "image/webp" | "image/gif"> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

async function buildContent(raw: RawProduct): Promise<Anthropic.ContentBlockParam[]> {
  const blocks: Anthropic.ContentBlockParam[] = [];

  if (raw.photo_path) {
    const ext = path.extname(raw.photo_path).toLowerCase();
    const mediaType = MEDIA_TYPES[ext];
    if (!mediaType) throw new Error(`Unsupported image type for ${raw.photo_path}`);
    const data = (await readFile(raw.photo_path)).toString("base64");
    blocks.push({ type: "image", source: { type: "base64", media_type: mediaType, data } });
  }

  const lines = [
    raw.photo_filename ? `Photo filename: ${raw.photo_filename}` : null,
    `Voice note (transcribed): "${raw.voice_note}"`,
    raw.payment_page_description
      ? `Razorpay Payment Page description: "${raw.payment_page_description}"`
      : null,
  ].filter(Boolean);

  blocks.push({ type: "text", text: lines.join("\n") });
  return blocks;
}

/** Stage 1 against the live model. Requires ANTHROPIC_API_KEY or an `ant auth login` profile. */
export async function extractWithClaude(
  raw: RawProduct,
  client: Anthropic = new Anthropic(),
): Promise<ExtractionRecord> {
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: await buildContent(raw) }],
    output_config: { format: zodOutputFormat(ExtractionSchema) },
  });

  if (response.stop_reason === "refusal") {
    throw new Error(
      `Model declined to extract ${raw.sample_id}: ${response.stop_details?.explanation ?? "no explanation"}`,
    );
  }

  const parsed = response.parsed_output;
  if (!parsed) {
    throw new Error(`Model returned no parseable extraction for ${raw.sample_id}`);
  }

  return {
    sample_id: raw.sample_id,
    extraction: parsed,
    provider: "claude",
    model: response.model,
    extracted_at: new Date().toISOString(),
  };
}

/**
 * Offline stand-in for the model call.
 *
 * These are hand-authored fixtures, NOT recorded model output — nobody has run
 * the live extractor against these samples yet. They exist so the pipeline below
 * Stage 1 is runnable and demonstrable without an API key, and so the demo video
 * does not hinge on a live call behaving on camera (PRESENTATION_GUIDE.md §2).
 * Anything reported from this path is labelled as fixture-sourced.
 */
export async function extractFromFixture(
  raw: RawProduct,
  fixtures: Record<string, Extraction>,
): Promise<ExtractionRecord> {
  const extraction = fixtures[raw.sample_id];
  if (!extraction) throw new Error(`No fixture recorded for sample "${raw.sample_id}"`);
  return {
    sample_id: raw.sample_id,
    extraction: ExtractionSchema.parse(extraction),
    provider: "fixture",
    extracted_at: new Date().toISOString(),
  };
}

/**
 * True when a live call is possible.
 *
 * The SDK resolves credentials in its own order — `ANTHROPIC_API_KEY`, then
 * `ANTHROPIC_AUTH_TOKEN`, then a profile written by `ant auth login`. Checking
 * only the env vars would send anyone who authenticated with the CLI down the
 * fixture path while telling them no credentials exist, so the profile store is
 * checked too.
 */
export function hasCredentials(): boolean {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return true;

  const configHome =
    process.env.XDG_CONFIG_HOME ?? (homedir() ? path.join(homedir(), ".config") : undefined);
  return configHome ? existsSync(path.join(configHome, "anthropic")) : false;
}
