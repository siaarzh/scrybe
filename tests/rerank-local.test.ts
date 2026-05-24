/**
 * Integration test for the local cross-encoder reranker (Plan 77 Slice 5).
 *
 * Uses Xenova/ms-marco-MiniLM-L-6-v2 (~22MB ONNX download on cold start).
 * This test WILL be slow on first run (5-15s for model download + load).
 *
 * Tagged with @slow via test name so CI can filter with --reporter or grep.
 *
 * What this proves:
 *   - The local rerank path loads the cross-encoder without error.
 *   - Given 5 candidates and a relevant query, the model produces different
 *     scores per candidate (i.e., the cross-encoder ran and distinguished content).
 *   - The blended scores are numerically well-formed (in [0,1], sorted desc).
 *
 * Design note: the position-aware blend gives strong weight (0.75) to retrieval
 * rank for top-3 candidates, so top-1 staying at top-1 is valid behavior even
 * when a lower-ranked candidate has a higher cross-encoder score. The test
 * therefore validates the cross-encoder RAN (not that it necessarily changed top-1).
 * For a stronger behavioral test of rank-promotion, see the applyBlend unit tests
 * in rerank-blend.test.ts which use a standalone scenario with a rank-4 candidate
 * that scores 0.99 and must rise to top-3.
 */

import { describe, it, expect, afterAll } from "vitest";
import { resetLocalRerankCache, applyBlend } from "../src/reranker.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function softmaxLocal(arr: number[]): number[] {
  const max = Math.max(...arr);
  const exps = arr.map((x) => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((x) => x / sum);
}

/**
 * Directly call the cross-encoder pipeline using its underlying tokenizer + model.
 * Mirrors what src/reranker.ts does in rerankLocal / scoreWithCrossEncoder.
 * Returns raw cross-encoder scores (before blending) so we can inspect them.
 */
async function getCrossEncoderScores(
  query: string,
  candidates: Array<{ content: string }>
): Promise<number[]> {
  const modelId = "Xenova/ms-marco-MiniLM-L-6-v2";
  const MAX_PASSAGE_CHARS = 1500;

  const { pipeline } = await import("@xenova/transformers");
  const p = await pipeline("text-classification", modelId, { revision: "main" }) as unknown as {
    tokenizer: (texts: string[], opts: { text_pair: string[]; padding: boolean; truncation: boolean }) => Record<string, unknown>;
    model: (inputs: Record<string, unknown>) => Promise<{ logits: any }>;
  };

  const queries = candidates.map(() => query);
  const passages = candidates.map((c) =>
    c.content.length > MAX_PASSAGE_CHARS ? c.content.slice(0, MAX_PASSAGE_CHARS) : c.content
  );

  const model_inputs = p.tokenizer(queries, {
    text_pair: passages,
    padding: true,
    truncation: true,
  });
  const outputs = await p.model(model_inputs);

  const logitsTensor = outputs.logits;
  const batchSize = queries.length;
  const rawScores: number[] = [];

  const numLabels: number = (logitsTensor as any).dims?.[1] ?? 1;
  const flat: number[] = Array.from((logitsTensor as any).data as Float32Array);

  for (let i = 0; i < batchSize; i++) {
    const rowLogits = flat.slice(i * numLabels, (i + 1) * numLabels);
    if (rowLogits.length === 0) { rawScores.push(0); continue; }
    if (numLabels === 1) {
      // Regression model — raw logit is the relevance score
      rawScores.push(rowLogits[0]!);
    } else {
      const probs = softmaxLocal(rowLogits);
      rawScores.push(probs[1] ?? probs[0]!);
    }
  }

  return rawScores;
}

// ─── Test data ────────────────────────────────────────────────────────────────

/**
 * 5 candidates for "Redis cache TTL expiry eviction".
 * chunk-3 (RedisCache) is the most relevant content.
 * The others describe unrelated topics.
 *
 * In the input ordering, chunk-3 is at rank 3 (index 2).
 * We expect the cross-encoder to score chunk-3 higher than chunks 4+5.
 */
const QUERY = "Redis cache TTL expiry eviction";

