import { existsSync, readdirSync, readFileSync } from "fs";
import { dirname, basename } from "path";
import { expect } from "vitest";

export async function expectBackupCreated(
  targetPath: string,
  operation: () => Promise<void>
): Promise<void> {
  const originalContent = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : null;
  const dir = dirname(targetPath);
  const base = basename(targetPath);

  await operation();

  const backupFiles = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.startsWith(base) && f.includes(".scrybe-backup-"))
    : [];

  expect(backupFiles.length, `Expected backup of ${targetPath} to be created`).toBeGreaterThan(0);

  if (originalContent !== null) {
    const backupPath = `${dir}/${backupFiles[0]}`;
    expect(readFileSync(backupPath, "utf8")).toBe(originalContent);
  }
}

export async function expectNoBackupCreated(
  targetPath: string,
  operation: () => Promise<void>
): Promise<void> {
  const dir = dirname(targetPath);
  const base = basename(targetPath);

  await operation();

  const backupFiles = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.startsWith(base) && f.includes(".scrybe-backup-"))
    : [];

  expect(backupFiles.length, `Expected no backup of ${targetPath}`).toBe(0);
}
