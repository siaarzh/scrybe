/**
 * Push notification service using Web Push (VAPID) protocol.
 * Sends browser push notifications to subscribed endpoints.
 */
import crypto from "crypto";

export interface VapidKeys {
  publicKey: string;  // base64url-encoded P-256 public key
  privateKey: string; // base64url-encoded P-256 private key
}

export interface PushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;  // client's public key (base64url)
    auth: string;    // client authentication secret (base64url)
  };
}

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;     // deduplication tag; same-tag notifications replace each other
  data?: unknown;
}

export interface PushResult {
  subscription: string;  // endpoint URL
  statusCode: number;
  error?: string;
}

/**
 * Generate a new VAPID key pair for server identification.
 * Keys should be stored in env and reused — rotating them invalidates existing subscriptions.
 */
export function generateVapidKeys(): VapidKeys {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  return {
    publicKey: publicKey.toString("base64url"),
    privateKey: privateKey.toString("base64url"),
  };
}

/**
 * Send a push notification to a single subscriber.
 * Handles Web Push protocol headers and VAPID authentication.
 * This is a stub — real impl would use the `web-push` npm package.
 */
export async function sendPushNotification(
  subscription: PushSubscription,
  payload: PushPayload,
  vapid: VapidKeys,
  subject: string  // mailto: or https: URL identifying the sender
): Promise<PushResult> {
  void vapid;
  void subject;

  const body = JSON.stringify(payload);
  try {
    const resp = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "TTL": "86400",
        // Real impl would compute VAPID JWT and encrypted body here
        "Authorization": "vapid t=stub,k=stub",
      },
      body,
    });
    return { subscription: subscription.endpoint, statusCode: resp.status };
  } catch (err) {
    return {
      subscription: subscription.endpoint,
      statusCode: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Broadcast a push notification to multiple subscribers.
 * Returns individual results and a summary.
 */
export async function broadcastPush(
  subscriptions: PushSubscription[],
  payload: PushPayload,
  vapid: VapidKeys,
  subject: string
): Promise<{ results: PushResult[]; sent: number; failed: number }> {
  const results = await Promise.all(
    subscriptions.map((s) => sendPushNotification(s, payload, vapid, subject))
  );
  const sent = results.filter((r) => r.statusCode >= 200 && r.statusCode < 300).length;
  return { results, sent, failed: results.length - sent };
}
