import Database from "better-sqlite3";
import path from "node:path";
import type { MandateChain } from "../mandates/chain.js";
import type { Clarification } from "../structuring/clarify.js";
import { CHAIN_ORDER, type Mandate, type MandateType } from "../mandates/schema.js";
import { mandateHash } from "../mandates/sign.js";

export const DB_FILE = path.resolve("data", "vyapar.db");

/**
 * Persistence for transactions and their mandates.
 *
 * Mandates are stored as the exact JSON that was signed, keyed by transaction
 * and type, with their hash alongside. Nothing is recomputed on read and no
 * field is normalised on the way in or out — a mandate that came back subtly
 * re-serialised would verify against nothing, which is the one thing this
 * table must never do to its own evidence.
 */
export class Store {
  private readonly db: Database.Database;

  constructor(file: string = DB_FILE) {
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transactions (
        transaction_id TEXT PRIMARY KEY,
        item_id        TEXT NOT NULL,
        merchant_id    TEXT NOT NULL,
        buyer_agent_id TEXT NOT NULL,
        created_at     TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS clarifications (
        clarification_id TEXT PRIMARY KEY,
        merchant_id      TEXT NOT NULL,
        item_id          TEXT NOT NULL,
        json             TEXT NOT NULL,
        status           TEXT NOT NULL,
        sent_at          TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS orders (
        transaction_id TEXT PRIMARY KEY,
        order_id       TEXT NOT NULL,
        amount_paise   INTEGER NOT NULL,
        status         TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id)
      );
      CREATE TABLE IF NOT EXISTS mandates (
        transaction_id TEXT NOT NULL,
        mandate_type   TEXT NOT NULL,
        hash           TEXT NOT NULL,
        json           TEXT NOT NULL,
        stored_at      TEXT NOT NULL,
        PRIMARY KEY (transaction_id, mandate_type),
        FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id)
      );
    `);
  }

  createTransaction(row: {
    transaction_id: string;
    item_id: string;
    merchant_id: string;
    buyer_agent_id: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO transactions (transaction_id, item_id, merchant_id, buyer_agent_id, created_at)
         VALUES (@transaction_id, @item_id, @merchant_id, @buyer_agent_id, @created_at)`,
      )
      .run({ ...row, created_at: new Date().toISOString() });
  }

  /**
   * Append a mandate. A mandate type is written once per transaction and never
   * updated — an evidence chain that can be overwritten in place is not evidence.
   */
  appendMandate(transactionId: string, mandate: Mandate): void {
    const existing = this.db
      .prepare(`SELECT hash FROM mandates WHERE transaction_id = ? AND mandate_type = ?`)
      .get(transactionId, mandate.mandate_type) as { hash: string } | undefined;

    if (existing) {
      throw new Error(
        `${mandate.mandate_type} mandate already recorded for ${transactionId} (${existing.hash.slice(0, 20)}…)`,
      );
    }

    this.db
      .prepare(
        `INSERT INTO mandates (transaction_id, mandate_type, hash, json, stored_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        transactionId,
        mandate.mandate_type,
        mandateHash(mandate),
        JSON.stringify(mandate),
        new Date().toISOString(),
      );
  }

  /**
   * An authorized order, held between the authorize and settle phases.
   *
   * One order per transaction, written once. Re-authorizing would leave two
   * open orders for one cart, and a later settle could not say which of them the
   * buyer actually paid.
   */
  saveOrder(transactionId: string, order: { order_id: string; amount_paise: number; status: string }): void {
    this.db
      .prepare(
        `INSERT INTO orders (transaction_id, order_id, amount_paise, status, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(transactionId, order.order_id, order.amount_paise, order.status, new Date().toISOString());
  }

  loadOrder(transactionId: string): { order_id: string; amount_paise: number; status: string } | undefined {
    return this.db
      .prepare(`SELECT order_id, amount_paise, status FROM orders WHERE transaction_id = ?`)
      .get(transactionId) as { order_id: string; amount_paise: number; status: string } | undefined;
  }

  // ── Clarifications (Addendum G.4) ─────────────────────────────────────────

  /** One open question per item at a time — a merchant should not get two pings about one product. */
  saveClarification(c: Clarification): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO clarifications (clarification_id, merchant_id, item_id, json, status, sent_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(c.clarification_id, c.merchant_id, c.item_id, JSON.stringify(c), c.status, c.sent_at);
  }

  listClarifications(merchantId?: string): Clarification[] {
    const rows = merchantId
      ? (this.db
          .prepare(`SELECT json FROM clarifications WHERE merchant_id = ? ORDER BY sent_at`)
          .all(merchantId) as Array<{ json: string }>)
      : (this.db.prepare(`SELECT json FROM clarifications ORDER BY sent_at`).all() as Array<{ json: string }>);
    return rows.map((r) => JSON.parse(r.json) as Clarification);
  }

  getClarification(id: string): Clarification | undefined {
    const row = this.db
      .prepare(`SELECT json FROM clarifications WHERE clarification_id = ?`)
      .get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Clarification) : undefined;
  }

  openClarificationFor(itemId: string): Clarification | undefined {
    const row = this.db
      .prepare(`SELECT json FROM clarifications WHERE item_id = ? AND status = 'open' LIMIT 1`)
      .get(itemId) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Clarification) : undefined;
  }

  /** Which transaction an order belongs to — the only handle a webhook gives us. */
  findTransactionByOrder(orderId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT transaction_id FROM orders WHERE order_id = ?`)
      .get(orderId) as { transaction_id: string } | undefined;
    return row?.transaction_id;
  }

  loadChain(transactionId: string): MandateChain | undefined {
    const txn = this.db
      .prepare(`SELECT transaction_id FROM transactions WHERE transaction_id = ?`)
      .get(transactionId) as { transaction_id: string } | undefined;
    if (!txn) return undefined;

    const rows = this.db
      .prepare(`SELECT mandate_type, json FROM mandates WHERE transaction_id = ?`)
      .all(transactionId) as Array<{ mandate_type: MandateType; json: string }>;

    const chain: MandateChain = { transaction_id: transactionId };
    for (const row of rows) {
      (chain as unknown as Record<string, Mandate>)[row.mandate_type] = JSON.parse(row.json) as Mandate;
    }
    return chain;
  }

  listTransactions(): Array<{ transaction_id: string; item_id: string; created_at: string; stages: number }> {
    return this.db
      .prepare(
        `SELECT t.transaction_id, t.item_id, t.created_at,
                (SELECT COUNT(*) FROM mandates m WHERE m.transaction_id = t.transaction_id) AS stages
         FROM transactions t ORDER BY t.created_at DESC`,
      )
      .all() as Array<{ transaction_id: string; item_id: string; created_at: string; stages: number }>;
  }

  /** The mandate types recorded so far, in chain order. */
  stagesRecorded(transactionId: string): MandateType[] {
    const rows = this.db
      .prepare(`SELECT mandate_type FROM mandates WHERE transaction_id = ?`)
      .all(transactionId) as Array<{ mandate_type: MandateType }>;
    const present = new Set(rows.map((r) => r.mandate_type));
    return CHAIN_ORDER.filter((t) => present.has(t));
  }

  close(): void {
    this.db.close();
  }
}
