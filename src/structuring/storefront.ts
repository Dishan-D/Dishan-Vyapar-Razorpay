import { readFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  activeProvider,
  CLAUDE_MODEL,
  GROQ_BASE_URL,
  GROQ_MODEL,
  strictJsonSchema,
} from "../llm/provider.js";
import { sharedGroqGovernor } from "../llm/ratelimit.js";
import { ExtractionWireSchema, fromWire, type Extraction } from "./extraction.js";

/**
 * A whole shop read at once, rather than one product at a time.
 *
 * Onboarding is not "fill in a product form fifteen times". A merchant sends
 * what they have — a shelf photo, a voice note that rattles off six items, a
 * handwritten price list — and the number of products in it is not known in
 * advance. So the extraction returns a list and the caller does not get to
 * assume its length.
 */
export const StorefrontSchema = z.object({
  products: z
    .array(ExtractionWireSchema)
    .describe("Every distinct product you can identify. One entry per product, not per photo."),
  store_summary: z.string().describe("One line describing what this shop sells overall"),
});

export type StorefrontExtraction = z.infer<typeof StorefrontSchema>;

export interface StorefrontInput {
  merchant_name: string;
  /** What the merchant typed, if anything. */
  description?: string;
  /** Voice notes, already transcribed. */
  voice_notes: string[];
  /** Absolute paths to uploaded images. */
  photos: string[];
}

const SYSTEM = `A small Indian shopkeeper is putting their shop online for the first time. They have sent you whatever they had to hand — photos of their stock, a voice note or two, maybe a line of text. Nothing is formatted. Nothing is complete.

Read all of it together and list what they sell.

- One entry per PRODUCT, not per photo. A shelf photo may hold six products; a product may appear in two photos.
- Only list what you can actually see or what they actually said. Do not pad the shop out with things a shop like this usually stocks.
- Prices: use what they stated. If a price was never given, return null — the merchant will be asked. A confident wrong price is far more expensive here than an admitted gap.
- Stock: same rule. "Kuch hai" is not a number.
- Confidence per field, honestly. These scores decide what gets held back for the merchant to confirm, so a guess scored as a certainty puts an unchecked price in front of a buyer.
- The shop's own trade is your strongest hint about category. A phone shop is not selling snacks.

Categories are a fixed list; pick the closest and use *.other rather than inventing one:
apparel.saree, apparel.kurta, apparel.dupatta, apparel.other, home.bedsheet, home.towel, home.other, mobile.case, mobile.charger, mobile.audio, mobile.screenguard, mobile.other, food.snack, other`;

const MEDIA: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif",
};

/** Images are billed flat and the per-minute budget is small, so this is capped. */
export const MAX_PHOTOS_PER_CALL = 3;

function describe(input: StorefrontInput): string {
  return [
    `Shop: ${input.merchant_name}`,
    input.description ? `What they said about the shop: "${input.description}"` : null,
    ...input.voice_notes.map((v, i) => `Voice note ${i + 1} (transcribed): "${v}"`),
    input.photos.length > 0 ? `${input.photos.length} photo(s) attached.` : "No photos — go on the words alone.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function imageParts(photos: string[]): Promise<Array<{ path: string; b64: string; media: string }>> {
  const out = [];
  for (const p of photos.slice(0, MAX_PHOTOS_PER_CALL)) {
    const media = MEDIA[path.extname(p).toLowerCase()];
    if (!media) continue;
    out.push({ path: p, b64: (await readFile(p)).toString("base64"), media });
  }
  return out;
}

export interface StorefrontResult {
  products: Extraction[];
  store_summary: string;
  provider: "groq" | "claude";
  photos_used: number;
}

export async function extractStorefront(input: StorefrontInput): Promise<StorefrontResult> {
  const provider = activeProvider();
  if (provider === "none") {
    throw new Error("No model provider configured — set GROQ_API_KEY or ANTHROPIC_API_KEY");
  }

  const images = await imageParts(input.photos);
  const text = describe(input);

  if (provider === "groq") {
    const groq = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: GROQ_BASE_URL });
    const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      ...images.map((i) => ({
        type: "image_url" as const,
        image_url: { url: `data:${i.media};base64,${i.b64}` },
      })),
      { type: "text" as const, text },
    ];

    const res = await sharedGroqGovernor.run(1200 + images.length * 2200, () =>
      groq.chat.completions
        .create({
          model: GROQ_MODEL,
          messages: [{ role: "system", content: SYSTEM }, { role: "user", content }],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "storefront",
              strict: true,
              schema: strictJsonSchema(z.toJSONSchema(StorefrontSchema) as Record<string, unknown>),
            },
          },
        })
        .withResponse(),
    );

    const raw = res.choices[0]?.message?.content;
    if (!raw) throw new Error("Groq returned no storefront");
    const parsed = StorefrontSchema.parse(JSON.parse(raw));
    return {
      products: parsed.products.map(fromWire),
      store_summary: parsed.store_summary,
      provider: "groq",
      photos_used: images.length,
    };
  }

  const anthropic = new Anthropic();
  const blocks: Anthropic.ContentBlockParam[] = [
    ...images.map((i) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: i.media as "image/jpeg", data: i.b64 },
    })),
    { type: "text" as const, text },
  ];
  const res = await anthropic.messages.parse({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    messages: [{ role: "user", content: blocks }],
    output_config: { format: zodOutputFormat(StorefrontSchema) },
  });
  if (!res.parsed_output) throw new Error("Claude returned no storefront");
  return {
    products: res.parsed_output.products.map(fromWire),
    store_summary: res.parsed_output.store_summary,
    provider: "claude",
    photos_used: images.length,
  };
}
