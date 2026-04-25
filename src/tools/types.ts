import type { Command } from "commander";

export interface JSONSchema {
  type: string;
  properties?: Record<string, {
    type?: string;
    description?: string;
    enum?: string[];
    items?: { type: string };
    default?: unknown;
  }>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface McpAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolSpec {
  /** MCP tool name (snake_case). */
  name: string;
  /** CLI canonical name (noun verb). Undefined = MCP-only. */
  cliName?: string;
  /** If true, registered in CLI only — not exposed via MCP. */
  cliOnly?: boolean;
  description: string;
  inputSchema: JSONSchema;
  /** Commander option builder — called to add flags/arguments to the CLI command. */
  cliArgs?: (cmd: Command) => Command;
  annotations?: McpAnnotations;
}

/** Returned by reindex handlers so CLI can await while MCP returns job_id immediately. */
export interface JobResult<T> {
  jobId: string;
  awaitable: Promise<T>;
}

export interface Tool<Input = Record<string, unknown>, Output = unknown> {
  spec: ToolSpec;
  /** Business logic. Input uses MCP-style field names (snake_case). */
  handler: (input: Input) => Promise<Output | JobResult<Output>>;
  /**
   * Maps Commander's action callback args to handler input shape.
   * Receives the action args array without the trailing Command instance.
   * Index 0..n-2 = positional args, index n-1 = Commander options object.
   */
  cliOpts?: (actionArgs: any[]) => Input;
  /** Human-readable CLI output. Default: JSON.stringify(output, null, 2). */
  formatCli?: (output: Output) => string;
}
