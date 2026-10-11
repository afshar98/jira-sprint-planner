import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { JiraSession } from "./types.ts";

const COOKIE_NAME = "sprint_planner_session";
const SESSION_SECRET = process.env.SESSION_SECRET || randomBytes(32).toString("base64url");
const sessions = new Map<string, JiraSession>();
const oauthStates = new Map<string, { sessionId: string; expiresAt: number }>();

function signature(sessionId: string): string {
  return createHmac("sha256", SESSION_SECRET).update(sessionId).digest("base64url");
}

function cookieValue(sessionId: string): string {
  return `${sessionId}.${signature(sessionId)}`;
}

export function setSessionCookie(response: ServerResponse, sessionId: string): void {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${cookieValue(sessionId)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000${secure}`,
  );
}

export function clearSessionCookie(response: ServerResponse): void {
  response.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

function readCookie(request: IncomingMessage, name: string): string | undefined {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return undefined;

  for (const part of cookieHeader.split(";")) {
    const [key, ...valueParts] = part.trim().split("=");
    if (key === name) return decodeURIComponent(valueParts.join("="));
  }
  return undefined;
}

export function sessionIdFromRequest(request: IncomingMessage): string | undefined {
  const value = readCookie(request, COOKIE_NAME);
  if (!value) return undefined;

  const separator = value.lastIndexOf(".");
  if (separator <= 0) return undefined;

  const sessionId = value.slice(0, separator);
  const received = Buffer.from(value.slice(separator + 1));
  const expected = Buffer.from(signature(sessionId));
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return undefined;
  return sessionId;
}

export function getSession(request: IncomingMessage): JiraSession | undefined {
  const id = sessionIdFromRequest(request);
  return id ? sessions.get(id) : undefined;
}

export function getSessionById(id: string): JiraSession | undefined {
  return sessions.get(id);
}

export function createSession(): JiraSession {
  const session: JiraSession = {
    id: randomBytes(24).toString("base64url"),
    tokens: { accessToken: "", expiresAt: 0 },
    sites: [],
  };
  sessions.set(session.id, session);
  return session;
}

export function saveSession(session: JiraSession): void {
  sessions.set(session.id, session);
}

export function deleteSession(id: string | undefined): void {
  if (id) sessions.delete(id);
}

export function rememberOAuthState(state: string, sessionId: string): void {
  oauthStates.set(state, { sessionId, expiresAt: Date.now() + 10 * 60 * 1000 });
}

export function consumeOAuthState(state: string): string | undefined {
  const entry = oauthStates.get(state);
  oauthStates.delete(state);
  if (!entry || entry.expiresAt < Date.now()) return undefined;
  return entry.sessionId;
}

setInterval(() => {
  const now = Date.now();
  for (const [state, value] of oauthStates) {
    if (value.expiresAt < now) oauthStates.delete(state);
  }
}, 60_000).unref();
