/**
 * What the buyer's agent can actually do.
 *
 * The same split as the merchant's side, for the same reason: a read tool runs
 * the moment the agent asks for it, and anything that spends money is a
 * *proposal* the shopper has to press. The distinction is sharper here, because
 * on this side the write is a purchase — an assistant that could quietly decide
 * a saree was worth buying is not something anybody should leave open in a tab.
 *
 * `start_purchase` is therefore not a tool that buys. It is a tool that says
 * "here is what I would buy, and here is the ceiling I would hold to", and the
 * agent run itself only begins once a person has agreed to that sentence.
 */
export interface BuyerToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** True when running this would spend money. Those are proposed, never done. */
  spends: boolean;
}

const noArgs = { type: "object", properties: {}, required: [], additionalProperties: false };

export const BUYER_TOOLS: BuyerToolDef[] = [
  {
    name: "search_shelf",
    description:
      "Search every shop's catalog for something. Returns products an AI buyer can actually buy right now, with price, stock, shop name and the lowest price each shop will go to.",
    parameters: {
      type: "object",
      properties: {
        want: { type: "string", description: "What the shopper is looking for, as search terms" },
        max_price: { type: "number", description: "Rupee ceiling, or 0 for no limit" },
      },
      required: ["want", "max_price"],
      additionalProperties: false,
    },
    spends: false,
  },
  {
    name: "get_orders",
    description:
      "The shopper's own orders and where each one has got to: awaiting payment, paid and waiting for the shop to hand over, or delivered.",
    parameters: noArgs,
    spends: false,
  },
  {
    name: "get_order",
    description:
      "One order in detail: what was bought, from whom, what was paid, the payment reference, and whether the shop has confirmed handover.",
    parameters: {
      type: "object",
      properties: { transaction_id: { type: "string", description: "The order to look up" } },
      required: ["transaction_id"],
      additionalProperties: false,
    },
    spends: false,
  },
  {
    name: "check_shop",
    description:
      "A shop's delivery record before buying from it: how many sales it has actually handed over, and how quickly.",
    parameters: {
      type: "object",
      properties: { merchant_id: { type: "string", description: "The shop to check" } },
      required: ["merchant_id"],
      additionalProperties: false,
    },
    spends: false,
  },
  {
    name: "start_purchase",
    description:
      "Propose buying ONE specific product that search_shelf has already returned. This does NOT buy it — it prepares the purchase and the shopper must confirm before any money moves. Call search_shelf first and pass the NUMBER of the product you want from its numbered results.",
    parameters: {
      type: "object",
      properties: {
        product: {
          type: "string",
          description:
            "Which product, taken from the numbered list search_shelf returned — just the number, e.g. \"2\". The product's exact name also works. Never make up an id.",
        },
        max_price: { type: "number", description: "The most the shopper will pay, in rupees" },
      },
      required: ["product", "max_price"],
      additionalProperties: false,
    },
    spends: true,
  },
];

export interface BuyerToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface BuyerToolResult {
  tool: string;
  /** One line for the trail the shopper sees. */
  summary: string;
  data?: unknown;
  error?: string;
  /** Present only for tools that spend. Nothing happens until this is pressed. */
  proposal?: {
    label: string;
    goal: string;
    /** The exact product this proposal is for. Never a name the model composed. */
    item_id: string;
    max_price: number;
  };
}
