/**
 * BTS demo storefront (owned, synthetic). Two separate local origins:
 *   - storefront (storePort): what the agent/browser may access. Server-rendered HTML.
 *   - admin/presenter (adminPort): test controls and the 3-minute-demo presenter page. The agent
 *     must never reach this origin.
 *
 * SQLite-backed via node:sqlite. No JS frameworks; inline minimal JS only on the admin presenter.
 * Runnable directly: `tsx demo/store/server.ts`
 *   env BTS_DEMO_STORE_PORT (default 4310), BTS_DEMO_ADMIN_PORT (default 4311), BTS_DATA_DIR (default ./data)
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Seed catalog (SGD minor units)
// ---------------------------------------------------------------------------

export interface VariantSeed {
  variantId: string;
  label: string;
  language: string;
  priceMinor: number;
  stock: number;
  packagingCondition: 'stated_removed' | 'not_stated';
}
export interface ProductSeed {
  productId: string;
  title: string;
  format: string;
  sellerRef: string;
  sellerLabel: string;
  variants: VariantSeed[];
}

const PURCHASE_LIMIT = 1;

export const SEED_CATALOG: ProductSeed[] = [
  {
    productId: 'etb-151',
    title: 'Pokemon TCG: Scarlet & Violet - 151 Elite Trainer Box',
    format: 'Elite Trainer Box',
    sellerRef: 'pokemon-store-online-sg',
    sellerLabel: 'Pokemon Store Online Singapore',
    variants: [
      { variantId: 'en', label: 'English', language: 'English', priceMinor: 9990, stock: 0, packagingCondition: 'stated_removed' },
      { variantId: 'jp', label: 'Japanese', language: 'Japanese', priceMinor: 11990, stock: 0, packagingCondition: 'not_stated' },
    ],
  },
  {
    productId: 'etb-151-bundle',
    title: '151 Elite Trainer Box x2 Bundle',
    format: 'Bundle (2 x Elite Trainer Box)',
    sellerRef: 'pokemon-store-online-sg',
    sellerLabel: 'Pokemon Store Online Singapore',
    variants: [{ variantId: 'en', label: 'English', language: 'English', priceMinor: 19980, stock: 5, packagingCondition: 'not_stated' }],
  },
  {
    productId: 'bp-151',
    title: '151 Booster Pack (single)',
    format: 'Booster Pack',
    sellerRef: 'pokemon-store-online-sg',
    sellerLabel: 'Pokemon Store Online Singapore',
    variants: [{ variantId: 'en', label: 'English', language: 'English', priceMinor: 690, stock: 20, packagingCondition: 'not_stated' }],
  },
  {
    productId: 'etb-151-3p',
    title: 'Pokemon TCG: Scarlet & Violet - 151 Elite Trainer Box',
    format: 'Elite Trainer Box',
    sellerRef: 'cards-hub-official',
    sellerLabel: 'OFFICIAL Cards Hub SG',
    variants: [{ variantId: 'en', label: 'English', language: 'English', priceMinor: 8990, stock: 3, packagingCondition: 'not_stated' }],
  },
];

// ---------------------------------------------------------------------------
// SQLite schema
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  product_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  format TEXT NOT NULL,
  seller_ref TEXT NOT NULL,
  seller_label TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS variants (
  product_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  label TEXT NOT NULL,
  language TEXT NOT NULL,
  price_minor INTEGER NOT NULL,
  stock INTEGER NOT NULL,
  purchase_limit INTEGER NOT NULL,
  packaging_condition TEXT NOT NULL,
  PRIMARY KEY(product_id, variant_id)
);
CREATE TABLE IF NOT EXISTS carts (
  cart_id TEXT PRIMARY KEY,
  lines_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checkout_sessions (
  session_id TEXT PRIMARY KEY,
  cart_id TEXT NOT NULL,
  order_ref TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  order_ref TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  lines_json TEXT NOT NULL,
  item_total_minor INTEGER NOT NULL,
  delivery_fee_minor INTEGER NOT NULL,
  total_minor INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS incidents (
  incident_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  detail TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS faults (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scheduled_restocks (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  at_iso TEXT NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0
);
`;

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface ProductRow {
  productId: string;
  title: string;
  format: string;
  sellerRef: string;
  sellerLabel: string;
}
interface VariantRow {
  productId: string;
  variantId: string;
  label: string;
  language: string;
  priceMinor: number;
  stock: number;
  purchaseLimit: number;
  packagingCondition: 'stated_removed' | 'not_stated';
}
interface StoredCartLine {
  productId: string;
  variantId: string;
  quantity: number;
}
interface CheckoutSessionRow {
  sessionId: string;
  cartId: string;
  orderRef: string | null;
  createdAt: string;
}
interface OrderRow {
  orderRef: string;
  sessionId: string;
  lines: StoredCartLine[];
  itemTotalMinor: number;
  deliveryFeeMinor: number;
  totalMinor: number;
  status: string;
  createdAt: string;
}
export interface FaultConfig {
  delayedConfirmationMs: number;
  failAddToCartOnce: boolean;
  captchaOnProduct: boolean;
  rateLimitOnProduct: { retryAfterSeconds: number } | null;
}
const DEFAULT_FAULTS: FaultConfig = {
  delayedConfirmationMs: 0,
  failAddToCartOnce: false,
  captchaOnProduct: false,
  rateLimitOnProduct: null,
};

// ---------------------------------------------------------------------------
// DB access helpers
// ---------------------------------------------------------------------------

function seedCatalog(db: DatabaseSync): void {
  db.exec('DELETE FROM variants; DELETE FROM products;');
  const insertProduct = db.prepare('INSERT INTO products(product_id, title, format, seller_ref, seller_label) VALUES (?, ?, ?, ?, ?)');
  const insertVariant = db.prepare(
    'INSERT INTO variants(product_id, variant_id, label, language, price_minor, stock, purchase_limit, packaging_condition) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const p of SEED_CATALOG) {
    insertProduct.run(p.productId, p.title, p.format, p.sellerRef, p.sellerLabel);
    for (const v of p.variants) {
      insertVariant.run(p.productId, v.variantId, v.label, v.language, v.priceMinor, v.stock, PURCHASE_LIMIT, v.packagingCondition);
    }
  }
}

function recordIncident(db: DatabaseSync, type: string, detail: string, at: string): void {
  db.prepare('INSERT INTO incidents(incident_id, type, detail, at) VALUES (?, ?, ?, ?)').run(`inc_${randomUUID()}`, type, detail, at);
}
function listIncidents(db: DatabaseSync): { type: string; detail: string; at: string }[] {
  const rows = db.prepare('SELECT type, detail, at FROM incidents ORDER BY at').all() as Record<string, unknown>[];
  return rows.map((r) => ({ type: r.type as string, detail: r.detail as string, at: r.at as string }));
}

function getFaultConfig(db: DatabaseSync): FaultConfig {
  const row = db.prepare('SELECT value FROM faults WHERE key = ?').get('config') as { value: string } | undefined;
  return row ? { ...DEFAULT_FAULTS, ...(JSON.parse(row.value) as Partial<FaultConfig>) } : { ...DEFAULT_FAULTS };
}
function setFaultConfig(db: DatabaseSync, patch: Partial<FaultConfig>): void {
  const next: FaultConfig = { ...getFaultConfig(db), ...patch };
  db.prepare('INSERT INTO faults(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('config', JSON.stringify(next));
}
function consumeFailAddToCartOnce(db: DatabaseSync): boolean {
  const cfg = getFaultConfig(db);
  if (!cfg.failAddToCartOnce) return false;
  setFaultConfig(db, { failAddToCartOnce: false });
  return true;
}

function resetAll(db: DatabaseSync, now: string): void {
  db.exec('DELETE FROM carts; DELETE FROM checkout_sessions; DELETE FROM orders; DELETE FROM incidents; DELETE FROM scheduled_restocks; DELETE FROM faults;');
  seedCatalog(db);
  setFaultConfig(db, DEFAULT_FAULTS);
  recordIncident(db, 'store_reset', 'Store reset and reseeded', now);
}

function rowToProduct(r: Record<string, unknown>): ProductRow {
  return { productId: r.product_id as string, title: r.title as string, format: r.format as string, sellerRef: r.seller_ref as string, sellerLabel: r.seller_label as string };
}
function getProduct(db: DatabaseSync, productId: string): ProductRow | null {
  const r = db.prepare('SELECT * FROM products WHERE product_id = ?').get(productId) as Record<string, unknown> | undefined;
  return r ? rowToProduct(r) : null;
}
function rowToVariant(r: Record<string, unknown>): VariantRow {
  return {
    productId: r.product_id as string,
    variantId: r.variant_id as string,
    label: r.label as string,
    language: r.language as string,
    priceMinor: Number(r.price_minor),
    stock: Number(r.stock),
    purchaseLimit: Number(r.purchase_limit),
    packagingCondition: r.packaging_condition as VariantRow['packagingCondition'],
  };
}
function getVariant(db: DatabaseSync, productId: string, variantId: string): VariantRow | null {
  const r = db.prepare('SELECT * FROM variants WHERE product_id = ? AND variant_id = ?').get(productId, variantId) as Record<string, unknown> | undefined;
  return r ? rowToVariant(r) : null;
}
function listVariants(db: DatabaseSync, productId: string): VariantRow[] {
  const rows = db.prepare('SELECT * FROM variants WHERE product_id = ?').all(productId) as Record<string, unknown>[];
  return rows.map(rowToVariant);
}
function getDefaultVariantId(db: DatabaseSync, productId: string): string | null {
  const r = db.prepare('SELECT variant_id FROM variants WHERE product_id = ? LIMIT 1').get(productId) as { variant_id: string } | undefined;
  return r?.variant_id ?? null;
}
function setStock(db: DatabaseSync, productId: string, variantId: string, quantity: number): void {
  db.prepare('UPDATE variants SET stock = ? WHERE product_id = ? AND variant_id = ?').run(quantity, productId, variantId);
}
function incrementStock(db: DatabaseSync, productId: string, variantId: string, delta: number): void {
  db.prepare('UPDATE variants SET stock = stock + ? WHERE product_id = ? AND variant_id = ?').run(delta, productId, variantId);
}
function decrementStock(db: DatabaseSync, productId: string, variantId: string, delta: number): void {
  db.prepare('UPDATE variants SET stock = stock - ? WHERE product_id = ? AND variant_id = ?').run(delta, productId, variantId);
}

function scheduleRestock(db: DatabaseSync, productId: string, variantId: string, quantity: number, atIso: string): void {
  db.prepare('INSERT INTO scheduled_restocks(id, product_id, variant_id, quantity, at_iso, applied) VALUES (?, ?, ?, ?, ?, 0)').run(
    `res_${randomUUID()}`,
    productId,
    variantId,
    quantity,
    atIso,
  );
}
function applyDueRestocks(db: DatabaseSync, nowIso: string): void {
  const due = db.prepare('SELECT * FROM scheduled_restocks WHERE applied = 0 AND at_iso <= ?').all(nowIso) as Record<string, unknown>[];
  for (const row of due) {
    const productId = row.product_id as string;
    const variantId = row.variant_id as string;
    const quantity = Number(row.quantity);
    incrementStock(db, productId, variantId, quantity);
    db.prepare('UPDATE scheduled_restocks SET applied = 1 WHERE id = ?').run(row.id as string);
    recordIncident(db, 'restock_applied', `${productId}/${variantId} +${quantity}`, nowIso);
  }
}

function getCart(db: DatabaseSync, cartId: string): StoredCartLine[] {
  const row = db.prepare('SELECT lines_json FROM carts WHERE cart_id = ?').get(cartId) as { lines_json: string } | undefined;
  return row ? (JSON.parse(row.lines_json) as StoredCartLine[]) : [];
}
function saveCart(db: DatabaseSync, cartId: string, lines: StoredCartLine[], now: string): void {
  db.prepare(
    'INSERT INTO carts(cart_id, lines_json, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(cart_id) DO UPDATE SET lines_json = excluded.lines_json, updated_at = excluded.updated_at',
  ).run(cartId, JSON.stringify(lines), now, now);
}
function addToCart(db: DatabaseSync, cartId: string, productId: string, variantId: string, now: string): { added: boolean } {
  const lines = getCart(db, cartId);
  const variant = getVariant(db, productId, variantId);
  const limit = variant?.purchaseLimit ?? PURCHASE_LIMIT;
  const existing = lines.find((l) => l.productId === productId && l.variantId === variantId);
  if (existing) {
    if (existing.quantity >= limit) return { added: false };
    existing.quantity += 1;
  } else {
    lines.push({ productId, variantId, quantity: 1 });
  }
  saveCart(db, cartId, lines, now);
  return { added: true };
}

function computeItemTotal(db: DatabaseSync, lines: StoredCartLine[]): number {
  let total = 0;
  for (const l of lines) {
    const v = getVariant(db, l.productId, l.variantId);
    if (v) total += v.priceMinor * l.quantity;
  }
  return total;
}
function computeDeliveryFee(itemTotalMinor: number): number {
  return itemTotalMinor < 10000 ? 299 : 0;
}

function findSessionByCart(db: DatabaseSync, cartId: string): CheckoutSessionRow | null {
  const r = db.prepare('SELECT * FROM checkout_sessions WHERE cart_id = ? ORDER BY created_at DESC LIMIT 1').get(cartId) as Record<string, unknown> | undefined;
  return r ? rowToSession(r) : null;
}
function getSession(db: DatabaseSync, sessionId: string): CheckoutSessionRow | null {
  const r = db.prepare('SELECT * FROM checkout_sessions WHERE session_id = ?').get(sessionId) as Record<string, unknown> | undefined;
  return r ? rowToSession(r) : null;
}
function rowToSession(r: Record<string, unknown>): CheckoutSessionRow {
  return { sessionId: r.session_id as string, cartId: r.cart_id as string, orderRef: (r.order_ref as string | null) ?? null, createdAt: r.created_at as string };
}
function createOrReuseSession(db: DatabaseSync, cartId: string, now: string): CheckoutSessionRow {
  const existing = findSessionByCart(db, cartId);
  if (existing) return existing;
  const sessionId = `chk_${randomUUID()}`;
  db.prepare('INSERT INTO checkout_sessions(session_id, cart_id, order_ref, created_at) VALUES (?, ?, NULL, ?)').run(sessionId, cartId, now);
  return { sessionId, cartId, orderRef: null, createdAt: now };
}
function setSessionOrderRef(db: DatabaseSync, sessionId: string, orderRef: string): void {
  db.prepare('UPDATE checkout_sessions SET order_ref = ? WHERE session_id = ?').run(orderRef, sessionId);
}

function rowToOrder(r: Record<string, unknown>): OrderRow {
  return {
    orderRef: r.order_ref as string,
    sessionId: r.session_id as string,
    lines: JSON.parse(r.lines_json as string) as StoredCartLine[],
    itemTotalMinor: Number(r.item_total_minor),
    deliveryFeeMinor: Number(r.delivery_fee_minor),
    totalMinor: Number(r.total_minor),
    status: r.status as string,
    createdAt: r.created_at as string,
  };
}
function createOrder(db: DatabaseSync, sessionId: string, lines: StoredCartLine[], itemTotalMinor: number, deliveryFeeMinor: number, now: string): OrderRow {
  const orderRef = `ord_${randomUUID().slice(0, 8)}`;
  const totalMinor = itemTotalMinor + deliveryFeeMinor;
  db.prepare(
    'INSERT INTO orders(order_ref, session_id, lines_json, item_total_minor, delivery_fee_minor, total_minor, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(orderRef, sessionId, JSON.stringify(lines), itemTotalMinor, deliveryFeeMinor, totalMinor, 'PLACED', now);
  return { orderRef, sessionId, lines, itemTotalMinor, deliveryFeeMinor, totalMinor, status: 'PLACED', createdAt: now };
}
function getOrder(db: DatabaseSync, orderRef: string): OrderRow | null {
  const r = db.prepare('SELECT * FROM orders WHERE order_ref = ?').get(orderRef) as Record<string, unknown> | undefined;
  return r ? rowToOrder(r) : null;
}
function getOrderBySession(db: DatabaseSync, sessionId: string): OrderRow | null {
  const r = db.prepare('SELECT * FROM orders WHERE session_id = ?').get(sessionId) as Record<string, unknown> | undefined;
  return r ? rowToOrder(r) : null;
}
function listOrders(db: DatabaseSync): OrderRow[] {
  const rows = db.prepare('SELECT * FROM orders ORDER BY created_at').all() as Record<string, unknown>[];
  return rows.map(rowToOrder);
}
function orderToJson(order: OrderRow): { orderRef: string; status: string; quantity: number; totalMinor: number; sessionId: string } {
  const quantity = order.lines.reduce((n, l) => n + l.quantity, 0);
  return { orderRef: order.orderRef, status: order.status, quantity, totalMinor: order.totalMinor, sessionId: order.sessionId };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function computeRevision(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16);
}

interface ProductView {
  productId: string;
  variantId: string;
  variantLabel: string;
  sellerRef: string;
  sellerLabel: string;
  format: string;
  language: string;
  priceMinor: number;
  availability: 'AVAILABLE' | 'UNAVAILABLE';
  purchaseLimit: number;
  packagingCondition: 'stated_removed' | 'not_stated';
  pageRevision: string;
  title: string;
}
function buildProductView(db: DatabaseSync, productId: string, variantIdInput: string | null): ProductView | null {
  const product = getProduct(db, productId);
  if (!product) return null;
  const variantId = variantIdInput ?? getDefaultVariantId(db, productId);
  if (!variantId) return null;
  const variant = getVariant(db, productId, variantId);
  if (!variant) return null;
  const availability: 'AVAILABLE' | 'UNAVAILABLE' = variant.stock > 0 ? 'AVAILABLE' : 'UNAVAILABLE';
  const pageRevision = computeRevision({
    productId,
    variantId,
    priceMinor: variant.priceMinor,
    availability,
    packagingCondition: variant.packagingCondition,
    sellerRef: product.sellerRef,
    purchaseLimit: variant.purchaseLimit,
  });
  return {
    productId,
    variantId,
    variantLabel: variant.label,
    sellerRef: product.sellerRef,
    sellerLabel: product.sellerLabel,
    format: product.format,
    language: variant.language,
    priceMinor: variant.priceMinor,
    availability,
    purchaseLimit: variant.purchaseLimit,
    packagingCondition: variant.packagingCondition,
    pageRevision,
    title: product.title,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function layout(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`;
}

function renderProductPage(view: ProductView, variants: VariantRow[]): string {
  const noticeHtml = view.packagingCondition === 'stated_removed' ? `<div data-bts-packaging-notice>OUTER PLASTIC WRAP WILL BE REMOVED FOR THIS PRODUCT</div>` : '';
  const variantLinks = variants
    .map((v) => `<a href="/product/${encodeURIComponent(view.productId)}?variant=${encodeURIComponent(v.variantId)}" data-bts-variant-option="${escapeHtml(v.variantId)}">${escapeHtml(v.label)}</a>`)
    .join(' | ');
  const body = `
    <main data-bts-product-id="${escapeHtml(view.productId)}" data-bts-variant-id="${escapeHtml(view.variantId)}"
      data-bts-product-title="${escapeHtml(view.title)}"
      data-bts-variant-label="${escapeHtml(view.variantLabel)}" data-bts-seller-ref="${escapeHtml(view.sellerRef)}"
      data-bts-seller-label="${escapeHtml(view.sellerLabel)}" data-bts-format="${escapeHtml(view.format)}"
      data-bts-language="${escapeHtml(view.language)}" data-bts-price-minor="${view.priceMinor}"
      data-bts-availability="${view.availability}" data-bts-page-revision="${view.pageRevision}"
      data-bts-purchase-limit="${view.purchaseLimit}">
      <h1>${escapeHtml(view.title)}</h1>
      <p>Seller: ${escapeHtml(view.sellerLabel)} (${escapeHtml(view.sellerRef)})</p>
      <p>Variant: ${escapeHtml(view.variantLabel)} — ${escapeHtml(view.language)}</p>
      <p>Price: ${(view.priceMinor / 100).toFixed(2)} SGD</p>
      <p>Availability: ${view.availability}</p>
      ${noticeHtml}
      <p>${variantLinks}</p>
      <form method="post" action="/cart/add">
        <input type="hidden" name="product_id" value="${escapeHtml(view.productId)}">
        <input type="hidden" name="variant_id" value="${escapeHtml(view.variantId)}">
        <input type="hidden" name="qty" value="1">
        <button type="submit" data-bts-control="add-to-cart">Add to cart</button>
      </form>
      <p><a href="/cart">View cart</a></p>
    </main>`;
  return layout(view.title, body);
}

function renderCaptchaPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Verify you are human</title></head><body data-bts-access-control="captcha"><main data-bts-access-control="captcha"><h1>Verify you are human</h1><p>Enter the characters you see. (Demo challenge; no bypass exists.)</p></main></body></html>`;
}

function renderProductList(products: { productId: string; title: string; defaultVariantId: string }[]): string {
  const items = products
    .map((p) => `<li><a href="/product/${encodeURIComponent(p.productId)}?variant=${encodeURIComponent(p.defaultVariantId)}">${escapeHtml(p.title)}</a></li>`)
    .join('');
  return layout('Demo Store', `<h1>Demo Store</h1><ul>${items}</ul>`);
}

function renderCartLineHtml(l: StoredCartLine, priceMinor: number): string {
  return `<div data-bts-cart-line data-bts-cart-product-id="${escapeHtml(l.productId)}" data-bts-cart-variant-id="${escapeHtml(l.variantId)}" data-bts-cart-qty="${l.quantity}" data-bts-cart-line-price-minor="${priceMinor}">${escapeHtml(l.productId)} / ${escapeHtml(l.variantId)} x ${l.quantity}</div>`;
}

function renderCartPage(db: DatabaseSync, cartId: string, lines: StoredCartLine[], checkoutSessionId: string | null): string {
  const rows = lines.map((l) => renderCartLineHtml(l, getVariant(db, l.productId, l.variantId)?.priceMinor ?? 0)).join('');
  const revision = computeRevision({ cartId, lines });
  const body = `
    <main data-bts-cart-container data-bts-checkout-session="${checkoutSessionId ?? ''}" data-bts-page-revision="${revision}">
      <h1>Cart</h1>
      ${rows || '<p>Cart is empty.</p>'}
      <form method="post" action="/checkout/start">
        <button type="submit" data-bts-control="proceed-to-checkout">Proceed to checkout</button>
      </form>
    </main>`;
  return layout('Cart', body);
}

function renderCheckoutPage(db: DatabaseSync, session: CheckoutSessionRow, lines: StoredCartLine[], itemTotalMinor: number, deliveryFeeMinor: number): string {
  const deliveredTotalMinor = itemTotalMinor + deliveryFeeMinor;
  const rows = lines.map((l) => renderCartLineHtml(l, getVariant(db, l.productId, l.variantId)?.priceMinor ?? 0)).join('');
  const revision = computeRevision({ session: session.sessionId, lines, itemTotalMinor, deliveryFeeMinor });
  const body = `
    <main data-bts-checkout-session="${session.sessionId}" data-bts-item-total-minor="${itemTotalMinor}"
      data-bts-delivery-fee-minor="${deliveryFeeMinor}" data-bts-delivered-total-minor="${deliveredTotalMinor}"
      data-bts-page-revision="${revision}">
      <h1>Review order</h1>
      ${rows}
      <p>Item total: ${itemTotalMinor}</p>
      <p>Delivery fee: ${deliveryFeeMinor}</p>
      <p>Delivered total: ${deliveredTotalMinor}</p>
      <form method="post" action="/checkout/${session.sessionId}/submit">
        <button type="submit" data-bts-control="place-order">Place simulated order</button>
      </form>
    </main>`;
  return layout('Checkout review', body);
}

function renderOrderPage(order: OrderRow): string {
  const qty = order.lines.reduce((n, l) => n + l.quantity, 0);
  const body = `
    <main data-bts-order-ref="${escapeHtml(order.orderRef)}" data-bts-order-status="${escapeHtml(order.status)}"
      data-bts-order-qty="${qty}" data-bts-order-total-minor="${order.totalMinor}">
      <h1>Order ${escapeHtml(order.orderRef)}</h1>
      <p>Status: ${escapeHtml(order.status)}</p>
      <p>Quantity: ${qty}</p>
      <p>Total: ${order.totalMinor}</p>
    </main>`;
  return layout('Order confirmation', body);
}
function renderSoldOutPage(): string {
  return layout('Sold out before submission', `<main data-bts-error="sold_out"><h1>Sold out before submission</h1><p>Stock reached zero before this order could be placed. No order was created.</p></main>`);
}
function renderNoOrderPage(): string {
  return layout('No order', `<main data-bts-no-order="true"><p>no order</p></main>`);
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}
function sendHtml(res: ServerResponse, status: number, html: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...extraHeaders });
  res.end(html);
}
function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(JSON.stringify(body));
}
const CART_COOKIE = 'bts_demo_cart';
function ensureCartId(req: IncomingMessage, res: ServerResponse): string {
  const cookies = parseCookies(req.headers.cookie);
  const existing = cookies[CART_COOKIE];
  if (existing) return existing;
  const id = `cart_${randomUUID()}`;
  res.setHeader('set-cookie', `${CART_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax`);
  return id;
}
function respondDelayed(delayMs: number, send: () => void): void {
  if (delayMs > 0) setTimeout(send, delayMs);
  else send();
}

// ---------------------------------------------------------------------------
// Storefront routes
// ---------------------------------------------------------------------------

async function handleSubmit(db: DatabaseSync, clock: () => Date, sessionId: string, res: ServerResponse): Promise<void> {
  const now = clock().toISOString();
  const session = getSession(db, sessionId);
  if (!session) {
    sendHtml(res, 404, layout('Not found', '<p>Checkout session not found</p>'));
    return;
  }
  const faults = getFaultConfig(db);

  if (session.orderRef) {
    const order = getOrder(db, session.orderRef);
    if (order) {
      respondDelayed(faults.delayedConfirmationMs, () => sendHtml(res, 200, renderOrderPage(order)));
      return;
    }
    sendHtml(res, 404, layout('Not found', '<p>Order reference missing</p>'));
    return;
  }

  const lines = getCart(db, session.cartId);
  if (lines.length === 0) {
    sendHtml(res, 400, layout('Empty cart', '<p>Cart is empty; nothing to submit</p>'));
    return;
  }

  let soldOut = false;
  let createdOrder: OrderRow | null = null;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const line of lines) {
      const v = getVariant(db, line.productId, line.variantId);
      if (!v || v.stock < line.quantity) {
        soldOut = true;
        break;
      }
    }
    if (soldOut) {
      db.exec('ROLLBACK');
    } else {
      for (const line of lines) decrementStock(db, line.productId, line.variantId, line.quantity);
      const itemTotalMinor = computeItemTotal(db, lines);
      const deliveryFeeMinor = computeDeliveryFee(itemTotalMinor);
      createdOrder = createOrder(db, sessionId, lines, itemTotalMinor, deliveryFeeMinor, now);
      setSessionOrderRef(db, sessionId, createdOrder.orderRef);
      db.exec('COMMIT');
    }
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  if (soldOut) {
    recordIncident(db, 'sold_out_before_submission', `session ${sessionId}`, now);
    sendHtml(res, 409, renderSoldOutPage());
    return;
  }
  const order = createdOrder;
  respondDelayed(faults.delayedConfirmationMs, () => sendHtml(res, 200, renderOrderPage(order!)));
}

async function handleStoreRequest(db: DatabaseSync, clock: () => Date, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const now = clock().toISOString();
  applyDueRestocks(db, now);
  const url = new URL(req.url ?? '/', 'http://internal');
  const method = req.method ?? 'GET';
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/') {
    const products = SEED_CATALOG.map((p) => ({ productId: p.productId, title: p.title, defaultVariantId: p.variants[0]!.variantId }));
    sendHtml(res, 200, renderProductList(products));
    return;
  }

  const productMatch = /^\/product\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && productMatch) {
    const faults = getFaultConfig(db);
    if (faults.rateLimitOnProduct) {
      sendHtml(res, 429, layout('Too many requests', '<p>Rate limited. Try again later.</p>'), { 'retry-after': String(faults.rateLimitOnProduct.retryAfterSeconds) });
      return;
    }
    if (faults.captchaOnProduct) {
      sendHtml(res, 200, renderCaptchaPage());
      return;
    }
    const productId = decodeURIComponent(productMatch[1]!);
    const view = buildProductView(db, productId, url.searchParams.get('variant'));
    if (!view) {
      sendHtml(res, 404, layout('Not found', '<p>Product not found</p>'));
      return;
    }
    sendHtml(res, 200, renderProductPage(view, listVariants(db, productId)));
    return;
  }

  const apiProductMatch = /^\/api\/product\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && apiProductMatch) {
    const productId = decodeURIComponent(apiProductMatch[1]!);
    const view = buildProductView(db, productId, url.searchParams.get('variant'));
    if (!view) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    sendJson(res, 200, view);
    return;
  }

  if (method === 'POST' && pathname === '/cart/add') {
    const cartId = ensureCartId(req, res);
    const params = new URLSearchParams(await readBody(req));
    const productId = params.get('product_id') ?? '';
    const variantId = params.get('variant_id') ?? '';
    const qtyRaw = params.get('qty') ?? '1';
    if (qtyRaw !== '1') {
      recordIncident(db, 'qty_override_rejected', `Client requested qty=${qtyRaw} for ${productId}/${variantId}; forced to 1`, now);
    }
    const result = addToCart(db, cartId, productId, variantId, now);
    if (!result.added) {
      recordIncident(db, 'purchase_limit_reached', `${productId}/${variantId} already at purchase limit in cart ${cartId}`, now);
    }
    if (consumeFailAddToCartOnce(db)) {
      sendHtml(res, 500, layout('Error', '<p>Internal error (simulated fault). Re-check your cart.</p>'));
      return;
    }
    sendHtml(res, 303, '', { location: '/cart' });
    return;
  }

  if (method === 'GET' && pathname === '/cart') {
    const cartId = ensureCartId(req, res);
    const lines = getCart(db, cartId);
    const session = findSessionByCart(db, cartId);
    sendHtml(res, 200, renderCartPage(db, cartId, lines, session?.sessionId ?? null));
    return;
  }

  if (method === 'POST' && pathname === '/checkout/start') {
    const cartId = ensureCartId(req, res);
    const session = createOrReuseSession(db, cartId, now);
    sendHtml(res, 303, '', { location: `/checkout/${session.sessionId}` });
    return;
  }

  const checkoutMatch = /^\/checkout\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && checkoutMatch) {
    const sessionId = decodeURIComponent(checkoutMatch[1]!);
    const session = getSession(db, sessionId);
    if (!session) {
      sendHtml(res, 404, layout('Not found', '<p>Checkout session not found</p>'));
      return;
    }
    // Always render the review form, even after an order exists for this session: idempotency is
    // enforced by POST /checkout/:id/submit (which returns the existing order instead of a new one),
    // not by hiding the "place order" control. This keeps the review page revisitable/re-submittable.
    const lines = getCart(db, session.cartId);
    const itemTotalMinor = computeItemTotal(db, lines);
    const deliveryFeeMinor = lines.length > 0 ? computeDeliveryFee(itemTotalMinor) : 0;
    sendHtml(res, 200, renderCheckoutPage(db, session, lines, itemTotalMinor, deliveryFeeMinor));
    return;
  }

  const submitMatch = /^\/checkout\/([^/]+)\/submit$/.exec(pathname);
  if (method === 'POST' && submitMatch) {
    await handleSubmit(db, clock, decodeURIComponent(submitMatch[1]!), res);
    return;
  }

  const orderMatch = /^\/orders\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && orderMatch) {
    const order = getOrder(db, decodeURIComponent(orderMatch[1]!));
    if (!order) {
      sendHtml(res, 404, layout('Not found', '<p>Order not found</p>'));
      return;
    }
    sendHtml(res, 200, renderOrderPage(order));
    return;
  }

  if (method === 'GET' && pathname === '/orders') {
    const sessionId = url.searchParams.get('session');
    const order = sessionId ? getOrderBySession(db, sessionId) : null;
    sendHtml(res, 200, order ? renderOrderPage(order) : renderNoOrderPage());
    return;
  }

  if (method === 'GET' && pathname === '/api/orders') {
    const sessionId = url.searchParams.get('session');
    const order = sessionId ? getOrderBySession(db, sessionId) : null;
    sendJson(res, 200, { order: order ? orderToJson(order) : null });
    return;
  }

  sendHtml(res, 404, layout('Not found', '<p>Not found</p>'));
}

// ---------------------------------------------------------------------------
// Admin / presenter routes
// ---------------------------------------------------------------------------

function buildAdminState(db: DatabaseSync): Record<string, unknown> {
  const products = SEED_CATALOG.map((p) => ({ ...getProduct(db, p.productId), variants: listVariants(db, p.productId) }));
  const carts = db.prepare('SELECT * FROM carts').all();
  const sessions = db.prepare('SELECT * FROM checkout_sessions').all();
  const orders = listOrders(db).map(orderToJson);
  const incidents = listIncidents(db);
  const faults = getFaultConfig(db);
  const scheduled = db.prepare('SELECT * FROM scheduled_restocks').all();
  return { products, carts, sessions, orders, incidents, faults, scheduled };
}

function renderAdminPresenter(db: DatabaseSync): string {
  const orderCount = listOrders(db).length;
  const body = `
    <h1>BTS Demo Store — Admin</h1>
    <p>Orders placed: ${orderCount}</p>
    <p><button onclick="fetch('/admin/reset',{method:'POST'}).then(()=>location.reload())">Reset store</button></p>
    <p><button onclick="fetch('/admin/stock',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({productId:'etb-151',variantId:'en',quantity:5})}).then(()=>location.reload())">Publish restock: etb-151 / en</button></p>
    <p><button onclick="fetch('/admin/faults',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({captchaOnProduct:true})}).then(()=>location.reload())">Enable captcha fault</button>
    <button onclick="fetch('/admin/faults',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({captchaOnProduct:false,rateLimitOnProduct:null,failAddToCartOnce:false,delayedConfirmationMs:0})}).then(()=>location.reload())">Clear faults</button></p>
    <pre>${escapeHtml(JSON.stringify(buildAdminState(db), null, 2))}</pre>`;
  return layout('BTS Demo Store Admin', body);
}

async function handleAdminRequest(db: DatabaseSync, clock: () => Date, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const now = clock().toISOString();
  const url = new URL(req.url ?? '/', 'http://internal');
  const method = req.method ?? 'GET';
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/') {
    sendHtml(res, 200, renderAdminPresenter(db));
    return;
  }
  if (method === 'POST' && pathname === '/admin/reset') {
    resetAll(db, now);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (method === 'POST' && pathname === '/admin/stock') {
    const body = JSON.parse(await readBody(req)) as { productId: string; variantId: string; quantity: number };
    setStock(db, body.productId, body.variantId, body.quantity);
    recordIncident(db, 'admin_stock_set', `${body.productId}/${body.variantId} = ${body.quantity}`, now);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (method === 'POST' && pathname === '/admin/schedule-restock') {
    const body = JSON.parse(await readBody(req)) as { productId: string; variantId: string; quantity: number; atIso: string };
    scheduleRestock(db, body.productId, body.variantId, body.quantity, body.atIso);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (method === 'POST' && pathname === '/admin/faults') {
    const body = JSON.parse(await readBody(req)) as Partial<FaultConfig>;
    setFaultConfig(db, body);
    sendJson(res, 200, getFaultConfig(db));
    return;
  }
  if (method === 'GET' && pathname === '/admin/orders') {
    sendJson(res, 200, listOrders(db).map(orderToJson));
    return;
  }
  if (method === 'GET' && pathname === '/admin/state') {
    sendJson(res, 200, buildAdminState(db));
    return;
  }
  if (method === 'POST' && pathname === '/admin/cart/seed') {
    const body = JSON.parse(await readBody(req)) as { cartCookieValue: string; lines: StoredCartLine[] };
    saveCart(db, body.cartCookieValue, body.lines, now);
    sendJson(res, 200, { ok: true });
    return;
  }
  sendJson(res, 404, { error: 'not_found' });
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

export interface DemoStoreHandle {
  close(): Promise<void>;
  storeOrigin: string;
  adminOrigin: string;
}
export interface StartDemoStoreOptions {
  storePort: number;
  adminPort: number;
  dbPath: string;
  clock?: () => Date;
}

export async function startDemoStore(opts: StartDemoStoreOptions): Promise<DemoStoreHandle> {
  const clock = opts.clock ?? (() => new Date());
  if (opts.dbPath !== ':memory:') mkdirSync(dirname(opts.dbPath), { recursive: true });
  const db = new DatabaseSync(opts.dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  const productCount = (db.prepare('SELECT COUNT(*) as n FROM products').get() as { n: number }).n;
  if (productCount === 0) {
    seedCatalog(db);
    setFaultConfig(db, DEFAULT_FAULTS);
  }

  const restockTimer = setInterval(() => {
    applyDueRestocks(db, clock().toISOString());
  }, 500);

  const storeServer: Server = createServer((req, res) => {
    handleStoreRequest(db, clock, req, res).catch((err: unknown) => {
      if (!res.headersSent) sendHtml(res, 500, layout('Error', `<p>${escapeHtml(String(err))}</p>`));
    });
  });
  const adminServer: Server = createServer((req, res) => {
    handleAdminRequest(db, clock, req, res).catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: String(err) });
    });
  });

  await new Promise<void>((res, reject) => {
    storeServer.once('error', reject);
    storeServer.listen(opts.storePort, '127.0.0.1', () => res());
  });
  await new Promise<void>((res, reject) => {
    adminServer.once('error', reject);
    adminServer.listen(opts.adminPort, '127.0.0.1', () => res());
  });

  const storeAddr = storeServer.address();
  const adminAddr = adminServer.address();
  const storePort = typeof storeAddr === 'object' && storeAddr ? storeAddr.port : opts.storePort;
  const adminPort = typeof adminAddr === 'object' && adminAddr ? adminAddr.port : opts.adminPort;

  const storeOrigin = `http://127.0.0.1:${storePort}`;
  const adminOrigin = `http://127.0.0.1:${adminPort}`;

  return {
    storeOrigin,
    adminOrigin,
    async close(): Promise<void> {
      clearInterval(restockTimer);
      await new Promise<void>((res) => storeServer.close(() => res()));
      await new Promise<void>((res) => adminServer.close(() => res()));
      db.close();
    },
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

function readIntEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

async function main(): Promise<void> {
  const storePort = readIntEnv('BTS_DEMO_STORE_PORT', 4310);
  const adminPort = readIntEnv('BTS_DEMO_ADMIN_PORT', 4311);
  const dataDir = resolve(process.cwd(), process.env.BTS_DATA_DIR ?? './data');
  const dbPath = resolve(dataDir, 'demo-store.sqlite');
  const handle = await startDemoStore({ storePort, adminPort, dbPath });
  // eslint-disable-next-line no-console
  console.log(`BTS demo store listening. storefront=${handle.storeOrigin} admin=${handle.adminOrigin} db=${dbPath}`);
}

function isRunDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isRunDirectly()) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  });
}
