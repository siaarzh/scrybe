export interface ProgressState {
  projectIdx: number;
  projectTotal: number;
  projectId: string;
  bytesEmbedded: number;
  bytesTotal: number | null;
  chunksIndexed: number;
  throughputBps: number | null;
}

const MAX_LINE = 80;

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "estimating...";
  if (seconds < 60) return `~${Math.ceil(seconds)}s remaining`;
  const min = Math.floor(seconds / 60);
  const sec = Math.ceil(seconds - min * 60);
  return `~${min}m ${sec}s remaining`;
}

export function formatProgressLine(s: ProgressState): string {
  const counter = `[${s.projectIdx}/${s.projectTotal}]`;
  const pctStr =
    s.bytesTotal != null && s.bytesTotal > 0
      ? `${Math.min(100, Math.floor((s.bytesEmbedded / s.bytesTotal) * 100))}%`
      : `${s.chunksIndexed} chunks`;
  const eta =
    s.bytesTotal != null && s.throughputBps != null
      ? formatEta((s.bytesTotal - s.bytesEmbedded) / s.throughputBps)
      : "estimating...";
  const line = `${counter} ${s.projectId} — ${pctStr} · ${eta}`;
  return line.length > MAX_LINE ? line.slice(0, MAX_LINE - 1) + "…" : line;
}

export function updateThroughput(
  prev: number | null,
  batchBytes: number,
  batchMs: number
): number {
  if (batchMs <= 0) return prev ?? 0;
  const alpha = 0.3;
  const sample = (batchBytes / batchMs) * 1000;
  return prev === null ? sample : alpha * sample + (1 - alpha) * prev;
}
