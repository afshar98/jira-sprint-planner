import type { JiraSession, JiraProject, JiraBoard, JiraSprint, SourceStory } from "./types.ts";

const API_ROOT = "https://api.atlassian.com/ex/jira";
const AUTH_ROOT = "https://auth.atlassian.com";

export class JiraError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "JiraError";
    this.status = status;
  }
}

function selectedSite(session: JiraSession) {
  const site = session.sites.find((candidate) => candidate.id === session.activeSiteId);
  if (!site) throw new JiraError("Choose a Jira site before continuing.", 400);
  return site;
}

export async function exchangeAuthorizationCode(code: string) {
  const clientId = process.env.ATLASSIAN_CLIENT_ID;
  const clientSecret = process.env.ATLASSIAN_CLIENT_SECRET;
  const redirectUri = process.env.ATLASSIAN_REDIRECT_URI || "http://localhost:3000/auth/jira/callback";
  if (!clientId || !clientSecret) throw new JiraError("Add the Atlassian client ID and secret to .env.", 503);

  const response = await fetch(`${AUTH_ROOT}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
  });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof data.access_token !== "string") {
    throw new JiraError("Jira authorization failed. Check the OAuth callback URL and app credentials.", response.status || 502);
  }
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  };
}

export async function loadAccessibleSites(accessToken: string) {
  const response = await fetch(`${AUTH_ROOT}/oauth/token/accessible-resources`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!response.ok) throw new JiraError("Could not load the Jira sites available to this account.", response.status);
  const resources = await response.json() as Array<Record<string, unknown>>;
  return resources.map((resource) => ({
    id: String(resource.id),
    name: String(resource.name || resource.url || "Jira site"),
    url: String(resource.url || ""),
    scopes: Array.isArray(resource.scopes) ? resource.scopes.map(String) : [],
  }));
}

async function refreshTokens(session: JiraSession): Promise<void> {
  if (!session.tokens.refreshToken) throw new JiraError("Your Jira connection expired. Connect Jira again.", 401);
  const clientId = process.env.ATLASSIAN_CLIENT_ID;
  const clientSecret = process.env.ATLASSIAN_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new JiraError("Add the Atlassian client ID and secret to .env.", 503);

  const response = await fetch(`${AUTH_ROOT}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: session.tokens.refreshToken }),
  });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof data.access_token !== "string") {
    session.tokens = { accessToken: "", expiresAt: 0 };
    throw new JiraError("Your Jira connection expired. Connect Jira again.", 401);
  }
  session.tokens = {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : session.tokens.refreshToken,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  };
}

