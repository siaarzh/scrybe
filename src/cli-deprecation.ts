export function warnDeprecated(oldCmd: string, newCmd: string): void {
  if (process.env["SCRYBE_NO_DEPRECATION_WARNING"] === "1") return;
  const msg = `[deprecated] '${oldCmd}' renamed to '${newCmd}'; will be removed in v1.0`;
  process.stderr.write(
    process.stderr.isTTY ? `\x1b[33m${msg}\x1b[0m\n` : `${msg}\n`
  );
}
