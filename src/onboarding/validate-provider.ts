export interface ProviderSpec {
  baseUrl: string;
  model: string;
  apiKey: string;
  encodingFormat?: "float";
}

export interface ValidateResult {
  ok: boolean;
  dimensions?: number;
  encodingFormat?: "float";
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

  const body = JSON.stringify({
    model: spec.model,
    input: ["ping"],
    encoding_format: spec.encodingFormat ?? "base64",
  });
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
  let dimensions: number;
  if (spec.encodingFormat === "float") {
    if (!Array.isArray(vector) || vector.length === 0 ||
      vector.some((value: unknown) => typeof value !== "number" || !Number.isFinite(value))) {
      return {
        ok: false,
        errorType: "dimensions_unknown",
        message: 'Expected finite numeric arrays for encoding_format:"float". Check the endpoint\'s response encoding before changing dimensions.',
      };
    }
    dimensions = vector.length;
  } else {
    if (typeof vector !== "string" || vector.length === 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(vector)) {
      return {
        ok: false,
        errorType: "dimensions_unknown",
        message: 'Expected base64 float32 embeddings for encoding_format:"base64". If this custom endpoint returns numeric arrays, set encoding_format:"float" and retry before changing dimensions.',
      };
    }
    const bytes = Buffer.from(vector, "base64");
    if (bytes.length % Float32Array.BYTES_PER_ELEMENT !== 0) {
      return { ok: false, errorType: "dimensions_unknown", message: "Base64 embedding has an invalid float32 byte length" };
    }
    dimensions = bytes.length / Float32Array.BYTES_PER_ELEMENT;
    for (let offset = 0; offset < bytes.length; offset += Float32Array.BYTES_PER_ELEMENT) {
      if (!Number.isFinite(bytes.readFloatLE(offset))) {
        return { ok: false, errorType: "dimensions_unknown", message: "Base64 embedding contains non-finite numeric values" };
      }
    }
  }

  return {
    ok: true,
    dimensions,
    ...(spec.encodingFormat === "float" ? { encodingFormat: "float" as const } : {}),
    model: data?.model ?? spec.model,
  };
}

/**
 * Classifies a local model load error into a friendly { message } object.
 * Network errors (ENOTFOUND, fetch, network keywords) get a "run once with internet" hint.
 * All other errors get a generic "local embedder failed to load" message.
 * Used by both validateLocal (CLI wizard) and the index job's embedding error path.
 */
export function classifyLocalLoadError(err: unknown): { message: string } {
  const msg: string = (err as any)?.message ?? String(err);
  const isNetwork =
    msg.includes("ENOTFOUND") ||
    msg.includes("getaddrinfo") ||
    msg.includes("fetch") ||
    msg.includes("network");
  return {
    message: isNetwork
      ? `Model not cached and no network available. Run once with internet access to download the model (~120 MB): ${msg.slice(0, 120)}`
      : `Local embedder failed to load: ${msg.slice(0, 200)}`,
  };
}

/**
 * Validates the local WASM/ONNX embedder by loading the pipeline and running a test inference.
 * No network call if the model is already cached. Returns dimensions and cold-start time.
 */
export async function validateLocal(modelId: string): Promise<ValidateResult> {
  const t0 = Date.now();
  try {
    const { getTransformers } = await import("../util/transformers-loader.js");
    const { pipeline } = await getTransformers();
    const extractor = await pipeline("feature-extraction", modelId, { revision: "main" });
    const output: any = await extractor(["ping"], { pooling: "mean", normalize: true });
    const dims = (output[0].data as Float32Array).length;
    const coldStartMs = Date.now() - t0;
    return { ok: true, dimensions: dims, model: modelId, coldStartMs };
  } catch (err: any) {
    const { message } = classifyLocalLoadError(err);
    return { ok: false, errorType: "other", message };
  }
}
