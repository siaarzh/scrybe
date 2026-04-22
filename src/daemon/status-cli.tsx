/**
 * Ink status dashboard — Phase 9.
 * Rendered by `scrybe status --watch`.
 * Plain `scrybe status` (no flag) does not import this file.
 */
import React, { useState, useEffect } from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import { readPidfile } from "./pidfile.js";
import { DaemonClient } from "./client.js";
import type { DaemonStatus, DaemonEvent } from "./http-server.js";
import { formatUptime, formatEvent } from "./status-utils.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

const STATE_COLOR: Record<string, string> = { hot: "green", cold: "blue", paused: "yellow" };

// ─── Spinner ──────────────────────────────────────────────────────────────────

function useSpinner(): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame(f => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);
  return SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!;
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

function Dashboard({ client, onExit }: { client: DaemonClient; onExit: () => void }) {
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [events, setEvents] = useState<DaemonEvent[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const spinner = useSpinner();

  useEffect(() => {
    let mounted = true;
    async function poll() {
      try {
        const s = await client.status();
        if (mounted) { setStatus(s); setFetchError(null); }
      } catch (err) {
        if (mounted) setFetchError(String(err));
      }
    }
    poll();
    const id = setInterval(poll, 2000);
    return () => { mounted = false; clearInterval(id); };
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      try {
        for await (const ev of client.watchEvents()) {
          if (cancelled) break;
          setEvents(prev => [ev, ...prev].slice(0, 10));
        }
      } catch { /* connection closed */ }
    }
    run();
    return () => { cancelled = true; };
  }, [client]);

  useInput((input, key) => {
    if (input === "q" || key.escape) { onExit(); return; }
    if (input === "p" && status) {
      (status.state === "paused" ? client.resume() : client.pause()).catch(() => {});
    }
    if (input === "r") {
      client.kick({}).catch(() => {});
    }
  });

  if (fetchError) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="red">Lost connection to daemon: {fetchError}</Text>
        <Text dimColor>[q] quit</Text>
      </Box>
    );
  }

  if (!status) {
    return (
      <Box gap={1}>
        <Text color="green">{spinner}</Text>
        <Text>Connecting to daemon...</Text>
      </Box>
    );
  }

  const stateColor = STATE_COLOR[status.state] ?? "white";

  return (
    <Box flexDirection="column" gap={1}>
      {/* Header */}
      <Box gap={2}>
        <Text bold>scrybe</Text>
        <Text color={stateColor} bold>{status.state.toUpperCase()}</Text>
        <Text dimColor>up {formatUptime(status.uptimeMs)}</Text>
        <Text dimColor>:{status.port}</Text>
        <Text dimColor>v{status.version}</Text>
        <Text dimColor>
          queue: <Text color={status.queue.active > 0 ? "cyan" : "white"}>{status.queue.active}</Text> active / {status.queue.pending} pending
        </Text>
      </Box>

      {/* Projects table */}
      <Box flexDirection="column">
        <Text bold underline>Projects</Text>
        {status.projects.length === 0 && <Text dimColor>  No projects registered.</Text>}
        {status.projects.map(p => (
          <Box key={p.projectId} gap={2}>
            <Text bold>{p.projectId.slice(0, 18).padEnd(18)}</Text>
            <Text dimColor>{(p.currentBranch ?? "—").slice(0, 22).padEnd(22)}</Text>
            <Text color={p.watcherHealthy ? "green" : "red"}>{p.watcherHealthy ? "●" : "○"} fs</Text>
            <Text color={p.gitWatcherHealthy ? "green" : "red"}>{p.gitWatcherHealthy ? "●" : "○"} git</Text>
            <Text dimColor>{p.queueDepth > 0 ? `${p.queueDepth} queued` : "idle"}</Text>
            <Text dimColor>{p.lastIndexedAt ? new Date(p.lastIndexedAt).toLocaleTimeString() : "never"}</Text>
          </Box>
        ))}
      </Box>

      {/* Events feed */}
      <Box flexDirection="column">
        <Text bold underline>Recent events</Text>
        {events.length === 0 && <Text dimColor>  No events yet.</Text>}
        {events.map((e, i) => (
          <Text
            key={i}
            color={e.level === "error" ? "red" : e.level === "warn" ? "yellow" : undefined}
            dimColor={e.level === "info"}
          >
            {"  "}{formatEvent(e)}
          </Text>
        ))}
      </Box>

      {/* Footer */}
      <Box gap={3}>
        <Text dimColor>[q] quit  [p] {status.state === "paused" ? "resume" : "pause"}  [r] reindex all</Text>
      </Box>
    </Box>
  );
}

// ─── Root app ─────────────────────────────────────────────────────────────────

function App() {
  const { exit } = useApp();
  const [client] = useState<DaemonClient | null>(() => {
    const pid = readPidfile();
    return pid?.port ? new DaemonClient({ port: pid.port }) : null;
  });

  const handleExit = () => { client?.close(); exit(); };

  useInput((input, key) => {
    if (!client && (input === "q" || key.escape)) exit();
  });

  if (!client) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="yellow">Daemon is not running.</Text>
        <Text dimColor>Start it with: <Text bold>scrybe daemon start</Text></Text>
        <Text dimColor>[q] quit</Text>
      </Box>
    );
  }

  return <Dashboard client={client} onExit={handleExit} />;
}

// ─── Public entry ─────────────────────────────────────────────────────────────

export async function renderStatusDashboard(): Promise<void> {
  const { waitUntilExit } = render(<App />);
  await waitUntilExit();
}
