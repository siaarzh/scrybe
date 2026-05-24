/**
 * Outbound webhook delivery with HMAC signature verification.
 * Webhooks are signed so receiving servers can verify authenticity.
 */
import crypto from "crypto";

export interface WebhookEndpoint {
  id: string;
  url: string;
  secret: string;
  events: string[];   // e.g., ["user.created", "payment.succeeded"]
  enabled: boolean;
  createdAt: number;
}

export interface WebhookEvent {
  id: string;
  type: string;
  timestamp: number;
  data: unknown;
}

export interface WebhookDelivery {
  webhookId: string;
  eventId: string;
  deliveredAt: number;
  statusCode: number;
  responseBody: string;
  attempt: number;
  success: boolean;
}

/**
 * Compute the HMAC-SHA256 signature for a webhook payload.
 * Signature format: "sha256={hex_digest}" (GitHub-compatible).
 */
export function computeSignature(payload: string, secret: string): string {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(payload);
  return `sha256=${hmac.digest("hex")}`;
}

/**
 * Verify that an incoming webhook signature matches the expected value.
 * Uses constant-time comparison to prevent timing attacks.
 */
export function verifySignature(payload: string, secret: string, signature: string): boolean {
  const expected = computeSignature(payload, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Dispatch a webhook event to all matching registered endpoints.
 * Returns an array of delivery results.
 */
export async function dispatchWebhook(
  endpoints: WebhookEndpoint[],
  event: WebhookEvent,
  attempt = 1
): Promise<WebhookDelivery[]> {
  const matching = endpoints.filter(
    (ep) => ep.enabled && (ep.events.includes("*") || ep.events.includes(event.type))
  );

  const payload = JSON.stringify(event);
  const deliveries = await Promise.all(
    matching.map(async (endpoint): Promise<WebhookDelivery> => {
      const signature = computeSignature(payload, endpoint.secret);
      let statusCode = 0;
      let responseBody = "";

      try {
        const resp = await fetch(endpoint.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Signature": signature,
            "X-Webhook-Event": event.type,
            "X-Webhook-Delivery": event.id,
          },
          body: payload,
        });
        statusCode = resp.status;
        responseBody = await resp.text();
      } catch (err) {
        responseBody = err instanceof Error ? err.message : String(err);
      }

      return {
        webhookId: endpoint.id,
        eventId: event.id,
        deliveredAt: Date.now(),
        statusCode,
        responseBody,
        attempt,
        success: statusCode >= 200 && statusCode < 300,
      };
    })
  );

  return deliveries;
}