export async function jiraRequest<T>(session: JiraSession, path: string, init: RequestInit = {}): Promise<T> {
  const site = selectedSite(session);
  if (session.tokens.expiresAt < Date.now() + 60_000) await refreshTokens(session);

  const request = () => fetch(`${API_ROOT}/${encodeURIComponent(site.id)}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${session.tokens.accessToken}`,
      ...init.headers,
    },
  });
  let response = await request();
  if (response.status === 401 && session.tokens.refreshToken) {
    await refreshTokens(session);
    response = await request();
  }
  if (!response.ok) {
    const details = await response.json().catch(() => ({})) as { errorMessages?: string[]; message?: string };
    const message = details.errorMessages?.[0] || details.message || `Jira returned ${response.status}. Check your project permissions and OAuth scopes.`;
    throw new JiraError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

export async function listProjects(session: JiraSession): Promise<JiraProject[]> {
  const result = await jiraRequest<{ values?: Array<Record<string, unknown>> }>(session, "/rest/api/3/project/search?startAt=0&maxResults=100");
  return (result.values || []).map((project) => ({
    id: String(project.id),
    key: String(project.key),
    name: String(project.name),
    projectTypeKey: typeof project.projectTypeKey === "string" ? project.projectTypeKey : undefined,
  }));
}

export async function listBoards(session: JiraSession, projectKey: string): Promise<JiraBoard[]> {
  const query = new URLSearchParams({ projectKeyOrId: projectKey, maxResults: "50" });
  const result = await jiraRequest<{ values?: Array<Record<string, unknown>> }>(session, `/rest/agile/1.0/board?${query}`);
  return (result.values || [])
    .map((board) => ({ id: Number(board.id), name: String(board.name), type: String(board.type || "") }))
    .filter((board) => board.type.toLowerCase() === "scrum");
}

export async function listSprints(session: JiraSession, boardId: number): Promise<JiraSprint[]> {
  const query = new URLSearchParams({ state: "active,future", maxResults: "50" });
  const result = await jiraRequest<{ values?: Array<Record<string, unknown>> }>(session, `/rest/agile/1.0/board/${boardId}/sprint?${query}`);
  return (result.values || []).map((sprint) => ({
    id: Number(sprint.id),
    name: String(sprint.name),
    state: String(sprint.state || "future"),
    startDate: typeof sprint.startDate === "string" ? sprint.startDate : undefined,
    endDate: typeof sprint.endDate === "string" ? sprint.endDate : undefined,
    goal: typeof sprint.goal === "string" ? sprint.goal : undefined,
  }));
}

function adfText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const value = node as { text?: unknown; content?: unknown[]; type?: unknown };
  if (typeof value.text === "string") return value.text;
  if (!Array.isArray(value.content)) return "";
  const joined = value.content.map(adfText).join("");
  return ["paragraph", "heading", "listItem", "blockquote"].includes(String(value.type)) ? `${joined}\n` : joined;
}

