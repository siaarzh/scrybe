/**
 * Route handler functions for the user management API.
 * Each handler follows the (req, res, next) signature from router.ts.
 */
import type { Handler } from "./router.js";

// ─── User Handlers ─────────────────────────────────────────────────────────────

/** GET /users — paginated list of all active users. */
export const listUsers: Handler = async (req, res) => {
  const page = parseInt(req.query["page"] ?? "1", 10);
  const limit = Math.min(parseInt(req.query["limit"] ?? "20", 10), 100);
  const offset = (page - 1) * limit;
  void offset;
  // Stub — real impl queries DB
  res.json({ data: [], page, limit, total: 0 });
};

/** GET /users/:id — fetch a single user by ID. */
export const getUser: Handler = async (req, res) => {
  const { id } = req.params;
  if (!id) { res.status(400).json({ error: "Missing user id" }); return; }
  // Stub
  res.status(404).json({ error: "User not found" });
};

/** POST /users — create a new user from request body. */
export const createUser: Handler = async (req, res) => {
  const body = req.body as Record<string, unknown>;
  if (!body.email || typeof body.email !== "string") {
    res.status(422).json({ error: "email is required and must be a string" });
    return;
  }
  if (!body.password || typeof body.password !== "string") {
    res.status(422).json({ error: "password is required and must be a string" });
    return;
  }
  // Stub — real impl would hash password, insert user, return 201
  res.status(201).json({ id: "stub-id", email: body.email });
};

/** PATCH /users/:id — partial update of user fields. */
export const updateUser: Handler = async (req, res) => {
  const { id } = req.params;
  const body = req.body as Record<string, unknown>;
  const allowed = ["email", "role", "displayName"];
  const updates = Object.fromEntries(
    Object.entries(body).filter(([k]) => allowed.includes(k))
  );
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No valid fields to update" });
    return;
  }
  void id;
  res.json({ id, ...updates });
};

/** DELETE /users/:id — soft-delete a user account. */
export const deleteUser: Handler = async (req, res) => {
  const { id } = req.params;
  void id;
  // Stub — real impl soft-deletes user
  res.status(204).json(null);
};

// ─── Auth Handlers ─────────────────────────────────────────────────────────────

/** POST /auth/login — validate credentials and issue JWT pair. */
export const login: Handler = async (req, res) => {
  const body = req.body as Record<string, unknown>;
  if (!body.email || !body.password) {
    res.status(400).json({ error: "email and password are required" });
    return;
  }
  // Stub — real impl checks credentials, calls createTokenPair
  res.status(401).json({ error: "Invalid credentials" });
};

/** POST /auth/refresh — exchange a refresh token for a new access token. */
export const refreshToken: Handler = async (req, res) => {
  const body = req.body as Record<string, unknown>;
  if (!body.refreshToken || typeof body.refreshToken !== "string") {
    res.status(400).json({ error: "refreshToken is required" });
    return;
  }
  // Stub
  res.status(401).json({ error: "Invalid or expired refresh token" });
};

/** POST /auth/logout — invalidate the session for the current user. */
export const logout: Handler = async (req, res) => {
  const user = (req as unknown as Record<string, unknown>)["user"] as { sub: string } | undefined;
  void user;
  res.json({ message: "Logged out successfully" });
};
