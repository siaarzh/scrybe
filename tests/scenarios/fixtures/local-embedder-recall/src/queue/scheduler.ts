/**
 * Cron-style job scheduler.
 * Parses cron expressions and determines next run times for recurring tasks.
 */

export interface ScheduledTask {
  name: string;
  cron: string;       // "* * * * *" (minute, hour, dom, month, dow)
  handler: () => Promise<void>;
  lastRunAt?: number;
  nextRunAt: number;
  enabled: boolean;
}

/** Naively parse a cron field: supports "*", numbers, and simple ranges "a-b". */
function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (part.includes("-")) {
      const [lo, hi] = part.split("-").map(Number);
      for (let i = (lo ?? min); i <= (hi ?? max); i++) values.add(i);
    } else if (part.includes("/")) {
      const [base, step] = part.split("/");
      const stepN = parseInt(step ?? "1", 10);
      const start = base === "*" ? min : parseInt(base ?? "0", 10);
      for (let i = start; i <= max; i += stepN) values.add(i);
    } else {
      const n = parseInt(part, 10);
      if (!isNaN(n)) values.add(n);
    }
  }
  return values;
}

/** Compute the next UTC timestamp (ms) at which a cron expression fires after `after`. */
export function nextCronRunAfter(cron: string, after: number = Date.now()): number {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Invalid cron expression: "${cron}"`);
  const [minuteF, hourF, domF, monthF, dowF] = parts as [string, string, string, string, string];

  const minutes = parseCronField(minuteF, 0, 59);
  const hours = parseCronField(hourF, 0, 23);
  const doms = parseCronField(domF, 1, 31);
  const months = parseCronField(monthF, 1, 12);
  const dows = parseCronField(dowF, 0, 6);

  // Advance one minute beyond `after` to find strict-future match
  let candidate = new Date(after + 60_000);
  candidate.setSeconds(0, 0);

  // Scan up to 1 year ahead
  const deadline = after + 365 * 24 * 60 * 60 * 1000;
  while (candidate.getTime() < deadline) {
    if (
      months.has(candidate.getUTCMonth() + 1) &&
      doms.has(candidate.getUTCDate()) &&
      dows.has(candidate.getUTCDay()) &&
      hours.has(candidate.getUTCHours()) &&
      minutes.has(candidate.getUTCMinutes())
    ) {
      return candidate.getTime();
    }
    candidate = new Date(candidate.getTime() + 60_000);
  }
  throw new Error(`No run time found in next year for cron: "${cron}"`);
}

const _tasks = new Map<string, ScheduledTask>();

/** Register a recurring task. Replaces any existing task with the same name. */
export function registerTask(task: Omit<ScheduledTask, "nextRunAt">): void {
  const nextRunAt = nextCronRunAfter(task.cron);
  _tasks.set(task.name, { ...task, nextRunAt });
}

/** Tick: run all tasks whose nextRunAt is in the past. Returns number of tasks fired. */
export async function tick(): Promise<number> {
  const now = Date.now();
  let fired = 0;
  for (const task of _tasks.values()) {
    if (!task.enabled || task.nextRunAt > now) continue;
    task.lastRunAt = now;
    task.nextRunAt = nextCronRunAfter(task.cron, now);
    fired++;
    try {
      await task.handler();
    } catch (err) {
      process.stderr.write(`[scheduler] task "${task.name}" failed: ${err}\n`);
    }
  }
  return fired;
}
