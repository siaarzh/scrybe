/**
 * Cross-platform editor launcher.
 *
 * Resolution order:
 *   1. $VISUAL
 *   2. $EDITOR
 *   3. Windows: notepad.exe
 *   4. macOS: open -t (TextEdit)
 *   5. Linux/fallback: nano
 *
 * Blocks until the editor process exits (spawnSync), regardless of exit code.
 * If the file doesn't exist and `options.ifMissing.contentTemplate` is provided,
 * the file is created with that content before launching the editor.
 */
import { spawnSync } from "child_process";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export interface EditorOptions {
  /** If the file doesn't exist, create it with this content before opening. */
  ifMissing?: {
    contentTemplate: string;
  };
}

function resolveEditor(): { bin: string; args: string[]; shell: boolean } {
  const visual = process.env["VISUAL"];
  const editor = process.env["EDITOR"];

  if (visual) return { bin: visual, args: [], shell: true };
  if (editor) return { bin: editor, args: [], shell: true };

  if (process.platform === "win32") {
    return { bin: "notepad.exe", args: [], shell: true };
  } else if (process.platform === "darwin") {
    return { bin: "open", args: ["-t"], shell: false };
  } else {
    return { bin: "nano", args: [], shell: false };
  }
}

/**
 * Open the given file in the user's editor. Blocks until editor exits.
 * Creates the file with template content if it doesn't exist.
 *
 * @param filePath  Absolute path to the file to open.
 * @param options   Optional: template for new-file creation.
 * @returns `true` if the editor exited cleanly, `false` on spawn error.
 *          Exit code ≠ 0 is treated as "done" (covers vim :cq, etc.).
 */
export function openEditor(filePath: string, options?: EditorOptions): boolean {
  // Create file with template if missing
  if (!existsSync(filePath) && options?.ifMissing?.contentTemplate !== undefined) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, options.ifMissing.contentTemplate, "utf8");
  }

  const { bin, args, shell } = resolveEditor();
  const allArgs = [...args, filePath];

  const result = spawnSync(bin, allArgs, {
    stdio: "inherit",
    shell,
    windowsHide: false, // let notepad.exe open its window
  });

  if (result.error) {
    process.stderr.write(`[scrybe] Could not launch editor '${bin}': ${result.error.message}\n`);
    return false;
  }

  return true;
}
