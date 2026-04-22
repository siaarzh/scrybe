import type { DaemonEvent } from "./http-server.js";

export function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatEvent(e: DaemonEvent): string {
  const t = new Date(e.ts).toLocaleTimeString();
  const proj = e.projectId ? ` [${e.projectId}]` : "";
  const detail = e.detail?.["phase"] ? ` (${e.detail["phase"]})` : "";
  return `${t} ${e.level.toUpperCase().padEnd(5)} ${e.event}${proj}${detail}`;
}
