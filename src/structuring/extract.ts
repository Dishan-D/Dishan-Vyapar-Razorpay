import { readFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import OpenAI from "openai";
import { z } from "zod";
import {
  activeProvider,
  CLAUDE_MODEL,
  GROQ_BASE_URL,
  GROQ_MODEL,
  strictJsonSchema,
  type LlmProvider,
} from "../llm/provider.js";
import {
  ExtractionSchema,
  ExtractionWireSchema,
  fromWire,
  type Extraction,
  type ExtractionRecord,
  type RawProduct,
} from "./extraction.js";

export const MODEL = CLAUDE_MODEL;

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

/** The merchant's input as text. Shared, so both providers get the same wording. */
function describeInput(raw: RawProduct): string {
  return [
    raw.photo_filename ? `Photo filename: ${raw.photo_filename}` : null,
    `Voice note (transcribed): "${raw.voice_note}"`,
    raw.payment_page_description
      ? `Razorpay Payment Page description: "${raw.payment_page_description}"`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

async function buildContent(raw: RawProduct): Promise<Anthropic.ContentBlockParam[]> {
  const blocks: Anthropic.ContentBlockParam[] = [];

  if (raw.photo_path) {
    const ext = path.extname(raw.photo_path).toLowerCase();
    const mediaType = MEDIA_TYPES[ext];
    if (!mediaType) throw new Error(`Unsupported image type for ${raw.photo_path}`);
    const data = (await readFile(raw.photo_path)).toString("base64");
    blocks.push({ type: "image", source: { type: "base64", media_type: mediaType, data } });
  }

  blocks.push({ type: "text", text: describeInput(raw) });
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
    output_config: { format: zodOutputFormat(ExtractionWireSchema) },
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
    extraction: fromWire(parsed),
    provider: "claude",
    model: response.model,
    extracted_at: new Date().toISOString(),
  };
}

/**
 * Stage 1 against Groq. Same prompt, same schema, same gate — only the model
 * behind it differs, which is the point: nothing downstream of Stage 1 knows or
 * cares who read the photo.
 *
 * Groq speaks the OpenAI wire format, so the official OpenAI SDK is the client;
 * only the base URL changes.
 */
export async function extractWithGroq(
  raw: RawProduct,
  client?: OpenAI,
): Promise<ExtractionRecord> {
  const groq =
    client ?? new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: GROQ_BASE_URL });

  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];

  if (raw.photo_path) {
    const ext = path.extname(raw.photo_path).toLowerCase();
    const mediaType = MEDIA_TYPES[ext];
    if (!mediaType) throw new Error(`Unsupported image type for ${raw.photo_path}`);
    const data = (await readFile(raw.photo_path)).toString("base64");
    content.push({ type: "image_url", image_url: { url: `data:${mediaType};base64,${data}` } });
  }

  content.push({ type: "text", text: describeInput(raw) });

  const response = await groq.chat.completions.create({
    model: GROQ_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "catalog_extraction",
        strict: true,
        schema: strictJsonSchema(z.toJSONSchema(ExtractionWireSchema) as Record<string, unknown>),
      },
    },
  });

  const text = response.choices[0]?.message?.content;
  if (!text) throw new Error(`Groq returned no content for ${raw.sample_id}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Groq returned unparseable JSON for ${raw.sample_id}: ${text.slice(0, 200)}`);
  }

  return {
    sample_id: raw.sample_id,
    extraction: fromWire(ExtractionWireSchema.parse(parsed)),
    provider: "groq",
    model: response.model,
    extracted_at: new Date().toISOString(),
  };
}

/** Dispatch to whichever provider this run is configured for. */
export async function extractLive(raw: RawProduct): Promise<ExtractionRecord> {
  const provider = activeProvider();
  if (provider === "groq") return extractWithGroq(raw);
  if (provider === "claude") return extractWithClaude(raw);
  throw new Error("No model provider configured — set GROQ_API_KEY or ANTHROPIC_API_KEY");
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

/** True when some provider can actually be called. */
export function hasCredentials(): boolean {
  return activeProvider() !== "none";
}

export function currentProvider(): LlmProvider {
  return activeProvider();
}
