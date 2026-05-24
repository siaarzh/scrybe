/**
 * Feature flag evaluation engine.
 * Supports percentage rollouts, user targeting, and environment overrides.
 */

export type FlagVariant = "on" | "off" | string;

export interface FlagRule {
  type: "user_id" | "user_role" | "percentage" | "env";
  value: string | number;
  variant: FlagVariant;
}

export interface FeatureFlag {
  key: string;
  defaultVariant: FlagVariant;
  rules: FlagRule[];
  description?: string;
  enabled: boolean;
}

export interface EvaluationContext {
  userId?: string;
  userRole?: string;
  env?: string;
}

/**
 * Deterministic hash of a string to a value in [0, 1).
 * Used for stable percentage-based rollouts per user.
 */
function stableHash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h + input.charCodeAt(i)) | 0;
  }
  return (Math.abs(h) % 10_000) / 10_000;
}

/**
 * Evaluate a feature flag for the given context.
 * Rules are evaluated in order; the first matching rule wins.
 * Returns the default variant if no rule matches.
 */
export function evaluate(flag: FeatureFlag, ctx: EvaluationContext = {}): FlagVariant {
  if (!flag.enabled) return "off";

  for (const rule of flag.rules) {
    switch (rule.type) {
      case "env":
        if (ctx.env === rule.value) return rule.variant;
        break;
      case "user_role":
        if (ctx.userRole === rule.value) return rule.variant;
        break;
      case "user_id":
        if (ctx.userId === rule.value) return rule.variant;
        break;
      case "percentage":
        if (ctx.userId) {
          const hash = stableHash(`${flag.key}:${ctx.userId}`);
          if (hash < (rule.value as number) / 100) return rule.variant;
        }
        break;
    }
  }

  return flag.defaultVariant;
}

/** Helper: evaluate to boolean (variant === "on"). */
export function isEnabled(flag: FeatureFlag, ctx: EvaluationContext = {}): boolean {
  return evaluate(flag, ctx) === "on";
}

// ─── Flag registry ─────────────────────────────────────────────────────────────

const _flags = new Map<string, FeatureFlag>();

export function registerFlag(flag: FeatureFlag): void {
  _flags.set(flag.key, flag);
}

export function getFlag(key: string): FeatureFlag | undefined {
  return _flags.get(key);
}

export function evaluateByKey(key: string, ctx: EvaluationContext = {}): FlagVariant {
  const flag = _flags.get(key);
  if (!flag) return "off";
  return evaluate(flag, ctx);
}
