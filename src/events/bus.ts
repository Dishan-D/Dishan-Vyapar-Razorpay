import type { Server as IOServer } from "socket.io";

export type EventType =
  | "extraction.completed"
  | "extraction.held"
  | "clarification.sent"
  | "clarification.resolved"
  | "discovery.queried"
  | "negotiation.offer_made"
  | "negotiation.countered"
  | "negotiation.agreed"
  | "negotiation.no_deal"
  | "payment.order_created"
  | "payment.captured"
  | "fulfillment.confirmed"
  | "audit.chain_verified";

export interface VyaparEvent {
  type: EventType;
  at: string;
  transaction_id?: string;
  merchant_id?: string;
  item_id?: string;
  /** Human-readable one-liner, so a viewer never has to decode the payload. */
  message: string;
  data?: Record<string, unknown>;
}

const BUFFER = 500;

/** Sockets watching the whole market rather than one merchant or transaction. */
export const ROOM_ALL = "all";

/**
 * A publish layer over state changes that already happen.
 *
 * Deliberately not wired into the pipeline modules: negotiation, payment and
 * the mandate chain know nothing about this, and the server emits where it
 * already writes to SQLite. Anything else would put a display concern inside
 * the logic it displays, and a broken socket could then break a payment.
 *
 * Events are buffered so a dashboard opened halfway through a transaction shows
 * what it missed instead of an empty panel.
 */
export class EventBus {
  private io: IOServer | null = null;
  private readonly buffer: VyaparEvent[] = [];
  private readonly listeners = new Set<(e: VyaparEvent) => void>();

  attach(io: IOServer): void {
    this.io = io;
  }

  emit(event: Omit<VyaparEvent, "at"> & { at?: string }): VyaparEvent {
    const full: VyaparEvent = { ...event, at: event.at ?? new Date().toISOString() };

    this.buffer.push(full);
    if (this.buffer.length > BUFFER) this.buffer.shift();

    for (const l of this.listeners) l(full);

    if (this.io) {
      // One emit across every room that should see it. Socket.io delivers once
      // per socket even when it is in several of these rooms — emitting to a
      // broadcast *and* to the rooms separately, as an earlier version did,
      // delivered every event twice to anyone watching a specific merchant.
      const rooms = [ROOM_ALL];
      if (full.transaction_id) rooms.push(`txn:${full.transaction_id}`);
      if (full.merchant_id) rooms.push(`merchant:${full.merchant_id}`);
      this.io.to(rooms).emit("event", full);
    }

    return full;
  }

  /** Replay, for a viewer who arrived late. */
  recent(filter?: { transaction_id?: string; merchant_id?: string; limit?: number }): VyaparEvent[] {
    const limit = filter?.limit ?? 100;
    return this.buffer
      .filter(
        (e) =>
          (!filter?.transaction_id || e.transaction_id === filter.transaction_id) &&
          (!filter?.merchant_id || e.merchant_id === filter.merchant_id),
      )
      .slice(-limit);
  }

  /** In-process subscription, for scripts that have no socket. */
  on(listener: (e: VyaparEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
