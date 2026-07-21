/**
 * Caller-facing error sentinel (Plan 94, Decision 3).
 *
 * The daemon RPC catch (`mcp-rpc.ts`) must distinguish two error classes:
 *   - caller-facing: a well-formed call with bad *content* (e.g. a project_id
 *     naming a project that doesn't exist). Safe to echo verbatim — the
 *     message contains only caller-supplied identifiers, nothing about
 *     internals. Echoed under -32602 INVALID_PARAMS.
 *   - internal fault: LanceDB / embedder / fs / anything else. Stays masked
 *     as "internal error" under -32603 (CodeQL-110 posture, unchanged).
 *
 * Deliberately a 94-local module (not `pinned-branches.ts`'s error classes,
 * which are pin-management-specific and not on the search path — importing
 * them into search would be a coupling smell; see Plan 94 Decision 3).
 *
 * Throw sites mark their errors with `markCallerFacing`; the RPC catch reads
 * the marker via `isCallerFacing`. This is a type-guarded property check,
 * not string sniffing.
 */

export type CallerFacingError = Error & { callerFacing: true };

/**
 * Marks `err` as caller-facing in place and returns it (typed), so throw
 * sites can write `throw markCallerFacing(new Error("..."))`.
 */
export function markCallerFacing<E extends Error>(err: E): E & { callerFacing: true } {
  return Object.assign(err, { callerFacing: true as const });
}

/** True when `err` was marked caller-facing via `markCallerFacing` (or an equivalent `callerFacing: true` property). */
export function isCallerFacing(err: unknown): err is CallerFacingError {
  return err instanceof Error && (err as Error & { callerFacing?: unknown }).callerFacing === true;
}
