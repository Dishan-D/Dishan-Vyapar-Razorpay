import { randomUUID } from "node:crypto";

/**
 * An action the merchant approved, executed at most once.
 *
 * The retry that makes this necessary is not hypothetical. A confirmation
 * travels over a network, from a phone, on a shop's connection: the press
 * lands, the response does not, and the merchant presses again. Without a
 * record of what has already run, the second press marks the same order handed
 * over twice, or issues a second invoice for one sale.
 *
 * So a proposal is minted with an id before the merchant ever sees it, and that
 * id is what comes back on approval. Executing it stores the result; asking
 * again returns the stored result rather than doing the work a second time.
 * The merchant sees the same confirmation either way, which is the point —
 * from their side a double press should simply look like it worked.
 *
 * In memory, with a ceiling, because a proposal nobody approved within a
 * session is not worth persisting. Anything that mattered became a signed
 * mandate the moment it ran, and that is on disk.
 */

export type ActionStatus = "pending" | "running" | "done" | "failed";

export interface MerchantAction {
  action_id: string;
  merchant_id: string;
  conversation_id: string;
  tool: string;
  args: Record<string, unknown>;
  /** What the merchant is being asked to approve, in their words. */
  summary: string;
  /** The irreversible ones say so on the button. */
  confirm: boolean;
  status: ActionStatus;
  created_at: string;
  settled_at?: string;
  result?: unknown;
  error?: string;
}

const MAX_ACTIONS = 500;
const actions = new Map<string, MerchantAction>();

export function propose(row: {
  merchant_id: string;
  conversation_id: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  confirm: boolean;
}): MerchantAction {
  const action: MerchantAction = {
    action_id: `act_${randomUUID().slice(0, 12)}`,
    ...row,
    status: "pending",
    created_at: new Date().toISOString(),
  };
  actions.set(action.action_id, action);
  if (actions.size > MAX_ACTIONS) {
    const oldest = actions.keys().next().value;
    if (oldest) actions.delete(oldest);
  }
  return action;
}

export const get = (id: string): MerchantAction | undefined => actions.get(id);

export function listFor(merchantId: string): MerchantAction[] {
  return [...actions.values()]
    .filter((a) => a.merchant_id === merchantId)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

/**
 * Run an approved action, once.
 *
 * Four outcomes, and the caller needs to tell them apart: it ran now, it had
 * already run and this is the earlier result, it is running on another request,
 * or it failed. Reporting the second as though it were the first is what makes
 * a double press safe; reporting the fourth as the first is the fabrication
 * this whole project is written against.
 */
export async function execute(
  actionId: string,
  run: (a: MerchantAction) => Promise<unknown>,
): Promise<{ action: MerchantAction; replayed: boolean }> {
  const action = actions.get(actionId);
  if (!action) throw new Error(`no such action: ${actionId}`);

  if (action.status === "done" || action.status === "failed") {
    return { action, replayed: true };
  }
  // A second request while the first is still in flight must not start the work
  // again. It is told the truth — this is already happening — rather than being
  // quietly queued behind a duplicate.
  if (action.status === "running") return { action, replayed: true };

  action.status = "running";
  try {
    action.result = await run(action);
    action.status = "done";
  } catch (err) {
    action.status = "failed";
    action.error = err instanceof Error ? err.message : String(err);
  }
  action.settled_at = new Date().toISOString();
  return { action, replayed: false };
}

export function cancel(actionId: string): MerchantAction | undefined {
  const a = actions.get(actionId);
  if (a && a.status === "pending") {
    a.status = "failed";
    a.error = "cancelled by the merchant";
    a.settled_at = new Date().toISOString();
  }
  return a;
}
