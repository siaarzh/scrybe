/**
 * Application configuration loader.
 * Merges defaults, environment variables, and optional config files in priority order.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface AppConfig {
  port: number;
  host: string;
  env: "development" | "staging" | "production";
  logLevel: "debug" | "info" | "warn" | "error";
  db: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
    maxConnections: number;
  };
  redis: {
    host: string;
    port: number;
    password?: string;
    db: number;
  };
  jwt: {
    secret: string;
    issuer: string;
  };
  smtp: {
    host: string;
    port: number;
    user: string;
    password: string;
  };
}

const DEFAULTS: AppConfig = {
  port: 3000,
  host: "0.0.0.0",
  env: "development",
  logLevel: "info",
  db: { host: "localhost", port: 5432, name: "app", user: "app", password: "", maxConnections: 10 },
  redis: { host: "localhost", port: 6379, db: 0 },
  jwt: { secret: "change-me-in-production", issuer: "app" },
  smtp: { host: "localhost", port: 25, user: "", password: "" },
};

/** Deep-merge two partial config objects. Later values override earlier ones. */
function deepMerge<T extends Record<string, unknown>>(base: T, override: Partial<T>): T {
  const result = { ...base } as Record<string, unknown>;
  for (const [key, val] of Object.entries(override)) {
    if (val && typeof val === "object" && !Array.isArray(val) &&
        base[key] && typeof base[key] === "object") {
      result[key] = deepMerge(base[key] as Record<string, unknown>, val as Record<string, unknown>);
    } else if (val !== undefined) {
      result[key] = val;
    }
  }
  return result as T;
}

/** Load config from a JSON file if it exists. */
function loadConfigFile(configPath: string): Partial<AppConfig> {
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as Partial<AppConfig>;
  } catch (e) {
    process.stderr.write(`[config] Failed to parse config file ${configPath}: ${e}\n`);
    return {};
  }
}

/** Override config fields from environment variables. */
function applyEnvOverrides(config: AppConfig): AppConfig {
  const c = { ...config };
  if (process.env.PORT) c.port = parseInt(process.env.PORT, 10);
  if (process.env.HOST) c.host = process.env.HOST;
  if (process.env.NODE_ENV) c.env = process.env.NODE_ENV as AppConfig["env"];
  if (process.env.LOG_LEVEL) c.logLevel = process.env.LOG_LEVEL as AppConfig["logLevel"];
  if (process.env.DB_HOST) c.db = { ...c.db, host: process.env.DB_HOST };
  if (process.env.JWT_SECRET) c.jwt = { ...c.jwt, secret: process.env.JWT_SECRET };
  return c;
}

/**
 * Load and resolve the final application configuration.
 * Priority: env vars > config file > defaults.
 */
export function loadConfig(configDir = process.cwd()): AppConfig {
  const env = (process.env.NODE_ENV ?? "development") as AppConfig["env"];
  const fileConfig = loadConfigFile(join(configDir, `config.${env}.json`));
  const merged = deepMerge(DEFAULTS, fileConfig);
  return applyEnvOverrides(merged);
}
