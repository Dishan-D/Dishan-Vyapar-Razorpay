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
import { readPhotos, isUseful, type PhotoText } from "./ocr.js";

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

WHAT TO LIST
- Every distinct product you can SEE in the photos, plus every product mentioned in words. A photo is a complete input on its own: if there are three photos of goods, there are at least three products, and returning an empty list is wrong.
- Work through the photos ONE AT A TIME, in order — Photo 1, then Photo 2, and so on — and say what is for sale in each.
- These are real shop photos, not catalog shots. They are cluttered, they are lit badly, and several items may be in frame at once. That is normal and it is not a reason to stop: a busy photo yields MORE products, never fewer. There is no "hero product" requirement — list what is plainly for sale.
- You are never blocked by not knowing a price, a size, a fabric or a count. Those are expected to be missing and are handled downstream by asking the shopkeeper. Listing a product you are unsure about is CORRECT; it gets held and confirmed.
- Returning an empty list is the one answer that is always wrong. If you can see goods, there are products.
- One entry per PRODUCT, not per photo. A shelf photo may hold six products; the same product photographed twice is one product.
- Describe what is actually in the image — colour, material, style, what it plainly is. "Blue cotton saree with a gold border" is a good name; "Product 1" is not.

PRICES AND STOCK
- An unpriced product is still a product. If no price was stated, return null for it and score price_confidence near zero — it will be shown to the shopkeeper as a question, which is exactly what should happen. Do NOT drop the product for want of a price, and do NOT invent one from what such an item usually costs.
- Same for stock: null and a low score, never a guess dressed as a count.

CONFIDENCE
- Score each field on how well the input supports it. A price said out loud is high; a price you inferred from the look of the thing is not a price at all.
- These scores decide what gets held back for the shopkeeper to confirm, so a guess scored as a certainty puts an unchecked price in front of a buyer.

The shop's own trade is your strongest hint about category. A phone shop is not selling snacks.

Categories are a fixed list; pick the closest and use *.other rather than inventing one:
apparel.saree, apparel.kurta, apparel.dupatta, apparel.other, home.bedsheet, home.towel, home.other, mobile.case, mobile.charger, mobile.audio, mobile.screenguard, mobile.other, food.snack, stationery.pen, stationery.paper, stationery.other, general.other, other`;

/**
 * The prompt for the no-vision path.
 *
 * The main SYSTEM prompt is written around looking at photographs — "every
 * distinct product you can SEE" — and handing it no images leaves it arguing
 * with itself. Given OCR text that plainly read COTTON BATH TOWEL and MRP Rs.
 * 450/- at confidence 94, it returned nothing at all. So this path gets its own
 * instructions, where the printed text IS the evidence rather than a hint about
 * a picture that is missing.
 */
const TEXT_ONLY_SYSTEM = `A small Indian shopkeeper is putting their shop online. Their photos could not be looked at this time, but the text physically printed in those photos has been read by OCR, character by character, and is given to you below along with anything they typed or said.

Build the catalog from that text. It is real evidence, not a hint: a line reading "COTTON BATH TOWEL / Pack of 3 - Pink / MRP Rs. 450/-" describes a product you can list with a price, and you should.

- List every product the text supports. One entry per product.
- A price that appears in the OCR text was READ off a tag or packet — treat it as stated by the merchant and score it high.
- A price that does NOT appear anywhere is unknown: return null and score it near zero. Never infer one from what such a thing usually costs.
- Same for stock: a printed count is a count; otherwise null.
- Name the product as a shopper would search for it, using the words that were actually printed.
- In notes, say that the photograph itself was not seen and the record came from printed text.

Returning an empty list when there IS legible product text is the one wrong answer. If the text genuinely describes no product, return an empty list and say why in store_summary.

