/**
 * Cursor-based and offset-based pagination helpers.
 * Cursor pagination is preferred for stable, real-time feeds.
 */

export interface OffsetPage<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export interface CursorPage<T> {
  data: T[];
  nextCursor: string | null;
  prevCursor: string | null;
  hasMore: boolean;
}

/**
 * Wrap a data slice and total count in an offset pagination envelope.
 */
export function offsetPage<T>(
  data: T[],
  total: number,
  page: number,
  limit: number
): OffsetPage<T> {
  return {
    data,
    total,
    page,
    limit,
    hasMore: page * limit < total,
  };
}

/**
 * Encode an opaque cursor from a sort key and a row ID.
 * Format: base64url({ id, key })
 */
export function encodeCursor(id: string, sortKey: unknown): string {
  return Buffer.from(JSON.stringify({ id, sortKey })).toString("base64url");
}

/**
 * Decode a cursor back to its component parts.
 * Returns null if the cursor is malformed or tampered.
 */
export function decodeCursor(cursor: string): { id: string; sortKey: unknown } | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as { id: string; sortKey: unknown };
    if (typeof parsed.id !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Build a cursor-page result given a data slice (over-fetched by 1) and
 * the cursor encoder function.
 *
 * @param slice - data.length should be limit + 1 (to detect hasMore)
 * @param limit - requested page size
 * @param getCursorFields - extract (id, sortKey) from a row for cursor encoding
 */
export function cursorPage<T extends { id: string }>(
  slice: T[],
  limit: number,
  prevCursor: string | null,
  getCursorFields: (row: T) => unknown
): CursorPage<T> {
  const hasMore = slice.length > limit;
  const data = slice.slice(0, limit);
  const nextCursor = hasMore ? encodeCursor(data[data.length - 1]!.id, getCursorFields(data[data.length - 1]!)) : null;
  return { data, nextCursor, prevCursor, hasMore };
}

/** Parse limit and page query params with clamping. */
export function parseOffsetParams(
  query: Record<string, string>,
  defaults: { limit?: number; maxLimit?: number } = {}
): { page: number; limit: number; offset: number } {
  const page = Math.max(1, parseInt(query["page"] ?? "1", 10));
  const maxLimit = defaults.maxLimit ?? 100;
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query["limit"] ?? String(defaults.limit ?? 20), 10)));
  return { page, limit, offset: (page - 1) * limit };
}
