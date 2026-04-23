export interface ProviderSpec {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface ValidateResult {
  ok: boolean;
  dimensions?: number;
  model?: string;
  errorType?: "auth" | "rate_limit" | "network" | "dns" | "dimensions_unknown" | "bad_url" | "other";
  message?: string;
  rawStatus?: number;
}

const TIMEOUT_MS = 30_000;

export async function validateProvider(spec: ProviderSpec): Promise<ValidateResult> {
  let url: URL;
  try {
    const base = spec.baseUrl.replace(/\/$/, "");
    url = new URL(`${base}/embeddings`);
  } catch {
    return { ok: false, errorType: "bad_url", message: `Invalid base URL: ${spec.baseUrl}` };
  }

  const body = JSON.stringify({ model: spec.model, input: ["ping"] });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${spec.apiKey}`,
      },
      body,
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timer);
    const msg: string = err?.message ?? String(err);
    if (msg.includes("ENOTFOUND") || msg.includes("getaddrinfo")) {
      return { ok: false, errorType: "dns", message: `DNS lookup failed for ${url.hostname}` };
    }
    if (err?.name === "AbortError") {
      return { ok: false, errorType: "network", message: `Request timed out after ${TIMEOUT_MS / 1000}s` };
    }
    return { ok: false, errorType: "network", message: msg };
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 401 || resp.status === 403) {
    return { ok: false, errorType: "auth", rawStatus: resp.status, message: "Invalid or missing API key" };
  }
  if (resp.status === 429) {
    return { ok: false, errorType: "rate_limit", rawStatus: resp.status, message: "Rate limited — try again in a moment" };
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return { ok: false, errorType: "other", rawStatus: resp.status, message: text.slice(0, 200) || `HTTP ${resp.status}` };
  }

  let data: any;
  try {
    data = await resp.json();
  } catch {
    return { ok: false, errorType: "other", message: "Response was not valid JSON" };
  }

  const vector = data?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) {
    return { ok: false, errorType: "dimensions_unknown", message: "Response missing embedding array" };
  }

  return {
    ok: true,
    dimensions: vector.length,
    model: data?.model ?? spec.model,
  };
}
