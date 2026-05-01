/**
 * Interactive wizard for editing per-source private ignore rules.
 *
 * Flow:
 *   1. Pre-select project from cwd (if matched), then ask which project
 *   2. If project has >1 code source, ask which source
 *   3. Open editor on DATA_DIR/ignores/<project>/<source>.gitignore
 *   4. Ask "Reindex now? [Y/n]" → if Yes, enqueue incremental reindex via daemon
 */
import * as p from "@clack/prompts";
import { resolve, basename } from "path";
import { execSync } from "child_process";
import {
  ensurePrivateIgnoreFile,
  buildTemplate,
  loadPrivateIgnore,
  countRules,
  isMissingOrEmpty,
} from "../private-ignore.js";
import { openEditor } from "../editor.js";

interface WizardProject {
  id: string;
  codeSources: Array<{ sourceId: string; ruleCount: number }>;
}

function detectCwdProject(projects: WizardProject[]): string | undefined {
  const cwd = process.cwd();
  // Try to find a registered project whose code source root matches cwd (or cwd is under it)
  // We import registry lazily to keep this module lightweight
  return undefined; // Resolved in runIgnoreWizard using registry
}

function ruleHint(count: number): string {
  if (count === 0) return "no rules";
  return `${count} rule${count === 1 ? "" : "s"}`;
}

function buildProjectOptions(projects: WizardProject[]): Array<{ value: string; label: string; hint: string }> {
  return projects.map((proj) => {
    const sourceSummary = proj.codeSources
      .map((s) => `${s.sourceId} (${ruleHint(s.ruleCount)})`)
      .join(", ");
    const knowedge = ""; // knowledge sources are N/A — not shown per locked decision
    return {
      value: proj.id,
      label: proj.id,
      hint: sourceSummary || "no code sources",
    };
  });
}

export async function runIgnoreWizard(): Promise<void> {
  const { listProjects } = await import("../registry.js");
  const allProjects = listProjects();

  // Build list of projects with code sources
  const wizardProjects: WizardProject[] = [];
  for (const proj of allProjects) {
    const codeSources = proj.sources
      .filter((s) => s.source_config.type === "code")
      .map((s) => ({
        sourceId: s.source_id,
        ruleCount: countRules(loadPrivateIgnore(proj.id, s.source_id)),
      }));
    wizardProjects.push({ id: proj.id, codeSources });
  }

  if (wizardProjects.length === 0) {
    p.log.warn("No registered projects found. Run 'scrybe init' or 'scrybe project add' first.");
    return;
  }

  // Try cwd pre-selection. Windows paths are case-insensitive — normalize both sides.
  const isWin = process.platform === "win32";
  const norm = (p: string): string => (isWin ? resolve(p).toLowerCase() : resolve(p));
  const cwd = norm(process.cwd());
  let cwdMatchedProjectId: string | undefined;
  for (const proj of allProjects) {
    for (const s of proj.sources) {
      if (s.source_config.type === "code") {
        const rootPath = norm((s.source_config as { type: "code"; root_path: string }).root_path);
        if (cwd === rootPath || cwd.startsWith(rootPath + "/") || cwd.startsWith(rootPath + "\\")) {
          cwdMatchedProjectId = proj.id;
          break;
        }
      }
    }
    if (cwdMatchedProjectId) break;
  }

  p.intro("Private ignore rules — per-source, stored in DATA_DIR (never committed)");

  // Step 1: Choose project — skip picker when cwd matches a registered project
  let selectedProjectId: string;
  if (cwdMatchedProjectId) {
    selectedProjectId = cwdMatchedProjectId;
    p.log.info(`Project: ${selectedProjectId} (detected from current directory)`);
  } else if (wizardProjects.length === 1) {
    selectedProjectId = wizardProjects[0]!.id;
    p.log.info(`Project: ${selectedProjectId}`);
  } else {
    const options = buildProjectOptions(wizardProjects);
    const chosen = await p.select({
      message: "Which project?",
      options,
      initialValue: wizardProjects[0]!.id,
    });
    if (p.isCancel(chosen)) { p.cancel("Aborted."); return; }
    selectedProjectId = chosen as string;
  }

  const selectedProject = wizardProjects.find((p2) => p2.id === selectedProjectId)!;
  const codeSources = selectedProject.codeSources;

  if (codeSources.length === 0) {
    p.log.warn(`Project '${selectedProjectId}' has no code sources. Private ignore rules only apply to code sources.`);
    return;
  }

  // Step 2: Choose source (skip if only one)
  let selectedSourceId: string;
  if (codeSources.length === 1) {
    selectedSourceId = codeSources[0]!.sourceId;
  } else {
    const sourceOptions = codeSources.map((s) => ({
      value: s.sourceId,
      label: s.sourceId,
      hint: ruleHint(s.ruleCount),
    }));
    const chosenSource = await p.select({
      message: "Which source?",
      options: sourceOptions,
      initialValue: codeSources[0]!.sourceId,
    });
    if (p.isCancel(chosenSource)) { p.cancel("Aborted."); return; }
    selectedSourceId = chosenSource as string;
  }

  // Step 3: Open editor
  const filePath = ensurePrivateIgnoreFile(selectedProjectId, selectedSourceId);
  p.log.message(`Opening editor at ${filePath}`);
  p.log.info("(Close the editor window to continue.)");

  const template = buildTemplate(selectedProjectId, selectedSourceId);
  openEditor(filePath, { ifMissing: { contentTemplate: template } });

  // Step 4: Reindex prompt
  const content = loadPrivateIgnore(selectedProjectId, selectedSourceId);
  const ruleCount = countRules(content);
  const rulesEmpty = isMissingOrEmpty(content);

  if (rulesEmpty) {
    p.log.info("No rules in file (comment-only or empty). No reindex needed.");
    p.outro("Done. Run 'scrybe ignore' again to add rules.");
    return;
  }

  const doReindex = await p.confirm({
    message: `Reindex ${selectedProjectId}/${selectedSourceId} now to apply changes? (${ruleHint(ruleCount)})`,
    initialValue: true,
  });
  if (p.isCancel(doReindex)) { p.outro("Done (no reindex scheduled)."); return; }

  if (doReindex) {
    // Try to enqueue via daemon; fall back to printing a command hint
    try {
      const { DaemonClient } = await import("../daemon/client.js");
      const { readPidfile } = await import("../daemon/pidfile.js");
      const pidData = readPidfile();
      if (pidData?.port) {
        const client = new DaemonClient({ port: pidData.port });
        const resp = await client.submitReindex({
          projectId: selectedProjectId,
          sourceId: selectedSourceId,
          mode: "incremental",
        });
        const job = resp.jobs[0];
        if (job) {
          p.log.success(`Enqueued reindex job ${job.jobId}.`);
        } else {
          p.log.warn("Daemon returned no job — run manually: scrybe index -P " + selectedProjectId + " -S " + selectedSourceId);
        }
      } else {
        p.log.info(`Daemon not running. To apply rules now:\n  scrybe index -P ${selectedProjectId} -S ${selectedSourceId}`);
      }
    } catch {
      p.log.info(`To apply rules now:\n  scrybe index -P ${selectedProjectId} -S ${selectedSourceId}`);
    }
  } else {
    p.log.info(`Rules saved. To apply later:\n  scrybe index -P ${selectedProjectId} -S ${selectedSourceId}`);
  }

  p.outro("Done.");
}
