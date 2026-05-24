/**
 * Generic repository pattern over raw SQL queries.
 * Provides CRUD helpers with soft-delete and optimistic locking support.
 */

export interface Entity {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
  version: number;
}

export interface FindOptions {
  where?: Record<string, unknown>;
  orderBy?: string;
  limit?: number;
  offset?: number;
  includeDeleted?: boolean;
}

/** Base repository with soft-delete awareness. */
export abstract class BaseRepository<T extends Entity> {
  protected abstract tableName: string;
  protected abstract columns: string[];

  /** Find a single record by primary key. Returns null if not found or soft-deleted. */
  async findById(id: string): Promise<T | null> {
    const row = await this.executeQuery<T>(
      `SELECT ${this.columns.join(", ")} FROM ${this.tableName}
       WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    return row[0] ?? null;
  }

  /** Find many records matching filter options. */
  async findMany(opts: FindOptions = {}): Promise<T[]> {
    const conditions = ["TRUE"];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (!opts.includeDeleted) {
      conditions.push("deleted_at IS NULL");
    }
    if (opts.where) {
      for (const [col, val] of Object.entries(opts.where)) {
        conditions.push(`${col} = $${paramIdx++}`);
        params.push(val);
      }
    }

    const sql = [
      `SELECT ${this.columns.join(", ")} FROM ${this.tableName}`,
      `WHERE ${conditions.join(" AND ")}`,
      opts.orderBy ? `ORDER BY ${opts.orderBy}` : "",
      opts.limit != null ? `LIMIT ${opts.limit}` : "",
      opts.offset != null ? `OFFSET ${opts.offset}` : "",
    ].filter(Boolean).join(" ");

    return this.executeQuery<T>(sql, params);
  }

  /** Soft-delete a record by ID. Bumps version for optimistic locking. */
  async softDelete(id: string): Promise<boolean> {
    const rows = await this.executeQuery<{ id: string }>(
      `UPDATE ${this.tableName}
       SET deleted_at = NOW(), version = version + 1, updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id`,
      [id]
    );
    return rows.length > 0;
  }

  protected abstract executeQuery<R>(sql: string, params?: unknown[]): Promise<R[]>;
}
