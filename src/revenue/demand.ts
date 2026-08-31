import type Database from "better-sqlite3";

export interface DemandEvent {
  at: string;
  want: string;
  max_price: number;
  merchant_id: string | null;
  item_id: string | null;
  /** What happened to this shop in this search. */
  outcome: "sold" | "lost_on_price" | "lost_on_readiness" | "no_match" | "held";
  asked_price: number | null;
  offered_price: number | null;
  /** Where the buyer started bargaining — needed to replay the haggle faithfully. */
  opening_offer: number | null;
  detail: string | null;
}

/**
 * What AI buyers looked for, and what the shop lost.
 *
 * Recorded as it happens rather than inferred later. Every recommendation this
 * powers has to be traceable to specific searches — a merchant being told to
 * drop their floor deserves to see the eleven buyers who walked, not a number
 * a model felt was about right.
 */
export class DemandLog {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS demand (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        at            TEXT NOT NULL,
        want          TEXT NOT NULL,
        max_price     REAL NOT NULL,
        merchant_id   TEXT,
        item_id       TEXT,
        outcome       TEXT NOT NULL,
        asked_price   REAL,
        offered_price REAL,
        opening_offer REAL,
        detail        TEXT
      );
      CREATE INDEX IF NOT EXISTS demand_merchant ON demand(merchant_id);
    `);
  }

  record(event: DemandEvent): void {
    this.db
      .prepare(
        `INSERT INTO demand (at, want, max_price, merchant_id, item_id, outcome, asked_price, offered_price, opening_offer, detail)
         VALUES (@at, @want, @max_price, @merchant_id, @item_id, @outcome, @asked_price, @offered_price, @opening_offer, @detail)`,
      )
      .run(event);
  }

  forMerchant(merchantId: string, sinceIso?: string): DemandEvent[] {
    return this.db
      .prepare(
        `SELECT at, want, max_price, merchant_id, item_id, outcome, asked_price, offered_price, opening_offer, detail
         FROM demand WHERE merchant_id = ? AND at >= ? ORDER BY at DESC`,
      )
      .all(merchantId, sinceIso ?? "1970-01-01") as DemandEvent[];
  }

  all(sinceIso?: string): DemandEvent[] {
    return this.db
      .prepare(
        `SELECT at, want, max_price, merchant_id, item_id, outcome, asked_price, offered_price, opening_offer, detail
         FROM demand WHERE at >= ? ORDER BY at DESC`,
      )
      .all(sinceIso ?? "1970-01-01") as DemandEvent[];
  }
}
