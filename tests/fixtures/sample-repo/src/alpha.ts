/**
 * Alpha module — greeting utilities.
 */

export interface GreetingOptions {
  formal?: boolean;
  language?: "en" | "de";
}

/**
 * Returns a greeting string for the given name.
 */
export function alphaGreeting(name: string, opts: GreetingOptions = {}): string {
  const { formal = false, language = "en" } = opts;
  if (language === "de") {
    return formal ? `Guten Tag, ${name}.` : `Hallo, ${name}!`;
  }
  return formal ? `Good day, ${name}.` : `Hello, ${name}!`;
}

export function alphaFarewell(name: string): string {
  return `Goodbye, ${name}!`;
}
