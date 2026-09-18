/**
 * Adapter contracts. The worker depends on these, never on Playwright or Lazada directly.
 * Names are BTS application interfaces, not retailer API endpoints.
 */
import type { Observation, PurchaseIntent, Provenance } from '../domain/types.ts';
import type { CartLine } from '../domain/policy.ts';

export interface ObserveRequest {
  missionId: string;
  intent: PurchaseIntent;
  now: string;
}

export interface ObservationAdapter {
  readonly name: string;
  readonly provenance: Provenance;
  /** The origin this adapter touches, for shared per-origin limits. */
  readonly origin: string;
  observeTarget(req: ObserveRequest): Promise<Observation>;
}

export interface CartState {
  lines: CartLine[];
  deliveryFeeMinor: number | null;
  itemTotalMinor: number | null;
  deliveredTotalMinor: number | null;
  /** Merchant checkout session identifier when one exists (demo store issues one per cart). */
  checkoutSessionId: string | null;
  pageRevision: string;
}

export type ExecutorStepResult<T> = { ok: true; value: T } | { ok: false; error: string; outcomeUnclear: boolean };

/**
 * Preparation executor: individually validated, non-submitting operations.
 * `submitDemoOrder` exists only on the demo executor registration; there is no live counterpart.
 */
export interface PreparationExecutor {
  readonly mode: 'demo' | 'lazada_prepare';
  readonly origin: string;
  readCart(intent: PurchaseIntent): Promise<ExecutorStepResult<CartState>>;
  /** Add exactly one of the approved target. Must detect existing quantity first (A14). */
  addOneToCart(intent: PurchaseIntent): Promise<ExecutorStepResult<CartState>>;
  /** Open checkout review and read the delivered total. Non-submitting. */
  reviewCheckout(intent: PurchaseIntent, checkoutSessionId: string): Promise<ExecutorStepResult<CartState>>;
  /** Look up an order by checkout session without changing anything. */
  findOrderForSession(checkoutSessionId: string): Promise<ExecutorStepResult<{ orderRef: string; status: string; quantity: number; totalMinor: number } | null>>;
  close(): Promise<void>;
}

export interface DemoSubmissionExecutor extends PreparationExecutor {
  readonly mode: 'demo';
  /** Simulated purchase. Caller must have persisted SUBMISSION_STARTED first. */
  submitDemoOrder(intent: PurchaseIntent, checkoutSessionId: string): Promise<ExecutorStepResult<{ orderRef: string; status: string; quantity: number; totalMinor: number }>>;
}

export function isDemoSubmissionExecutor(x: PreparationExecutor): x is DemoSubmissionExecutor {
  return x.mode === 'demo' && typeof (x as DemoSubmissionExecutor).submitDemoOrder === 'function';
}
