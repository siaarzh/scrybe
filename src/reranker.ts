import { config } from "./config.js";

interface RerankResponseItem {
  index: number;
  relevance_score: number;
}

interface RerankResponse {
  data: RerankResponseItem[];
}

export async function rerank<T extends { content: string; score: number }>(
  query: string,
  candidates: T[],
  topK: number
): Promise<T[]> {
  const body = {
    model: config.rerankModel,
    query,
    documents: candidates.map((r) => r.content),
    top_k: topK,
    return_documents: false,
  };

  const res = await fetch(config.rerankBaseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.rerankApiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Rerank API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as RerankResponse;

  // data.data is already sorted by relevance_score desc
  return data.data.map((item) => ({
    ...candidates[item.index],
    score: item.relevance_score,
  }));
}
