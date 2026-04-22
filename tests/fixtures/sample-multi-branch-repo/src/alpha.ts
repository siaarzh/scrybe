/**
 * Alpha module — greeting utilities.
 * On main: only alphaGreeting.
 * On feat/example: alphaFarewell is added by ensureMultiBranchFixture.
 */

export interface GreetingOptions {
  formal?: boolean;
  language?: "en" | "de";
}

export function alphaGreeting(name: string, opts: GreetingOptions = {}): string {
  const { formal = false, language = "en" } = opts;
  if (language === "de") {
    return formal ? `Guten Tag, ${name}.` : `Hallo, ${name}!`;
  }
  return formal ? `Good day, ${name}.` : `Hello, ${name}!`;
}
