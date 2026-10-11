import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { addIssueToSprint, createStoryIssue, exchangeAuthorizationCode, findIssueByLabel, getSourceStories, getStoryIssueTypeId, jiraRequest, listBoards, listProjects, listSourceStories, listSprints, loadAccessibleSites, JiraError } from "./jira.ts";
import { generateDrafts, GenerationError } from "./generation.ts";
import { clearSessionCookie, createSession, consumeOAuthState, deleteSession, getSession, getSessionById, rememberOAuthState, saveSession, sessionIdFromRequest, setSessionCookie } from "./session.ts";
import type { DraftBatch, DraftStory, JiraSession, SourceStory } from "./types.ts";

const ROOT = resolve(process.cwd());
const PUBLIC = resolve(ROOT, "public");
const batches = new Map<string, DraftBatch>();
const batchLocks = new Set<string>();
const MAX_BODY_BYTES = 1_000_000;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function sendText(response: ServerResponse, status: number, body: string, contentType: string): void {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > MAX_BODY_BYTES) throw new HttpError(413, "Request is too large.");
    chunks.push(value);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected an object.");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function requireSession(request: IncomingMessage): JiraSession {
  const session = getSession(request);
  if (!session?.tokens.accessToken) throw new HttpError(401, "Connect Jira before continuing.");
  return session;
}

function assertSameOrigin(request: IncomingMessage): void {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host) throw new HttpError(403, "The request origin could not be verified. Refresh the page and try again.");
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new HttpError(403, "The request origin could not be verified.");
  }
  if (parsedOrigin.host !== host) throw new HttpError(403, "The request origin could not be verified.");
}

function stringField(body: Record<string, unknown>, name: string, maxLength = 300): string {
  const value = body[name];
  if (typeof value !== "string" || value.length > maxLength) throw new HttpError(400, `Invalid ${name}.`);
  return value.trim();
}

function numberField(body: Record<string, unknown>, name: string, min = 1, max = 365): number {
  const value = Number(body[name]);
  if (!Number.isInteger(value) || value < min || value > max) throw new HttpError(400, `Invalid ${name}.`);
  return value;
}

function asSafeDraft(input: unknown, original: DraftStory): DraftStory {
  if (!input || typeof input !== "object") throw new HttpError(400, "A draft was invalid.");
  const draft = input as Record<string, unknown>;
  const title = typeof draft.title === "string" ? draft.title.trim() : "";
  const subtasks = Array.isArray(draft.subtasks) ? draft.subtasks.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
  const definitionOfDone = Array.isArray(draft.definitionOfDone) ? draft.definitionOfDone.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
  if (draft.id !== original.id || draft.sourceIssueKey !== original.sourceIssueKey) throw new HttpError(400, "Draft identity and source Story cannot be changed.");
  if (!title || title.length > 250) throw new HttpError(400, "Every draft needs a title under 250 characters.");
  if (subtasks.length < 1 || subtasks.length > 12 || subtasks.some((item) => item.length > 500)) throw new HttpError(400, "Each draft needs 1 to 12 checklist items, each under 500 characters.");
  if (definitionOfDone.length < 1 || definitionOfDone.length > 8 || definitionOfDone.some((item) => item.length > 500)) throw new HttpError(400, "Each draft needs 1 to 8 DoD items, each under 500 characters.");
  return { ...original, title, subtasks, definitionOfDone };
}

function sessionStatus(session: JiraSession | undefined) {
  return {
    connected: Boolean(session?.tokens.accessToken),
    sites: session?.sites || [],
    activeSiteId: session?.activeSiteId || "",
    aiConfigured: Boolean(process.env.OPENAI_API_KEY),
    jiraConfigured: Boolean(process.env.ATLASSIAN_CLIENT_ID && process.env.ATLASSIAN_CLIENT_SECRET),
  };
}

async function getIssueTypes(session: JiraSession, projectId: string): Promise<string> {
  return getStoryIssueTypeId(session, projectId);
}

