export interface SeedPlan {
  merchant_id: string;
  want: string;
  max_price: number;
  opening_offer: number;
  /** Whether the merchant confirms handover. Some deliberately do not. */
  confirm: boolean;
}

/**
 * Trading history for the three personas.
 *
 * Rafiq leaves two sales unconfirmed on purpose — his readiness score is
 * supposed to sit below Meena's, and it has to sit there because of something
 * that actually happened in the data, not a number typed into a seed file.
 */
export const SEED_PLANS: SeedPlan[] = [
  // Meena's Sarees — confirms everything.
  { merchant_id: "mer_meena", want: "Blue Cotton Saree", max_price: 1500, opening_offer: 1100, confirm: true },
  { merchant_id: "mer_meena", want: "White Cotton Kurta", max_price: 800, opening_offer: 600, confirm: true },
  { merchant_id: "mer_meena", want: "Cotton Towel Set", max_price: 500, opening_offer: 430, confirm: true },
  { merchant_id: "mer_meena", want: "Blue Cotton Saree", max_price: 1400, opening_offer: 1150, confirm: true },

  // Rafiq Mobile Accessories — wide band, and two handovers never confirmed.
  { merchant_id: "mer_rafiq", want: "Silicone Phone Case", max_price: 300, opening_offer: 150, confirm: true },
  { merchant_id: "mer_rafiq", want: "Type-C Fast Charger", max_price: 500, opening_offer: 300, confirm: true },
  { merchant_id: "mer_rafiq", want: "Wired Earphones", max_price: 400, opening_offer: 200, confirm: true },
  { merchant_id: "mer_rafiq", want: "Tempered Glass Screen Guard", max_price: 200, opening_offer: 90, confirm: false },
  { merchant_id: "mer_rafiq", want: "Silicone Phone Case", max_price: 300, opening_offer: 160, confirm: false },

  // Amma's Snacks — small basket, all confirmed.
  { merchant_id: "mer_amma", want: "Murukku Packet", max_price: 120, opening_offer: 80, confirm: true },
  { merchant_id: "mer_amma", want: "Kaara Mixture Packet", max_price: 140, opening_offer: 95, confirm: true },
  { merchant_id: "mer_amma", want: "Laddu Box", max_price: 150, opening_offer: 105, confirm: true },
];

export interface SeedOutcome {
  merchant_id: string;
  want: string;
  status: "fulfilled" | "paid" | "no_deal" | "not_found";
  transaction_id?: string;
  final_price?: number;
}

type Fetcher = (path: string, init?: RequestInit) => Promise<{ status: number; body: any }>;

/** Run the seed plans through the live API, exactly as a buyer-agent would. */
export async function seedHistory(api: Fetcher, plans: readonly SeedPlan[] = SEED_PLANS): Promise<SeedOutcome[]> {
  const out: SeedOutcome[] = [];

  for (const plan of plans) {
    const { status, body } = await api("/transactions", {
      method: "POST",
      body: JSON.stringify({
        want: plan.want,
        max_price: plan.max_price,
        opening_offer: plan.opening_offer,
      }),
    });

    if (status === 404) {
      out.push({ merchant_id: plan.merchant_id, want: plan.want, status: "not_found" });
      continue;
    }
    if (body.status === "no_deal") {
      out.push({ merchant_id: plan.merchant_id, want: plan.want, status: "no_deal" });
      continue;
    }
    if (status !== 201) {
      out.push({ merchant_id: plan.merchant_id, want: plan.want, status: "not_found" });
      continue;
    }

    const txn = body.transaction_id as string;
    if (plan.confirm) {
      await api(`/transactions/${txn}/confirm-fulfillment`, {
        method: "POST",
        body: JSON.stringify({ evidence_note: "Handed over at the shop" }),
      });
    }

    out.push({
      merchant_id: plan.merchant_id,
      want: plan.want,
      status: plan.confirm ? "fulfilled" : "paid",
      transaction_id: txn,
      final_price: body.final_price,
    });
  }

  return out;
}
