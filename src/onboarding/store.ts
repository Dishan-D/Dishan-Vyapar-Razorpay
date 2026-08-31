import Database from "better-sqlite3";
import type { CatalogItem, NegotiationPolicy } from "../mandates/schema.js";
import type { Merchant } from "../structuring/run.js";

export interface OnboardedInput {
  kind: "photo" | "voice" | "text";
  value: string;
  added_at: string;
}

export interface OnboardedMerchant extends Merchant {
  onboarded: true;
  store_summary: string | null;
  created_at: string;
}

/**
 * Shops created during the demo, as opposed to the three seeded ones.
 *
 * Kept in the same database as everything else rather than written back into
 * data/merchants.json: the seed file is the repo's fixture and should stay
 * reproducible, while a shop somebody onboards on stage is runtime state that
 * ought to disappear when the database is reset between takes.
 */
export class OnboardingStore {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS onboarded_merchants (
        merchant_id   TEXT PRIMARY KEY,
        json          TEXT NOT NULL,
        created_at    TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS onboarded_inputs (
        merchant_id   TEXT NOT NULL,
        kind          TEXT NOT NULL,
        value         TEXT NOT NULL,
        added_at      TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS onboarded_items (
        item_id       TEXT PRIMARY KEY,
        merchant_id   TEXT NOT NULL,
        json          TEXT NOT NULL,
        policy_json   TEXT,
        photo_url     TEXT
      );
    `);
  }

  createMerchant(merchant: OnboardedMerchant): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO onboarded_merchants (merchant_id, json, created_at) VALUES (?, ?, ?)`)
      .run(merchant.merchant_id, JSON.stringify(merchant), merchant.created_at);
  }

  updateMerchant(merchant: OnboardedMerchant): void {
    this.createMerchant(merchant);
  }

  listMerchants(): OnboardedMerchant[] {
    return (this.db.prepare(`SELECT json FROM onboarded_merchants ORDER BY created_at`).all() as Array<{ json: string }>)
      .map((r) => JSON.parse(r.json) as OnboardedMerchant);
  }

  getMerchant(id: string): OnboardedMerchant | undefined {
    const row = this.db.prepare(`SELECT json FROM onboarded_merchants WHERE merchant_id = ?`).get(id) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as OnboardedMerchant) : undefined;
  }

  addInput(merchantId: string, input: OnboardedInput): void {
    this.db
      .prepare(`INSERT INTO onboarded_inputs (merchant_id, kind, value, added_at) VALUES (?, ?, ?, ?)`)
      .run(merchantId, input.kind, input.value, input.added_at);
  }

  listInputs(merchantId: string): OnboardedInput[] {
    return this.db
      .prepare(`SELECT kind, value, added_at FROM onboarded_inputs WHERE merchant_id = ? ORDER BY added_at`)
      .all(merchantId) as OnboardedInput[];
  }

  /** Replaces the shop's whole catalog — structuring is re-run, not merged. */
  replaceItems(
    merchantId: string,
    rows: Array<{ item: CatalogItem; policy?: NegotiationPolicy; photo_url?: string }>,
  ): void {
    const del = this.db.prepare(`DELETE FROM onboarded_items WHERE merchant_id = ?`);
    const ins = this.db.prepare(
      `INSERT INTO onboarded_items (item_id, merchant_id, json, policy_json, photo_url) VALUES (?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      del.run(merchantId);
      for (const r of rows) {
        ins.run(r.item.item_id, merchantId, JSON.stringify(r.item), r.policy ? JSON.stringify(r.policy) : null, r.photo_url ?? null);
      }
    })();
  }

  listItems(): Array<{ item: CatalogItem; policy?: NegotiationPolicy; photo_url?: string }> {
    return (
      this.db.prepare(`SELECT json, policy_json, photo_url FROM onboarded_items`).all() as Array<{
        json: string;
        policy_json: string | null;
        photo_url: string | null;
      }>
    ).map((r) => ({
      item: JSON.parse(r.json) as CatalogItem,
      ...(r.policy_json ? { policy: JSON.parse(r.policy_json) as NegotiationPolicy } : {}),
      ...(r.photo_url ? { photo_url: r.photo_url } : {}),
    }));
  }

  deleteItem(itemId: string): void {
    this.db.prepare(`DELETE FROM onboarded_items WHERE item_id = ?`).run(itemId);
  }

  /** One item's stored state, for a targeted update. */
  saveItem(row: { item: CatalogItem; policy?: NegotiationPolicy; photo_url?: string }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO onboarded_items (item_id, merchant_id, json, policy_json, photo_url) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        row.item.item_id,
        row.item.merchant_id,
        JSON.stringify(row.item),
        row.policy ? JSON.stringify(row.policy) : null,
        row.photo_url ?? null,
      );
  }
}