export async function listSourceStories(session: JiraSession, projectKey: string, sprintId: number, search = ""): Promise<SourceStory[]> {
  const safeProjectKey = projectKey.replace(/[^A-Za-z0-9_-]/g, "");
  if (!safeProjectKey || !Number.isInteger(sprintId) || sprintId <= 0) throw new JiraError("Choose a valid project and sprint.", 400);
  const jqlParts = [`project = "${safeProjectKey}"`, `sprint = ${sprintId}`, 'issuetype = "Story"'];
  if (search.trim()) {
    const safeSearch = search.trim().replace(/[\\"']/g, "\\$&").slice(0, 80);
    jqlParts.push(`text ~ "${safeSearch}"`);
  }
  const result = await jiraRequest<{ issues?: Array<Record<string, unknown>> }>(session, "/rest/api/3/search/jql", {
    method: "POST",
    body: JSON.stringify({ jql: `${jqlParts.join(" AND ")} ORDER BY priority DESC, updated DESC`, maxResults: 50, fields: ["summary", "description", "priority", "issuetype"] }),
  });

  return (result.issues || []).map((issue) => {
    const fields = (issue.fields || {}) as Record<string, unknown>;
    const priority = fields.priority && typeof fields.priority === "object" ? String((fields.priority as Record<string, unknown>).name || "Unprioritized") : "Unprioritized";
    const issueType = fields.issuetype && typeof fields.issuetype === "object" ? String((fields.issuetype as Record<string, unknown>).name || "Story") : "Story";
    return {
      key: String(issue.key),
      summary: String(fields.summary || "Untitled story"),
      description: adfText(fields.description).trim(),
      priority,
      issueType,
      url: `${selectedSite(session).url.replace(/\/$/, "")}/browse/${String(issue.key)}`,
    };
  });
}

export async function getSourceStories(session: JiraSession, projectKey: string, sprintId: number, keys: string[]): Promise<SourceStory[]> {
  const safeKeys = keys.map((key) => key.replace(/[^A-Za-z0-9_-]/g, ""));
  if (safeKeys.some((key) => !key) || !Number.isInteger(sprintId) || sprintId <= 0) throw new JiraError("Select valid source Stories and a sprint.", 400);
  const jql = `project = "${projectKey}" AND sprint = ${sprintId} AND issuetype = "Story" AND key in (${safeKeys.join(",")})`;
  const result = await jiraRequest<{ issues?: Array<Record<string, unknown>> }>(session, "/rest/api/3/search/jql", {
    method: "POST",
    body: JSON.stringify({ jql, maxResults: safeKeys.length, fields: ["summary", "description", "priority", "issuetype", "project"] }),
  });
  const issues = result.issues || [];
  if (issues.length !== keys.length) throw new JiraError("One or more selected Stories are not in the chosen sprint or are no longer available.", 400);
  return issues.map((issue) => {
    const fields = (issue.fields || {}) as Record<string, unknown>;
    const issueProject = fields.project && typeof fields.project === "object" ? String((fields.project as Record<string, unknown>).key) : "";
    const issueType = fields.issuetype && typeof fields.issuetype === "object" ? String((fields.issuetype as Record<string, unknown>).name || "") : "";
    if (issueProject !== projectKey || issueType.toLowerCase() !== "story") throw new JiraError("A selected source issue is outside the chosen project or Story type.", 400);
    const priority = fields.priority && typeof fields.priority === "object" ? String((fields.priority as Record<string, unknown>).name || "Unprioritized") : "Unprioritized";
    return {
      key: String(issue.key),
      summary: String(fields.summary || "Untitled story"),
      description: adfText(fields.description).trim(),
      priority,
      issueType,
      url: `${selectedSite(session).url.replace(/\/$/, "")}/browse/${String(issue.key)}`,
    };
  });
}

export async function getStoryIssueTypeId(session: JiraSession, projectId: string): Promise<string> {
  const query = new URLSearchParams({ projectId });
  const issueTypes = await jiraRequest<Array<Record<string, unknown>>>(session, `/rest/api/3/issuetype/project?${query}`);
  const story = issueTypes.find((issueType) => String(issueType.name).toLowerCase() === "story" && issueType.subtask !== true);
  if (!story) throw new JiraError("The selected project does not have a Story issue type.", 400);
  return String(story.id);
}

export function storyDescriptionAdf(story: SourceStory, draft: { title: string; subtasks: string[]; definitionOfDone: string[] }) {
  const text = (value: string) => ({ type: "text", text: value });
  const paragraph = (value: string) => ({ type: "paragraph", content: [text(value)] });
  const bulletList = (items: string[]) => ({
    type: "bulletList",
    content: items.map((item) => ({ type: "listItem", content: [paragraph(item)] })),
  });
  return {
    type: "doc",
    version: 1,
    content: [
      paragraph(`Breakdown of ${story.key}: ${story.summary}`),
      paragraph("Planning estimate: approximately one available workday."),
      { type: "heading", attrs: { level: 2 }, content: [text("Subtasks")] },
      bulletList(draft.subtasks),
      { type: "heading", attrs: { level: 2 }, content: [text("Definition of Done")] },
      bulletList(draft.definitionOfDone),
    ],
  };
}

export async function createStoryIssue(session: JiraSession, projectKey: string, issueTypeId: string, label: string, story: SourceStory, draft: { title: string; subtasks: string[]; definitionOfDone: string[] }): Promise<string> {
  const result = await jiraRequest<{ key: string }>(session, "/rest/api/3/issue", {
    method: "POST",
    body: JSON.stringify({
      fields: {
        project: { key: projectKey },
        summary: draft.title,
        description: storyDescriptionAdf(story, draft),
        issuetype: { id: issueTypeId },
        labels: [label],
      },
    }),
  });
  return result.key;
}

export async function findIssueByLabel(session: JiraSession, projectKey: string, label: string): Promise<string | undefined> {
  const result = await jiraRequest<{ issues?: Array<{ key: string }> }>(session, "/rest/api/3/search/jql", {
    method: "POST",
    body: JSON.stringify({ jql: `project = "${projectKey}" AND labels = "${label}"`, maxResults: 1, fields: ["key"] }),
  });
  return result.issues?.[0]?.key;
}

export async function addIssueToSprint(session: JiraSession, sprintId: number, issueKey: string): Promise<void> {
  await jiraRequest<void>(session, `/rest/agile/1.0/sprint/${sprintId}/issue`, {
    method: "POST",
    body: JSON.stringify({ issues: [issueKey] }),
  });
}
