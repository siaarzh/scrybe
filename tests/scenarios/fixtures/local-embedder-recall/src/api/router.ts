/**
 * Minimal HTTP router with middleware chain support.
 * Routes are matched in registration order; first match wins.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export interface Request {
  method: HttpMethod;
  path: string;
  headers: Record<string, string>;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

export interface Response {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  json(data: unknown, status?: number): void;
  text(data: string, status?: number): void;
  status(code: number): Response;
}

export type Handler = (req: Request, res: Response, next: () => void) => void | Promise<void>;

interface Route {
  method: HttpMethod;
  pattern: RegExp;
  paramNames: string[];
  handlers: Handler[];
}

/** Parse a path pattern like /users/:id/posts/:postId into regex + param names. */
function compilePattern(pattern: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const regexStr = pattern
    .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
      paramNames.push(name);
      return "([^/]+)";
    })
    .replace(/\//g, "\\/");
  return { regex: new RegExp(`^${regexStr}$`), paramNames };
}

export class Router {
  private routes: Route[] = [];
  private globalMiddleware: Handler[] = [];

  /** Register global middleware applied to every route. */
  use(handler: Handler): this {
    this.globalMiddleware.push(handler);
    return this;
  }

  /** Register a route for the given HTTP method and path pattern. */
  route(method: HttpMethod, pattern: string, ...handlers: Handler[]): this {
    const { regex, paramNames } = compilePattern(pattern);
    this.routes.push({ method, pattern: regex, paramNames, handlers });
    return this;
  }

  get(path: string, ...h: Handler[]) { return this.route("GET", path, ...h); }
  post(path: string, ...h: Handler[]) { return this.route("POST", path, ...h); }
  put(path: string, ...h: Handler[]) { return this.route("PUT", path, ...h); }
  patch(path: string, ...h: Handler[]) { return this.route("PATCH", path, ...h); }
  delete(path: string, ...h: Handler[]) { return this.route("DELETE", path, ...h); }

  /** Dispatch an incoming request through the middleware chain and matched route. */
  async dispatch(req: Request, res: Response): Promise<void> {
    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const match = req.path.match(route.pattern);
      if (!match) continue;

      // Populate path params
      for (let i = 0; i < route.paramNames.length; i++) {
        req.params[route.paramNames[i]!] = match[i + 1]!;
      }

      const chain = [...this.globalMiddleware, ...route.handlers];
      let idx = 0;
      const next = async () => {
        const fn = chain[idx++];
        if (fn) await fn(req, res, next);
      };
      await next();
      return;
    }

    res.status(404).json({ error: "Not found" });
  }
}
