/**
 * Database transaction helpers with savepoint support.
 * Wraps connection-level COMMIT/ROLLBACK with nested transaction detection.
 */
import type { Connection } from "./connection.js";

export type IsolationLevel = "READ UNCOMMITTED" | "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";

export interface TransactionOptions {
  isolationLevel?: IsolationLevel;
  readOnly?: boolean;
}

let _savepointCounter = 0;

/**
 * Execute a callback inside a database transaction.
 * Automatically commits on success and rolls back on error.
 * Supports nested calls using savepoints.
 */
export async function withTransaction<T>(
  conn: Connection,
  cb: (conn: Connection) => Promise<T>,
  opts: TransactionOptions = {}
): Promise<T> {
  const inTx = (conn as unknown as Record<string, unknown>)["_inTransaction"] === true;

  if (inTx) {
    // Nested call — use a savepoint
    const sp = `sp_${++_savepointCounter}`;
    await conn.query(`SAVEPOINT ${sp}`);
    try {
      const result = await cb(conn);
      await conn.query(`RELEASE SAVEPOINT ${sp}`);
      return result;
    } catch (err) {
      await conn.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      throw err;
    }
  }

  // Outer transaction
  const level = opts.isolationLevel ? `ISOLATION LEVEL ${opts.isolationLevel}` : "";
  const readMode = opts.readOnly ? "READ ONLY" : "";
  const beginClause = ["BEGIN", level, readMode].filter(Boolean).join(" ");

  await conn.query(beginClause);
  (conn as unknown as Record<string, unknown>)["_inTransaction"] = true;

  try {
    const result = await cb(conn);
    await conn.query("COMMIT");
    return result;
  } catch (err) {
    try { await conn.query("ROLLBACK"); } catch { /* ignore rollback errors */ }
    throw err;
  } finally {
    (conn as unknown as Record<string, unknown>)["_inTransaction"] = false;
  }
}

/**
 * Retry a transaction up to maxRetries times on serialization failure.
 * Postgres raises SQLSTATE 40001 (serialization_failure) on concurrent writes.
 */
export async function withSerializableRetry<T>(
  conn: Connection,
  cb: (conn: Connection) => Promise<T>,
  maxRetries = 3
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await withTransaction(conn, cb, { isolationLevel: "SERIALIZABLE" });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code !== "40001" || attempt === maxRetries) throw err;
      // Brief pause before retry (exponential backoff)
      await new Promise((r) => setTimeout(r, 50 * Math.pow(2, attempt - 1)));
    }
  }
  /* istanbul ignore next */
  throw new Error("withSerializableRetry: exhausted retries");
}