`;


const MEDIA: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif",
};

/**
 * Images are billed flat and the per-minute budget is small, so photos go up in
 * batches of this size — they are not discarded beyond it.
 *
 * This constant used to be a hard cap: `photos.slice(0, 3)`. A merchant who
 * sent ten photos got three products and was never told the other seven were
 * dropped, which is the worst kind of failure this project can have — quiet,
 * plausible, and wrong in the merchant's favour-sounding direction.
 */
export const MAX_PHOTOS_PER_CALL = 3;

function describe(input: StorefrontInput, attached: number, ocr: PhotoText[] = []): string {
  return [
    `Shop: ${input.merchant_name}`,
    input.description ? `What they said about the shop: "${input.description}"` : null,
    ...input.voice_notes.map((v, i) => `Voice note ${i + 1} (transcribed): "${v}"`),
    attached > 0
      ? `${attached} photo(s) attached to this message — list every product visible in them, priced or not.`
      : "No photos — go on the words alone.",
    ...ocrLines(ocr),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * What was literally printed in each photo, where the reading is trustworthy.
 *
 * Offered as evidence, not as an answer. A price tag read at confidence 94 is
 * better than any vision model's impression of the same tag — it is characters,
 * not a paraphrase — so the prompt says to prefer it. Photos with no legible
 * writing contribute nothing here rather than contributing noise.
 */
function ocrLines(ocr: PhotoText[]): string[] {
  const useful = ocr.filter(isUseful);
  if (useful.length === 0) return [];
  return [
    "",
    "TEXT READ DIRECTLY OFF THE PHOTOS (OCR, character-accurate — trust these over your own reading of the image):",
    ...useful.map((t, i) => {
      const amounts = t.amounts.length > 0 ? ` [rupee amounts found: ${t.amounts.join(", ")}]` : "";
      return `  Photo ${i + 1}: "${t.text.replace(/\n/g, " / ")}"${amounts}`;
    }),
    "A price that appears here was READ, not guessed — score its confidence high. A price that does not appear here was not stated.",
  ];
}

async function imageParts(photos: string[]): Promise<Array<{ path: string; b64: string; media: string }>> {
  const out = [];
  for (const p of photos) {
    const media = MEDIA[path.extname(p).toLowerCase()];
    if (!media) continue;
    out.push({ path: p, b64: (await readFile(p)).toString("base64"), media });
  }
  return out;
}

/**
 * Announce each photo by number, in its own text part.
 *
 * Handed several images back to back with one instruction, the model reads them
 * as a single scene and answers about the first: three photos of a saree, a
 * kurta and a towel produced one product, while its own store_summary named all
 * three. It was seeing them and not enumerating them. Numbering each photo, and
 * stating the count up front, took the same three photos from 1 product to 3.
 */
function numbered<T>(images: T[], wrap: (img: T) => unknown, text: (s: string) => unknown): unknown[] {
  const out: unknown[] = [
    text(`The shopkeeper sent ${images.length} photo${images.length === 1 ? "" : "s"}. Treat each as a SEPARATE product unless two plainly show the same item.`),
  ];
  images.forEach((img, i) => {
    out.push(text(`--- Photo ${i + 1} of ${images.length} ---`));
    out.push(wrap(img));
  });
  return out;
}

export interface StorefrontResult {
  products: Extraction[];
  store_summary: string;
  provider: "groq" | "claude";
  photos_used: number;
}

/**
 * Photos in batches, products merged.
 *
 * The per-minute token budget fits about three images, so a shop with ten
 * photos becomes four calls rather than one truncated one. The governor paces
 * them; the merchant gets every product they photographed.
 *
 * Only the first batch carries the words the merchant typed and their voice
 * notes: repeating them would invite the same spoken product to be extracted
 * once per batch, and a duplicate is harder to notice than a gap.
 */
export async function extractStorefront(input: StorefrontInput): Promise<StorefrontResult> {
  const batches: string[][] = [];
  for (let i = 0; i < input.photos.length; i += MAX_PHOTOS_PER_CALL) {
    batches.push(input.photos.slice(i, i + MAX_PHOTOS_PER_CALL));
  }
  if (batches.length <= 1) return extractBatch(input, true);

  const all: Extraction[] = [];
  const summaries: string[] = [];
  let provider: "groq" | "claude" = "groq";
  let used = 0;

  for (const [n, photos] of batches.entries()) {
    const first = n === 0;
    const res = await extractBatch({
      merchant_name: input.merchant_name,
      ...(first && input.description ? { description: input.description } : {}),
      voice_notes: first ? input.voice_notes : [],
      photos,
    }, true);
    provider = res.provider;
    used += res.photos_used;
    summaries.push(res.store_summary);
    // Same product photographed twice across batches is still one product.
    for (const prod of res.products) {
      const key = prod.name.trim().toLowerCase();
      if (!all.some((x) => x.name.trim().toLowerCase() === key)) all.push(prod);
    }
  }

  return {
    products: all,
    store_summary: summaries[0] ?? "",
    provider,
    photos_used: used,
  };
}

/**
 * One model call over one batch of photos.
 *
 * `allowTextFallback` is what stops a spent vision quota from being the end of
 * the road. Images are the expensive part of this call by an order of
 * magnitude — about 1,700 tokens each against a couple of hundred for the whole
 * text prompt — and the daily ceiling is reached on images long before it is
 * reached on words. When that happens, the OCR text and the merchant's own
 * description are still here, still free, and still enough to name most
 * products. What comes back is thinner and every price is held for
 * confirmation, which is the correct outcome: a degraded read the shopkeeper
 * checks, rather than "come back tomorrow".
 */
async function extractBatch(
  input: StorefrontInput,
  allowTextFallback = false,
): Promise<StorefrontResult> {
  const provider = activeProvider();
  if (provider === "none") {
    throw new Error("No model provider configured — set GROQ_API_KEY or ANTHROPIC_API_KEY");
  }

  const images = await imageParts(input.photos);
  // Local, free, and unmetered — so this happens before anything is spent on
  // the model, and its results survive even when the model call cannot be made.
  const ocr = await readPhotos(input.photos);
  const text = describe(input, images.length, ocr);

  if (provider === "groq") {
    const groq = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: GROQ_BASE_URL });
    try {
    const content = [
      ...(numbered(
        images,
        (i) => ({ type: "image_url" as const, image_url: { url: `data:${i.media};base64,${i.b64}` } }),
        (t) => ({ type: "text" as const, text: t }),
      ) as OpenAI.Chat.Completions.ChatCompletionContentPart[]),
      { type: "text" as const, text },
    ];

    // Measured, not guessed: three images plus this system prompt bill 5,424
    // prompt tokens, i.e. about 1,700 an image over a ~1,000-token base. The
    // old estimate of 2,200 an image over 1,200 claimed 7,800 for the same
    // call, and the governor duly waited for budget the request never needed.
    const res = await sharedGroqGovernor.run(1000 + images.length * 1800, () =>
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
      // Someone is standing at a phone waiting for their shop to appear. The
      // free tier has a daily token ceiling as well as a per-minute one, and on
      // a daily exhaustion `retry-after` is half an hour — which the governor
      // will honour by sleeping, holding the request open the whole time. A
      // merchant cannot tell that apart from a hung app, so bound the wait and
      // let the caller say what actually happened.
      { maxWaitSeconds: 20 },
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
    } catch (err) {
      // Only a budget refusal degrades. A malformed response or a network fault
      // is a real failure and must not be quietly answered with a thinner
      // catalog that looks like a successful read.
      const budget = (err as Error)?.name === "RateBudgetExceeded" ||
        /rate.?limit|tokens per day|TPD|429/i.test((err as Error)?.message ?? "");
      if (!budget || !allowTextFallback || images.length === 0) throw err;

      const words = describe({ ...input, photos: [] }, 0, ocr);
      const res2 = await sharedGroqGovernor.run(600, () =>
        groq.chat.completions
          .create({
            model: GROQ_MODEL,
            messages: [
              // Categories live in the main prompt and must stay identical, so
              // that section is carried over rather than restated and drifting.
              { role: "system", content: TEXT_ONLY_SYSTEM + SYSTEM.slice(SYSTEM.indexOf("Categories are a fixed list")) },
              { role: "user", content: words },
            ],
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
        // Longer than the vision attempt allows itself. This is the last thing
        // standing between the merchant and an error, the call is small, and a
        // per-minute window resets inside ninety seconds — so waiting one out
        // here buys a working storefront where 20s bought a failure.
        { maxWaitSeconds: 95 },
      );
      const raw2 = res2.choices[0]?.message?.content;
      if (!raw2) throw err;
      const parsed2 = StorefrontSchema.parse(JSON.parse(raw2));
      return {
        products: parsed2.products.map(fromWire),
        store_summary: parsed2.store_summary,
        provider: "groq",
        photos_used: 0,
      };
    }
  }

  const anthropic = new Anthropic();
  const blocks: Anthropic.ContentBlockParam[] = [
    ...(numbered(
      images,
      (i) => ({
        type: "image" as const,
        source: { type: "base64" as const, media_type: i.media as "image/jpeg", data: i.b64 },
      }),
      (t) => ({ type: "text" as const, text: t }),
    ) as Anthropic.ContentBlockParam[]),
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
