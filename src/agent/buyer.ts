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
      "Search every shop for something. Returns a numbered list: name, shop, listed price, stock.",
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
      "One order in detail.",
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
      "A shop's delivery record.",
    parameters: {
      type: "object",
      properties: { merchant_id: { type: "string", description: "The shop to check" } },
      required: ["merchant_id"],
      additionalProperties: false,
    },
    spends: false,
  },
  {
    name: "get_product",
    description:
      "One product in detail: price, stock, other sizes, what goes with it.",
    parameters: {
      type: "object",
      properties: { product: { type: "string", description: "Number from the last list, or the product's name. \"it\" and \"that\" mean whatever they were last looking at." } },
      required: ["product"],
      additionalProperties: false,
    },
    spends: false,
  },
  {
    name: "compare_products",
    description:
      "Two or more products side by side on price, size, stock and shop.",
    parameters: {
      type: "object",
      properties: {
        products: { type: "array", items: { type: "string" }, description: "Numbers from the last list, or product names. Two or more." },
      },
      required: ["products"],
      additionalProperties: false,
    },
    spends: false,
  },
  {
    name: "find_alternatives",
    description:
      "Other products that do the same job, nearest in price first.",
    parameters: {
      type: "object",
      properties: {
        product: { type: "string", description: "The product to find alternatives to." },
        max_price: { type: "number", description: "Ceiling in rupees, or 0 for none." },
      },
      required: ["product", "max_price"],
      additionalProperties: false,
    },
    spends: false,
  },
  {
    name: "find_complements",
    description:
      "Things the shop lists as going with a product.",
    parameters: {
      type: "object",
      properties: { product: { type: "string", description: "The product to build around." } },
      required: ["product"],
      additionalProperties: false,
    },
    spends: false,
  },
  {
    name: "view_cart",
    description: "What is in the shopper's cart right now, and what it comes to.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    spends: false,
  },
  {
    name: "add_to_cart",
    description:
      "Put a product in the shopper's real cart. Only when they ask.",
    parameters: {
      type: "object",
      properties: {
        product: { type: "string", description: "Number from the last list, name, or \"it\" for what they were looking at." },
        qty: { type: "number", description: "How many. 1 unless they said otherwise." },
      },
      required: ["product", "qty"],
      additionalProperties: false,
    },
    spends: false,
  },
  {
    name: "remove_from_cart",
    description: "Take a product out of the cart. Only when the shopper asks.",
    parameters: {
      type: "object",
      properties: { product: { type: "string", description: "The product to remove." } },
      required: ["product"],
      additionalProperties: false,
    },
    spends: false,
  },
  {
    name: "start_purchase",
    description:
      "Prepare a purchase for the shopper to confirm. Does NOT buy. Pass the number from search_shelf and their budget.",
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
  /**
   * What the interface should draw for this result.
   *
   * The frontend renders on this rather than parsing the reply, which is why
   * a comparison can be a table and a product can be a card instead of every
   * answer arriving as a paragraph the shopper has to read twice.
   */
  render?: "products" | "product" | "comparison" | "cart" | "none";
  /** Present only for tools that spend. Nothing happens until this is pressed. */
  proposal?: {
    label: string;
    goal: string;
    /** The exact product this proposal is for. Never a name the model composed. */
    item_id: string;
    max_price: number;
  };
}
