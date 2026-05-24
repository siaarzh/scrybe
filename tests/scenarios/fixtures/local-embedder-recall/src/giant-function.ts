/**
 * Giant function fixture for Slice 4 chunker-token-cap test (Plan 77).
 *
 * This file contains a single large function (~200 lines) that exceeds the
 * 512-token / 2048-char budget for e5-small. The chunker-token-cap test
 * verifies that no chunk produced from this file exceeds 2048 chars when
 * chunked under the e5 preset's max_input_tokens=512 (chars = 512 * 4 = 2048).
 *
 * Content: a realistic-looking complex order processing pipeline with
 * validation, enrichment, persistence, notification, and audit steps.
 */

export interface OrderItem {
  sku: string;
  quantity: number;
  unitPrice: number;
  discount?: number;
}

export interface Order {
  orderId: string;
  customerId: string;
  items: OrderItem[];
  shippingAddress: { street: string; city: string; country: string; zip: string };
  paymentMethod: "credit_card" | "paypal" | "bank_transfer";
  currency: string;
  notes?: string;
}

export interface ProcessedOrder {
  orderId: string;
  status: "confirmed" | "failed" | "pending_payment";
  totalAmount: number;
  taxAmount: number;
  shippingCost: number;
  estimatedDelivery: Date;
  trackingNumber?: string;
  errorReason?: string;
}

/**
 * processLargeOrder — A deliberately large function that spans 200+ lines.
 *
 * Handles the full lifecycle of an order: validation, pricing, tax calculation,
 * inventory reservation, payment processing, shipping estimation, confirmation
 * email dispatch, audit log writing, and database persistence.
 *
 * This function is intentionally verbose to exceed the 512-token limit for the
 * chunker token-cap test in Plan 77 Slice 4.
 */