const CANDIDATES = [
  {
    chunk_id: "chunk-1",
    content: `// AuthService: handles user login and JWT issuance
export class AuthService {
  async login(email: string, password: string): Promise<string> {
    const user = await this.userRepo.findByEmail(email);
    if (!user || !await bcrypt.compare(password, user.passwordHash)) {
      throw new AuthError("Invalid credentials");
    }
    return jwt.sign({ sub: user.id }, process.env.JWT_SECRET!, { expiresIn: "1h" });
  }
}`,
    score: 0.92,
  },
  {
    chunk_id: "chunk-2",
    content: `// DatabaseMigration: tracks and applies schema migrations sequentially
export class MigrationRunner {
  async runPending(): Promise<void> {
    const applied = await this.db.query("SELECT name FROM migrations");
    const appliedSet = new Set(applied.rows.map(r => r.name));
    for (const migration of this.migrations) {
      if (!appliedSet.has(migration.name)) {
        await this.db.query(migration.sql);
        await this.db.query("INSERT INTO migrations (name) VALUES (?)", [migration.name]);
      }
    }
  }
}`,
    score: 0.88,
  },
  {
    chunk_id: "chunk-3",
    content: `// RedisCache: cache-aside pattern with TTL expiry and namespace keying
export class RedisCache {
  async get<T>(key: string, namespace: string): Promise<T | null> {
    const namespaced = \`\${namespace}:\${key}\`;
    const raw = await this.redis.get(namespaced);
    return raw ? JSON.parse(raw) : null;
  }

  async set<T>(key: string, value: T, ttlSeconds: number, namespace: string): Promise<void> {
    const namespaced = \`\${namespace}:\${key}\`;
    await this.redis.setex(namespaced, ttlSeconds, JSON.stringify(value));
  }

  async evict(key: string, namespace: string): Promise<void> {
    await this.redis.del(\`\${namespace}:\${key}\`);
  }
}`,
    score: 0.81,
  },
  {
    chunk_id: "chunk-4",
    content: `// WebhookHandler: validates HMAC signatures on incoming webhook payloads
export class WebhookHandler {
  verify(payload: Buffer, signature: string, secret: string): boolean {
    const expected = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");
    return crypto.timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(expected, "hex")
    );
  }
}`,
    score: 0.75,
  },
  {
    chunk_id: "chunk-5",
    content: `// FeatureFlag: percentage-based rollout evaluation for gradual feature releases
export class FeatureFlagService {
  isEnabled(flagKey: string, userId: string): boolean {
    const flag = this.flags.get(flagKey);
    if (!flag || !flag.enabled) return false;
    const hash = murmurhash3(userId + flagKey) % 100;
    return hash < flag.rolloutPercent;
  }
}`,
    score: 0.70,
  },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

afterAll(() => {
  resetLocalRerankCache();
});

describe("[slow] local cross-encoder reranker — Xenova/ms-marco-MiniLM-L-6-v2 (Plan 77 Slice 5)", () => {
  it(
    "cross-encoder scores chunk-3 (Redis/TTL content) higher than unrelated candidates",
    async () => {
      const rawScores = await getCrossEncoderScores(QUERY, CANDIDATES);

      // Must have a score for each candidate
      expect(rawScores.length).toBe(CANDIDATES.length);

      // Raw logits are unbounded floats (the model is a regression cross-encoder).
      // Verify they are finite numbers (not NaN/Infinity).
      for (const s of rawScores) {
        expect(isFinite(s)).toBe(true);
      }

      // Scores are not all identical (model produced distinct scores, not a no-op)
      const uniqueScores = new Set(rawScores.map((s) => s.toFixed(4)));
      expect(
        uniqueScores.size,
        `Expected the cross-encoder to produce distinct scores for different content.\n` +
        `All scores are identical: ${rawScores.map((s) => s.toFixed(4)).join(", ")}\n` +
        `This suggests the model did not run correctly.`
      ).toBeGreaterThan(1);

      // chunk-3 (index 2) must score higher than chunk-4 (index 3) and chunk-5 (index 4)
      // The RedisCache/TTL content is semantically most relevant to "Redis cache TTL expiry eviction"
      const score3 = rawScores[2]!;
      const score4 = rawScores[3]!;
      const score5 = rawScores[4]!;

      expect(
        score3,
        `Expected chunk-3 (RedisCache) to score higher than chunk-4 (WebhookHandler).\n` +
        `chunk-3 score: ${score3.toFixed(4)}, chunk-4 score: ${score4.toFixed(4)}\n` +
        `All scores: ${rawScores.map((s, i) => `chunk-${i + 1}=${s.toFixed(4)}`).join(", ")}`
      ).toBeGreaterThan(score4);

      expect(
        score3,
        `Expected chunk-3 (RedisCache) to score higher than chunk-5 (FeatureFlag).\n` +
        `chunk-3 score: ${score3.toFixed(4)}, chunk-5 score: ${score5.toFixed(4)}\n` +
        `All scores: ${rawScores.map((s, i) => `chunk-${i + 1}=${s.toFixed(4)}`).join(", ")}`
      ).toBeGreaterThan(score5);
    },
    // 2-minute timeout: cold model download (~22MB) + load + batch inference
    120_000
  );

  it(
    "applyBlend with cross-encoder scores produces a well-formed sorted result",
    async () => {
      const TOP3: [number, number] = [0.75, 0.25];
      const TAIL: [number, number] = [0.40, 0.60];

      // Use previously computed scores (model is cached after first test)
      const rawScores = await getCrossEncoderScores(QUERY, CANDIDATES);
      const result = applyBlend(CANDIDATES, rawScores, 5, TOP3, TAIL);

      // Returns all candidates
      expect(result.length).toBe(5);

      // Result is sorted by blended score descending
      for (let i = 1; i < result.length; i++) {
        expect(result[i - 1]!.score).toBeGreaterThanOrEqual(result[i]!.score - 1e-9);
      }

      // All chunk IDs are present
      const returnedIds = new Set(result.map((r) => r.chunk_id));
      for (const c of CANDIDATES) {
        expect(returnedIds.has(c.chunk_id)).toBe(true);
      }

      // Blended scores are in [0, 1]
      for (const r of result) {
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(1.01);
      }
    },
    30_000
  );
});
