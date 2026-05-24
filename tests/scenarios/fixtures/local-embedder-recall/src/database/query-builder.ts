/**
 * Lightweight SQL query builder.
 * Builds parameterized SQL strings with a fluent interface.
 * No ORM magic — just structured string construction.
 */

type SqlValue = string | number | boolean | null | Date;

export interface QueryResult {
  sql: string;
  params: SqlValue[];
}

export class QueryBuilder {
  private _select: string[] = ["*"];
  private _from = "";
  private _joins: string[] = [];
  private _conditions: string[] = [];
  private _orderByClauses: string[] = [];
  private _limitVal?: number;
  private _offsetVal?: number;
  private _params: SqlValue[] = [];

  private addParam(value: SqlValue): string {
    this._params.push(value);
    return `$${this._params.length}`;
  }

  /** Specify columns to select. */
  select(...columns: string[]): this {
    this._select = columns;
    return this;
  }

  /** Specify the table to query. */
  from(table: string): this {
    this._from = table;
    return this;
  }

  /** Add a LEFT JOIN clause. */
  leftJoin(table: string, on: string): this {
    this._joins.push(`LEFT JOIN ${table} ON ${on}`);
    return this;
  }

  /** Add a WHERE condition with a parameterized value. */
  where(column: string, operator: string, value: SqlValue): this {
    this._conditions.push(`${column} ${operator} ${this.addParam(value)}`);
    return this;
  }

  /** Add a raw WHERE condition (no parameterization — use only for safe literals). */
  whereRaw(condition: string): this {
    this._conditions.push(condition);
    return this;
  }

  /** Add an ORDER BY clause. */
  orderBy(column: string, direction: "ASC" | "DESC" = "ASC"): this {
    this._orderByClauses.push(`${column} ${direction}`);
    return this;
  }

  /** Set a LIMIT. */
  limit(n: number): this {
    this._limitVal = n;
    return this;
  }

  /** Set an OFFSET. */
  offset(n: number): this {
    this._offsetVal = n;
    return this;
  }

  /** Compile the query and return { sql, params }. */
  build(): QueryResult {
    if (!this._from) throw new Error("QueryBuilder: .from() is required");

    const parts = [`SELECT ${this._select.join(", ")} FROM ${this._from}`];
    if (this._joins.length) parts.push(this._joins.join(" "));
    if (this._conditions.length) parts.push(`WHERE ${this._conditions.join(" AND ")}`);
    if (this._orderByClauses.length) parts.push(`ORDER BY ${this._orderByClauses.join(", ")}`);
    if (this._limitVal != null) parts.push(`LIMIT ${this._limitVal}`);
    if (this._offsetVal != null) parts.push(`OFFSET ${this._offsetVal}`);

    return { sql: parts.join(" "), params: this._params };
  }

  /** Shortcut: build and return the SQL string only (for debugging). */
  toSql(): string {
    return this.build().sql;
  }
}

/** Factory: start a new query builder. */
export function from(table: string): QueryBuilder {
  return new QueryBuilder().from(table);
}