export async function processLargeOrder(
  order: Order,
  db: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> },
  paymentGateway: { charge: (amount: number, method: string, customerId: string) => Promise<{ success: boolean; transactionId?: string }> },
  emailService: { send: (to: string, subject: string, body: string) => Promise<void> },
  auditLogger: { log: (event: string, data: unknown) => void }
): Promise<ProcessedOrder> {
  // ─── Step 1: Basic validation ─────────────────────────────────────────────
  if (!order.orderId || order.orderId.trim() === "") {
    return { orderId: "", status: "failed", totalAmount: 0, taxAmount: 0, shippingCost: 0, estimatedDelivery: new Date(), errorReason: "missing orderId" };
  }
  if (!order.customerId || order.customerId.trim() === "") {
    return { orderId: order.orderId, status: "failed", totalAmount: 0, taxAmount: 0, shippingCost: 0, estimatedDelivery: new Date(), errorReason: "missing customerId" };
  }
  if (!Array.isArray(order.items) || order.items.length === 0) {
    return { orderId: order.orderId, status: "failed", totalAmount: 0, taxAmount: 0, shippingCost: 0, estimatedDelivery: new Date(), errorReason: "order has no items" };
  }

  // ─── Step 2: Per-item validation ──────────────────────────────────────────
  for (const item of order.items) {
    if (!item.sku || item.sku.trim() === "") {
      return { orderId: order.orderId, status: "failed", totalAmount: 0, taxAmount: 0, shippingCost: 0, estimatedDelivery: new Date(), errorReason: `item missing SKU` };
    }
    if (item.quantity <= 0 || !Number.isInteger(item.quantity)) {
      return { orderId: order.orderId, status: "failed", totalAmount: 0, taxAmount: 0, shippingCost: 0, estimatedDelivery: new Date(), errorReason: `item ${item.sku}: invalid quantity` };
    }
    if (item.unitPrice < 0) {
      return { orderId: order.orderId, status: "failed", totalAmount: 0, taxAmount: 0, shippingCost: 0, estimatedDelivery: new Date(), errorReason: `item ${item.sku}: negative unit price` };
    }
    if (item.discount !== undefined && (item.discount < 0 || item.discount > 1)) {
      return { orderId: order.orderId, status: "failed", totalAmount: 0, taxAmount: 0, shippingCost: 0, estimatedDelivery: new Date(), errorReason: `item ${item.sku}: discount out of range [0, 1]` };
    }
  }

  // ─── Step 3: Inventory check ──────────────────────────────────────────────
  const skus = order.items.map((i) => i.sku);
  const inventoryRows = await db.query(
    `SELECT sku, available_qty FROM inventory WHERE sku = ANY($1) FOR UPDATE`,
    [skus]
  ) as Array<{ sku: string; available_qty: number }>;

  const inventoryMap = new Map(inventoryRows.map((r) => [r.sku, r.available_qty]));
  for (const item of order.items) {
    const available = inventoryMap.get(item.sku) ?? 0;
    if (available < item.quantity) {
      return { orderId: order.orderId, status: "failed", totalAmount: 0, taxAmount: 0, shippingCost: 0, estimatedDelivery: new Date(), errorReason: `insufficient stock for SKU ${item.sku}: need ${item.quantity}, have ${available}` };
    }
  }

  // ─── Step 4: Subtotal + discount computation ──────────────────────────────
  let subtotal = 0;
  for (const item of order.items) {
    const lineTotal = item.unitPrice * item.quantity;
    const discountAmount = item.discount ? lineTotal * item.discount : 0;
    subtotal += lineTotal - discountAmount;
  }

  // ─── Step 5: Tax calculation (simplified rule: 20% for EU, 10% elsewhere) ─
  const euCountries = new Set(["DE", "FR", "ES", "IT", "NL", "BE", "PL", "SE", "AT", "CH"]);
  const country = order.shippingAddress.country.toUpperCase();
  const taxRate = euCountries.has(country) ? 0.20 : 0.10;
  const taxAmount = Math.round(subtotal * taxRate * 100) / 100;

  // ─── Step 6: Shipping cost estimation ─────────────────────────────────────
  const totalWeight = order.items.reduce((sum, i) => sum + i.quantity * 0.5, 0); // assume 0.5 kg/unit
  let shippingCost: number;
  if (country === "US") {
    shippingCost = totalWeight <= 2 ? 5.99 : totalWeight <= 10 ? 12.99 : 24.99;
  } else if (euCountries.has(country)) {
    shippingCost = totalWeight <= 1 ? 3.99 : totalWeight <= 5 ? 8.99 : 19.99;
  } else {
    shippingCost = totalWeight <= 1 ? 14.99 : totalWeight <= 5 ? 29.99 : 59.99;
  }

  const totalAmount = Math.round((subtotal + taxAmount + shippingCost) * 100) / 100;

  // ─── Step 7: Delivery date estimation ────────────────────────────────────
  const today = new Date();
  const deliveryDays = country === "US" ? 5 : euCountries.has(country) ? 3 : 14;
  const estimatedDelivery = new Date(today.getTime() + deliveryDays * 24 * 60 * 60 * 1000);

  // ─── Step 8: Payment processing ──────────────────────────────────────────
  let transactionId: string | undefined;
  if (order.paymentMethod !== "bank_transfer") {
    const chargeResult = await paymentGateway.charge(totalAmount, order.paymentMethod, order.customerId);
    if (!chargeResult.success) {
      auditLogger.log("payment_failed", { orderId: order.orderId, customerId: order.customerId, amount: totalAmount, method: order.paymentMethod });
      return { orderId: order.orderId, status: "failed", totalAmount, taxAmount, shippingCost, estimatedDelivery, errorReason: "payment declined" };
    }
    transactionId = chargeResult.transactionId;
  }

  // ─── Step 9: Inventory reservation ───────────────────────────────────────
  for (const item of order.items) {
    await db.query(
      `UPDATE inventory SET reserved_qty = reserved_qty + $1, available_qty = available_qty - $1 WHERE sku = $2`,
      [item.quantity, item.sku]
    );
  }

  // ─── Step 10: Order persistence ───────────────────────────────────────────
  await db.query(
    `INSERT INTO orders (order_id, customer_id, status, total_amount, tax_amount, shipping_cost, currency, transaction_id, estimated_delivery, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
    [order.orderId, order.customerId, "confirmed", totalAmount, taxAmount, shippingCost, order.currency, transactionId ?? null, estimatedDelivery]
  );

  for (const item of order.items) {
    await db.query(
      `INSERT INTO order_items (order_id, sku, quantity, unit_price, discount) VALUES ($1, $2, $3, $4, $5)`,
      [order.orderId, item.sku, item.quantity, item.unitPrice, item.discount ?? 0]
    );
  }

  // ─── Step 11: Confirmation email ──────────────────────────────────────────
  const customerRows = await db.query(
    `SELECT email, first_name FROM customers WHERE customer_id = $1`,
    [order.customerId]
  ) as Array<{ email: string; first_name: string }>;

  if (customerRows.length > 0) {
    const customer = customerRows[0];
    const itemsSummary = order.items
      .map((i) => `  - ${i.sku} x${i.quantity} @ ${i.unitPrice} ${order.currency}`)
      .join("\n");
    const emailBody = [
      `Dear ${customer.first_name},`,
      ``,
      `Thank you for your order ${order.orderId}.`,
      ``,
      `Items ordered:`,
      itemsSummary,
      ``,
      `Subtotal: ${subtotal.toFixed(2)} ${order.currency}`,
      `Tax (${(taxRate * 100).toFixed(0)}%): ${taxAmount.toFixed(2)} ${order.currency}`,
      `Shipping: ${shippingCost.toFixed(2)} ${order.currency}`,
      `Total: ${totalAmount.toFixed(2)} ${order.currency}`,
      ``,
      `Estimated delivery: ${estimatedDelivery.toDateString()}`,
      ``,
      `Best regards,`,
      `The Order Team`,
    ].join("\n");

    await emailService.send(customer.email, `Order Confirmation: ${order.orderId}`, emailBody);
  }

  // ─── Step 12: Audit log ───────────────────────────────────────────────────
  auditLogger.log("order_confirmed", {
    orderId: order.orderId,
    customerId: order.customerId,
    totalAmount,
    taxAmount,
    shippingCost,
    itemCount: order.items.length,
    paymentMethod: order.paymentMethod,
    transactionId,
    country,
    estimatedDelivery: estimatedDelivery.toISOString(),
  });

  return {
    orderId: order.orderId,
    status: order.paymentMethod === "bank_transfer" ? "pending_payment" : "confirmed",
    totalAmount,
    taxAmount,
    shippingCost,
    estimatedDelivery,
    trackingNumber: transactionId ? `TRK-${transactionId.slice(0, 8).toUpperCase()}` : undefined,
  };
}