async function staticFile(path: string): Promise<{ body: string; type: string }> {
  const contentType: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8" };
  const filePath = resolve(PUBLIC, path);
  if (!filePath.startsWith(`${PUBLIC}/`)) throw new HttpError(404, "Not found.");
  const body = await readFile(filePath, "utf8");
  return { body, type: contentType[extname(filePath)] || "text/plain; charset=utf-8" };
}

async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const method = request.method || "GET";
  const pathname = url.pathname;

  if (method === "GET" && pathname === "/api/status") {
    sendJson(response, 200, sessionStatus(getSession(request)));
    return;
  }

  if (method === "POST") assertSameOrigin(request);

  if (method === "POST" && pathname === "/api/logout") {
    const id = sessionIdFromRequest(request);
    deleteSession(id);
    clearSessionCookie(response);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (method === "POST" && pathname === "/api/jira/site") {
    const session = requireSession(request);
    const body = await readBody(request);
    const siteId = stringField(body, "siteId", 100);
    if (!session.sites.some((site) => site.id === siteId)) throw new HttpError(400, "Select one of the Jira sites connected to this account.");
    session.activeSiteId = siteId;
    saveSession(session);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (method === "GET" && pathname === "/api/projects") {
    sendJson(response, 200, { projects: await listProjects(requireSession(request)) });
    return;
  }

  if (method === "GET" && pathname === "/api/boards") {
    const projectKey = url.searchParams.get("projectKey") || "";
    if (!projectKey) throw new HttpError(400, "Choose a Jira project.");
    sendJson(response, 200, { boards: await listBoards(requireSession(request), projectKey) });
    return;
  }

  if (method === "GET" && pathname === "/api/sprints") {
    const boardId = Number(url.searchParams.get("boardId"));
    if (!Number.isInteger(boardId) || boardId <= 0) throw new HttpError(400, "Choose a Jira board.");
    sendJson(response, 200, { sprints: await listSprints(requireSession(request), boardId) });
    return;
  }

  if (method === "GET" && pathname === "/api/issues") {
    const projectKey = url.searchParams.get("projectKey") || "";
    const sprintId = Number(url.searchParams.get("sprintId"));
    const search = url.searchParams.get("search") || "";
    if (!projectKey || !Number.isInteger(sprintId) || sprintId <= 0) throw new HttpError(400, "Choose a project and sprint.");
    sendJson(response, 200, { issues: await listSourceStories(requireSession(request), projectKey, sprintId, search) });
    return;
  }

  if (method === "POST" && pathname === "/api/generate") {
    const session = requireSession(request);
    const body = await readBody(request);
    const projectKey = stringField(body, "projectKey", 100);
    const boardId = numberField(body, "boardId", 1, 1_000_000_000);
    const sprintId = numberField(body, "sprintId", 1, 1_000_000_000);
    const sprintDays = numberField(body, "sprintDays", 1, 365);
    const availableDays = numberField(body, "availableDays", 1, 40);
    const sourceKeys = Array.isArray(body.sourceKeys) ? body.sourceKeys.filter((item): item is string => typeof item === "string") : [];
    const extraContext = typeof body.extraContext === "string" ? body.extraContext.slice(0, 3000) : "";
    if (availableDays > sprintDays) throw new HttpError(400, "Available days cannot be greater than the sprint length.");
    if (new Set(sourceKeys).size !== sourceKeys.length || sourceKeys.length < 2 || sourceKeys.length > 20) throw new HttpError(400, "Select between 2 and 20 different source Stories.");

    const projects = await listProjects(session);
    const project = projects.find((item) => item.key === projectKey);
    if (!project) throw new HttpError(400, "The selected Jira project is unavailable to this account.");
    const boards = await listBoards(session, projectKey);
    if (!boards.some((board) => board.id === boardId)) throw new HttpError(400, "The selected board does not belong to this project.");
    const sprints = await listSprints(session, boardId);
    if (!sprints.some((sprint) => sprint.id === sprintId)) throw new HttpError(400, "The selected sprint is not active or planned on this board.");

    const sources = await getSourceStories(session, projectKey, sprintId, sourceKeys);
    if (sources.length !== sourceKeys.length) throw new HttpError(400, "One or more selected source Stories could not be loaded.");
    const drafts = await generateDrafts({ sources, sprintDays, availableDays, extraContext });
    const batch: DraftBatch = { id: randomUUID(), sessionId: session.id, siteId: session.activeSiteId || "", projectKey, sprintId, sourceStories: sources, drafts };
    batches.set(batch.id, batch);
    sendJson(response, 200, { batchId: batch.id, drafts });
    return;
  }

  if (method === "POST" && pathname === "/api/create") {
    const session = requireSession(request);
    const body = await readBody(request);
    const batchId = stringField(body, "batchId", 100);
    const batch = batches.get(batchId);
    if (!batch || batch.sessionId !== session.id || batch.siteId !== session.activeSiteId) throw new HttpError(404, "This draft batch expired or belongs to another Jira site. Generate the Stories again.");
    if (batchLocks.has(batchId)) throw new HttpError(409, "These Stories are already being created. Wait for the current request to finish.");
    if (!Array.isArray(body.drafts) || body.drafts.length !== batch.drafts.length) throw new HttpError(400, "Review all draft Stories before creating them.");

    const submitted = new Map<string, unknown>();
    for (const draft of body.drafts) {
      if (!draft || typeof draft !== "object" || typeof (draft as { id?: unknown }).id !== "string") throw new HttpError(400, "A draft was invalid.");
      submitted.set((draft as { id: string }).id, draft);
    }
    if (submitted.size !== batch.drafts.length) throw new HttpError(400, "A draft was repeated or missing.");
    const approvedDrafts = batch.drafts.map((original) => asSafeDraft(submitted.get(original.id), original));
    const sourcesByKey = new Map(batch.sourceStories.map((story) => [story.key, story]));
    const project = (await listProjects(session)).find((item) => item.key === batch.projectKey);
    if (!project) throw new HttpError(400, "The target project is no longer available.");
    const issueTypeId = await getIssueTypes(session, project.id);
    const results: Array<{ draftId: string; title: string; issueKey?: string; status: "created" | "created_not_sprinted" | "failed"; message?: string }> = [];

    batchLocks.add(batchId);
    try {
      for (const draft of approvedDrafts) {
        const source = sourcesByKey.get(draft.sourceIssueKey);
        if (!source) {
          results.push({ draftId: draft.id, title: draft.title, status: "failed", message: "The source Story is missing from this draft batch." });
          continue;
        }
        const label = `sprint-planner-${batch.id.replace(/-/g, "").slice(0, 10)}-${draft.id.replace(/-/g, "").slice(0, 10)}`;
        try {
          const savedDraft = batch.drafts.find((item) => item.id === draft.id)!;
          let issueKey = savedDraft.createdIssueKey;
          if (!issueKey) {
            issueKey = await findIssueByLabel(session, batch.projectKey, label);
            if (!issueKey) issueKey = await createStoryIssue(session, batch.projectKey, issueTypeId, label, source, draft);
            savedDraft.createdIssueKey = issueKey;
          }
          try {
            await addIssueToSprint(session, batch.sprintId, issueKey);
            savedDraft.status = "created";
            results.push({ draftId: draft.id, title: draft.title, issueKey, status: "created" });
          } catch (error) {
            savedDraft.status = "created_not_sprinted";
            results.push({ draftId: draft.id, title: draft.title, issueKey, status: "created_not_sprinted", message: error instanceof Error ? error.message : "Could not add the issue to the sprint." });
          }
        } catch (error) {
          results.push({ draftId: draft.id, title: draft.title, status: "failed", message: error instanceof Error ? error.message : "Could not create the issue." });
        }
      }
    } finally {
      batchLocks.delete(batchId);
    }
    sendJson(response, results.some((result) => result.status !== "created") ? 207 : 201, { results });
    return;
  }

  sendJson(response, 404, { error: "Not found." });
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/auth/jira/start" && request.method === "GET") {
      const clientId = process.env.ATLASSIAN_CLIENT_ID;
      if (!clientId || !process.env.ATLASSIAN_CLIENT_SECRET) throw new HttpError(503, "Add the Atlassian OAuth credentials to .env first.");
      const existingId = sessionIdFromRequest(request);
      const session = existingId ? getSessionById(existingId) || createSession() : createSession();
      setSessionCookie(response, session.id);
      const state = randomBytes(32).toString("base64url");
      rememberOAuthState(state, session.id);
      const redirectUri = process.env.ATLASSIAN_REDIRECT_URI || "http://localhost:3000/auth/jira/callback";
      const scopes = ["read:jira-work", "write:jira-work", "read:sprint:jira-software", "write:sprint:jira-software", "offline_access"].join(" ");
      const authorize = new URL("https://auth.atlassian.com/authorize");
      authorize.search = new URLSearchParams({ audience: "api.atlassian.com", client_id: clientId, scope: scopes, redirect_uri: redirectUri, state, response_type: "code", prompt: "consent" }).toString();
      response.writeHead(302, { Location: authorize.toString(), "Cache-Control": "no-store" });
      response.end();
      return;
    }

    if (url.pathname === "/auth/jira/callback" && request.method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const receivedSessionId = sessionIdFromRequest(request);
      const expectedSessionId = state ? consumeOAuthState(state) : undefined;
      if (!code || !expectedSessionId || expectedSessionId !== receivedSessionId) throw new HttpError(400, "Jira sign-in could not be verified. Return to the app and connect again.");
      const session = getSessionById(expectedSessionId);
      if (!session) throw new HttpError(400, "The sign-in session expired. Connect Jira again.");
      session.tokens = await exchangeAuthorizationCode(code);
      session.sites = await loadAccessibleSites(session.tokens.accessToken);
      session.activeSiteId = session.sites.length === 1 ? session.sites[0].id : undefined;
      saveSession(session);
      response.writeHead(302, { Location: "/?connected=1", "Cache-Control": "no-store" });
      response.end();
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }

    if (request.method === "GET" && url.pathname === "/") {
      const file = await staticFile("index.html");
      sendText(response, 200, file.body, file.type);
      return;
    }
    if (request.method === "GET" && url.pathname === "/styles.css") {
      const file = await staticFile("styles.css");
      sendText(response, 200, file.body, file.type);
      return;
    }
    if (request.method === "GET" && url.pathname === "/app.js") {
      const source = await readFile(resolve(ROOT, "src/client.ts"), "utf8");
      const clientScript = stripTypeScriptTypes(source, { mode: "strip", sourceUrl: "client.ts" });
      sendText(response, 200, clientScript, "text/javascript; charset=utf-8");
      return;
    }
    sendText(response, 404, "Not found.", "text/plain; charset=utf-8");
  } catch (error) {
    const status = error instanceof HttpError || error instanceof JiraError || error instanceof GenerationError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    if (status >= 500) console.error("Request failed:", message);
    if (url.pathname === "/auth/jira/start" || url.pathname === "/auth/jira/callback") {
      sendText(response, status, `<!doctype html><title>Jira connection error</title><p>${escapeHtml(message)}</p><p><a href="/">Return to Sprint Planner</a></p>`, "text/html; charset=utf-8");
      return;
    }
    sendJson(response, status, { error: message });
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const server = createServer((request, response) => {
  void handleRequest(request, response);
});

server.listen(port, host, () => {
  console.log(`Jira Sprint Planner is running at http://${host}:${port}`);
  if (!process.env.ATLASSIAN_CLIENT_ID || !process.env.ATLASSIAN_CLIENT_SECRET) console.log("Set Atlassian OAuth credentials in .env to connect Jira.");
  if (!process.env.OPENAI_API_KEY) console.log("Set OPENAI_API_KEY in .env to generate Story drafts.");
});
