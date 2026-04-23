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
  coldStartMs?: number; // local provider only
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

/**
 * Validates the local WASM/ONNX embedder by loading the pipeline and running a test inference.
 * No network call if the model is already cached. Returns dimensions and cold-start time.
 */
export async function validateLocal(modelId: string): Promise<ValidateResult> {
  const t0 = Date.now();
  try {
    const { pipeline } = await import("@xenova/transformers");
    const extractor = await pipeline("feature-extraction", modelId, { revision: "main" });
    const output: any = await extractor(["ping"], { pooling: "mean", normalize: true });
    const dims = (output[0].data as Float32Array).length;
    const coldStartMs = Date.now() - t0;
    return { ok: true, dimensions: dims, model: modelId, coldStartMs };
  } catch (err: any) {
    const msg: string = err?.message ?? String(err);
    const isNetwork =
      msg.includes("ENOTFOUND") ||
      msg.includes("getaddrinfo") ||
      msg.includes("fetch") ||
      msg.includes("network");
    return {
      ok: false,
      errorType: "other",
      message: isNetwork
        ? `Model not cached and no network available. Run once with internet access to download the model (~120 MB): ${msg.slice(0, 120)}`
        : `Local embedder failed to load: ${msg.slice(0, 200)}`,
    };
  }
}
