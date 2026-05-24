/**
 * Input validation utilities.
 * Provides schema-based validation with typed error reporting.
 */

export type ValidationError = { field: string; message: string; code: string };
export type ValidationResult<T> = { ok: true; data: T } | { ok: false; errors: ValidationError[] };

/** Validator function type: returns null on success, error string on failure. */
export type Validator<T> = (value: unknown) => string | null;

// ─── Primitive validators ──────────────────────────────────────────────────────

export function isString(min = 0, max = Infinity): Validator<string> {
  return (v) => {
    if (typeof v !== "string") return "must be a string";
    if (v.length < min) return `must be at least ${min} characters`;
    if (v.length > max) return `must be at most ${max} characters`;
    return null;
  };
}

export function isEmail(): Validator<string> {
  return (v) => {
    if (typeof v !== "string") return "must be a string";
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : "must be a valid email address";
  };
}

export function isNumber(min = -Infinity, max = Infinity): Validator<number> {
  return (v) => {
    if (typeof v !== "number" || isNaN(v)) return "must be a number";
    if (v < min) return `must be at least ${min}`;
    if (v > max) return `must be at most ${max}`;
    return null;
  };
}

export function isBoolean(): Validator<boolean> {
  return (v) => (typeof v === "boolean" ? null : "must be a boolean");
}

export function isOneOf<T>(choices: readonly T[]): Validator<T> {
  return (v) => (choices.includes(v as T) ? null : `must be one of: ${choices.join(", ")}`);
}

// ─── Schema validator ──────────────────────────────────────────────────────────

type Schema<T extends Record<string, unknown>> = {
  [K in keyof T]: Validator<T[K]>;
};

/**
 * Validate an unknown input object against a schema of per-field validators.
 * Returns typed data on success or a list of per-field errors on failure.
 */
export function validate<T extends Record<string, unknown>>(
  input: unknown,
  schema: Schema<T>
): ValidationResult<T> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: [{ field: "_root", message: "expected an object", code: "not_object" }] };
  }

  const errors: ValidationError[] = [];
  const data: Partial<T> = {};

  for (const [field, validator] of Object.entries(schema) as [keyof T, Validator<T[keyof T]>][]) {
    const value = (input as Record<string, unknown>)[field as string];
    const err = validator(value);
    if (err) {
      errors.push({ field: field as string, message: err, code: "validation_error" });
    } else {
      data[field] = value as T[typeof field];
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, data: data as T };
}
