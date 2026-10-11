import type { DraftStory, JiraBoard, JiraProject, JiraSprint, SourceStory } from "./types.ts";

type AppStatus = {
  connected: boolean;
  sites: Array<{ id: string; name: string; url: string }>;
  activeSiteId: string;
  aiConfigured: boolean;
  jiraConfigured: boolean;
};

type GenerationResult = { batchId: string; drafts: DraftStory[] };
type CreationResult = { results: Array<{ draftId: string; title: string; issueKey?: string; status: "created" | "created_not_sprinted" | "failed"; message?: string }> };

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const connectButton = byId<HTMLButtonElement>("connectButton");
const disconnectButton = byId<HTMLButtonElement>("disconnectButton");
const planner = byId<HTMLElement>("planner");
const connectionPanel = byId<HTMLElement>("connectionPanel");
const setupWarning = byId<HTMLElement>("setupWarning");
const siteChoiceWrap = byId<HTMLElement>("siteChoiceWrap");
const siteSelect = byId<HTMLSelectElement>("siteSelect");
const projectSelect = byId<HTMLSelectElement>("projectSelect");
const boardSelect = byId<HTMLSelectElement>("boardSelect");
const sprintSelect = byId<HTMLSelectElement>("sprintSelect");
const storySearch = byId<HTMLInputElement>("storySearch");
const issueList = byId<HTMLElement>("issueList");
const selectionCount = byId<HTMLElement>("selectionCount");
const sprintDaysInput = byId<HTMLInputElement>("sprintDays");
const availableDaysInput = byId<HTMLInputElement>("availableDays");
const extraContext = byId<HTMLTextAreaElement>("extraContext");
const capacityPreview = byId<HTMLElement>("capacityPreview");
const availabilityHint = byId<HTMLElement>("availabilityHint");
const generateButton = byId<HTMLButtonElement>("generateButton");
const formNotice = byId<HTMLElement>("formNotice");
const draftSection = byId<HTMLElement>("draftSection");
const draftList = byId<HTMLElement>("draftList");
const draftSubtitle = byId<HTMLElement>("draftSubtitle");
const readyCount = byId<HTMLElement>("readyCount");
const createButton = byId<HTMLButtonElement>("createButton");
const createNotice = byId<HTMLElement>("createNotice");
const connectionIndicator = byId<HTMLElement>("connectionIndicator");
const connectionLabel = byId<HTMLElement>("connectionLabel");
const toast = byId<HTMLElement>("toast");

let appStatus: AppStatus | undefined;
let projects: JiraProject[] = [];
let boards: JiraBoard[] = [];
let sprints: JiraSprint[] = [];
let sourceStories: SourceStory[] = [];
let selectedKeys = new Set<string>();
let batchId = "";
let batchPlanFingerprint = "";
let drafts: DraftStory[] = [];
let searchTimer: number | undefined;
let toastTimer: number | undefined;

function option(value: string, label: string, selected = false): HTMLOptionElement {
  const item = document.createElement("option");
  item.value = value;
  item.textContent = label;
  item.selected = selected;
  return item;
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
  });
  const body = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok && response.status !== 207) throw new Error(body.error || `Request failed with status ${response.status}.`);
  return body;
}

function postJson(body: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(body) };
}

function showNotice(target: HTMLElement, message: string, kind: "error" | "success" | "warning" | "info" = "info"): void {
  target.textContent = message;
  target.className = `notice notice-${kind}`;
  target.classList.remove("hidden");
}

function hideNotice(target: HTMLElement): void {
  target.classList.add("hidden");
  target.textContent = "";
}

function showToast(message: string): void {
  toast.textContent = message;
  toast.classList.remove("hidden");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.add("hidden"), 3600);
}

function setConnected(connected: boolean): void {
  connectionIndicator.classList.toggle("connected", connected);
  connectionLabel.textContent = connected ? "Jira connected" : "Not connected";
  disconnectButton.classList.toggle("hidden", !connected);
  connectionPanel.classList.toggle("hidden", connected);
  planner.classList.toggle("hidden", !connected);
}

function selectedProject(): JiraProject | undefined {
  return projects.find((project) => project.key === projectSelect.value);
}

function refreshGenerateButton(): void {
  const sprintDays = Number(sprintDaysInput.value);
  const availableDays = Number(availableDaysInput.value);
  const validDays = Number.isInteger(sprintDays) && sprintDays > 0 && Number.isInteger(availableDays) && availableDays > 0 && availableDays <= sprintDays && availableDays <= 40;
  const validStories = selectedKeys.size >= 2 && selectedKeys.size <= 20;
  const ready = Boolean(appStatus?.aiConfigured && appStatus.connected && appStatus.activeSiteId && projectSelect.value && boardSelect.value && sprintSelect.value && validDays && validStories);
  generateButton.disabled = !ready;
  refreshCreateAvailability();
  capacityPreview.querySelector("strong")!.textContent = String(Number.isInteger(availableDays) && availableDays > 0 ? availableDays : 0);

  if (!Number.isInteger(sprintDays) || sprintDays < 1 || !Number.isInteger(availableDays) || availableDays < 1) {
    availabilityHint.textContent = "Enter positive whole numbers for sprint and available days.";
    availabilityHint.classList.add("error-text");
  } else if (availableDays > sprintDays) {
    availabilityHint.textContent = "Available days cannot exceed the sprint length.";
    availabilityHint.classList.add("error-text");
  } else if (availableDays > 40) {
    availabilityHint.textContent = "The first version supports up to 40 Stories per plan.";
    availabilityHint.classList.add("error-text");
  } else {
    const spare = sprintDays - availableDays;
    availabilityHint.textContent = spare === 0 ? "You have capacity for every sprint day." : `The other ${spare} sprint ${spare === 1 ? "day will" : "days will"} stay unplanned.`;
    availabilityHint.classList.remove("error-text");
  }
}

function currentPlanFingerprint(): string {
  return JSON.stringify({
    siteId: appStatus?.activeSiteId || "",
    projectKey: projectSelect.value,
    boardId: boardSelect.value,
    sprintId: sprintSelect.value,
    sprintDays: sprintDaysInput.value,
    availableDays: availableDaysInput.value,
    sourceKeys: [...selectedKeys].sort(),
  });
}

function refreshCreateAvailability(): void {
  if (!batchId || !drafts.length) return;
  const matchesPlan = currentPlanFingerprint() === batchPlanFingerprint;
  const allCreated = drafts.every((draft) => draft.status === "created");
  createButton.disabled = !matchesPlan || allCreated;
  if (!matchesPlan) {
    showNotice(createNotice, "Plan settings changed. Return to the settings used for these drafts or generate a new set before creating them.", "warning");
  } else if (createNotice.textContent?.startsWith("Plan settings changed.")) {
    hideNotice(createNotice);
  }
}

function updateSelectionCount(): void {
  const count = selectedKeys.size;
  selectionCount.textContent = `${count} selected`;
  selectionCount.classList.toggle("has-selection", count > 0);
  refreshGenerateButton();
}

function priorityClass(priority: string): string {
  const value = priority.toLowerCase();
  if (value.includes("highest") || value.includes("blocker")) return "priority-highest";
  if (value.includes("high") || value.includes("critical")) return "priority-high";
  if (value.includes("medium") || value.includes("normal")) return "priority-medium";
  return "";
}

function renderIssues(): void {
  issueList.replaceChildren();
  if (!sourceStories.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = !projectSelect.value ? "Choose a project to load its Stories." : !sprintSelect.value ? "Choose a sprint to load its Stories." : "No matching Jira Stories in this sprint. Try another search.";
    issueList.append(empty);
    return;
  }

  for (const story of sourceStories) {
    const label = document.createElement("label");
    label.className = `issue-row${selectedKeys.has(story.key) ? " selected" : ""}`;
    const checkbox = document.createElement("input");
    checkbox.className = "issue-check";
    checkbox.type = "checkbox";
    checkbox.value = story.key;
    checkbox.checked = selectedKeys.has(story.key);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedKeys.add(story.key);
      else selectedKeys.delete(story.key);
      label.classList.toggle("selected", checkbox.checked);
      updateSelectionCount();
    });
    const info = document.createElement("span");
    info.className = "issue-info";
    const title = document.createElement("span");
    title.className = "issue-title";
    title.textContent = story.summary;
    const meta = document.createElement("span");
    meta.className = "issue-meta";
    const key = document.createElement("span");
    key.className = "issue-key";
    key.textContent = story.key;
    const priority = document.createElement("span");
    priority.className = `priority ${priorityClass(story.priority)}`;
    const dot = document.createElement("i");
    dot.className = "priority-dot";
    const priorityText = document.createElement("span");
    priorityText.textContent = story.priority;
    priority.append(dot, priorityText);
    meta.append(key, priority);
    info.append(title, meta);
    label.append(checkbox, info);
    issueList.append(label);
  }
  updateSelectionCount();
}

async function loadProjects(): Promise<void> {
  const result = await requestJson<{ projects: JiraProject[] }>("/api/projects");
  projects = result.projects;
  projectSelect.replaceChildren(option("", "Choose a project"));
  for (const project of projects) projectSelect.append(option(project.key, `${project.name} · ${project.key}`));
  projectSelect.disabled = false;
  if (!projects.length) showNotice(formNotice, "No Jira projects are available to this account.", "warning");
}

async function loadBoards(projectKey: string): Promise<void> {
  boardSelect.disabled = true;
  boardSelect.replaceChildren(option("", "Loading boards…"));
  sprintSelect.disabled = true;
  sprintSelect.replaceChildren(option("", "Choose a board first"));
  try {
    const result = await requestJson<{ boards: JiraBoard[] }>(`/api/boards?projectKey=${encodeURIComponent(projectKey)}`);
    boards = result.boards;
    boardSelect.replaceChildren(option("", boards.length ? "Choose a Scrum board" : "No board found for this project"));
    for (const board of boards) boardSelect.append(option(String(board.id), `${board.name} · ${board.type}`));
    boardSelect.disabled = !boards.length;
  } catch (error) {
    boardSelect.replaceChildren(option("", "Could not load boards"));
    showNotice(formNotice, error instanceof Error ? error.message : "Could not load Jira boards.", "error");
  }
  refreshGenerateButton();
}

async function loadSprints(boardId: string): Promise<void> {
  sprintSelect.disabled = true;
  sprintSelect.replaceChildren(option("", "Loading sprints…"));
  try {
    const result = await requestJson<{ sprints: JiraSprint[] }>(`/api/sprints?boardId=${encodeURIComponent(boardId)}`);
    sprints = result.sprints;
    sprintSelect.replaceChildren(option("", sprints.length ? "Choose an active or upcoming sprint" : "No active or upcoming sprints"));
    for (const sprint of sprints) {
      const state = sprint.state === "active" ? "Active" : "Upcoming";
      sprintSelect.append(option(String(sprint.id), `${sprint.name} · ${state}`));
    }
    sprintSelect.disabled = !sprints.length;
  } catch (error) {
    sprintSelect.replaceChildren(option("", "Could not load sprints"));
    showNotice(formNotice, error instanceof Error ? error.message : "Could not load Jira sprints.", "error");
  }
  refreshGenerateButton();
}

async function loadIssues(): Promise<void> {
  if (!projectSelect.value || !sprintSelect.value) {
    sourceStories = [];
    storySearch.disabled = true;
    renderIssues();
    return;
  }
  issueList.innerHTML = "<div class=\"empty-state\">Loading Stories…</div>";
  storySearch.disabled = false;
  try {
    const query = new URLSearchParams({ projectKey: projectSelect.value, sprintId: sprintSelect.value, search: storySearch.value });
    const result = await requestJson<{ issues: SourceStory[] }>(`/api/issues?${query}`);
    sourceStories = result.issues;
    renderIssues();
  } catch (error) {
    sourceStories = [];
    renderIssues();
    showNotice(formNotice, error instanceof Error ? error.message : "Could not load source Stories.", "error");
  }
}

function renderSiteChoices(): void {
  if (!appStatus) return;
  siteChoiceWrap.classList.toggle("hidden", appStatus.sites.length < 2);
  if (appStatus.sites.length < 2) return;
  siteSelect.replaceChildren(option("", "Choose a Jira workspace", !appStatus.activeSiteId));
  for (const site of appStatus.sites) siteSelect.append(option(site.id, site.name, site.id === appStatus.activeSiteId));
}

async function refreshStatus(): Promise<void> {
  appStatus = await requestJson<AppStatus>("/api/status");
  setConnected(appStatus.connected);
  renderSiteChoices();
  if (!appStatus.jiraConfigured) {
    setupWarning.textContent = "Add ATLASSIAN_CLIENT_ID and ATLASSIAN_CLIENT_SECRET to .env, then restart the app.";
    setupWarning.classList.remove("hidden");
    connectButton.disabled = true;
  } else {
    connectButton.disabled = false;
    setupWarning.classList.add("hidden");
  }
  if (appStatus.connected && !appStatus.aiConfigured) showNotice(formNotice, "Add OPENAI_API_KEY to .env and restart the app before generating drafts.", "warning");
  if (appStatus.connected && appStatus.activeSiteId) await loadProjects();
  refreshGenerateButton();
}

function createDraftField(labelText: string, value: string, className: string, onInput: (value: string) => void): HTMLTextAreaElement | HTMLInputElement {
  const field = labelText === "Story title" ? document.createElement("input") : document.createElement("textarea");
  field.className = `text-control ${className}`;
  field.value = value;
  field.setAttribute("aria-label", labelText);
  if (field instanceof HTMLTextAreaElement) {
    field.rows = 3;
    field.addEventListener("input", () => onInput(field.value));
  } else {
    field.type = "text";
    field.maxLength = 250;
    field.addEventListener("input", () => onInput(field.value));
  }
  return field;
}

function makeDraftCard(draft: DraftStory, index: number): HTMLElement {
  const card = document.createElement("article");
  card.className = "draft-card";
  const top = document.createElement("div");
  top.className = "draft-card-top";
  const number = document.createElement("div");
  number.className = "draft-number";
  const badge = document.createElement("span");
  badge.textContent = String(index + 1).padStart(2, "0");
  const label = document.createElement("span");
  label.textContent = `One-day draft · ${index + 1}`;
  number.append(badge, label);
  const source = document.createElement("div");
  source.className = "source-badge";
  const sourceStory = sourceStories.find((story) => story.key === draft.sourceIssueKey);
  const sourceKey = document.createElement("strong");
  sourceKey.textContent = draft.sourceIssueKey;
  const sourceTitle = document.createElement("span");
  sourceTitle.textContent = sourceStory?.summary || "Source Story";
  source.append(sourceKey, sourceTitle);
  top.append(number, source);

  const titleField = document.createElement("div");
  titleField.className = "draft-field";
  const titleLabel = document.createElement("label");
  titleLabel.className = "field-label";
  titleLabel.textContent = "Story title";
  const titleInput = createDraftField("Story title", draft.title, "draft-title-input", (value) => { draft.title = value; });
  titleLabel.htmlFor = `draft-title-${draft.id}`;
  titleInput.id = `draft-title-${draft.id}`;
  titleField.append(titleLabel, titleInput);

  const checklistField = document.createElement("div");
  checklistField.className = "draft-field";
  const checklistLabel = document.createElement("label");
  checklistLabel.className = "field-label";
  checklistLabel.textContent = "Subtask checklist · one item per line";
  const checklist = createDraftField("Subtask checklist", draft.subtasks.join("\n"), "draft-textarea", (value) => { draft.subtasks = value.split("\n").map((item) => item.trim()).filter(Boolean); });
  checklistLabel.htmlFor = `draft-checklist-${draft.id}`;
  checklist.id = `draft-checklist-${draft.id}`;
  checklistField.append(checklistLabel, checklist);

  const doneField = document.createElement("div");
  doneField.className = "draft-field";
  const doneLabel = document.createElement("label");
  doneLabel.className = "field-label";
  doneLabel.textContent = "Definition of Done · one item per line";
  const done = createDraftField("Definition of Done", draft.definitionOfDone.join("\n"), "draft-textarea", (value) => { draft.definitionOfDone = value.split("\n").map((item) => item.trim()).filter(Boolean); });
  doneLabel.htmlFor = `draft-dod-${draft.id}`;
  done.id = `draft-dod-${draft.id}`;
  doneField.append(doneLabel, done);

  card.append(top, titleField, checklistField, doneField);
  return card;
}

function renderDrafts(): void {
  draftList.replaceChildren(...drafts.map((draft, index) => makeDraftCard(draft, index)));
  readyCount.textContent = `${drafts.length} drafts ready`;
  createButton.disabled = false;
}

async function generate(): Promise<void> {
  hideNotice(formNotice);
  generateButton.disabled = true;
  generateButton.innerHTML = "<span class=\"spinner\"></span><span>Drafting your Stories…</span>";
  const originalText = "Generate draft Stories";
  try {
    const result = await requestJson<GenerationResult>("/api/generate", postJson({
      projectKey: projectSelect.value,
      boardId: Number(boardSelect.value),
      sprintId: Number(sprintSelect.value),
      sprintDays: Number(sprintDaysInput.value),
      availableDays: Number(availableDaysInput.value),
      sourceKeys: [...selectedKeys],
      extraContext: extraContext.value,
    }));
    batchId = result.batchId;
    batchPlanFingerprint = currentPlanFingerprint();
    drafts = result.drafts;
    const sprintName = sprints.find((sprint) => String(sprint.id) === sprintSelect.value)?.name || "selected sprint";
    draftSubtitle.textContent = `${drafts.length} Stories drafted from ${selectedKeys.size} Jira sources in ${sprintName}, for ${availableDaysInput.value} available days.`;
    hideNotice(createNotice);
    renderDrafts();
    draftSection.classList.remove("hidden");
    draftSection.scrollIntoView({ behavior: "smooth", block: "start" });
    showToast("Drafts are ready for your review.");
  } catch (error) {
    showNotice(formNotice, error instanceof Error ? error.message : "Could not generate draft Stories.", "error");
  } finally {
    generateButton.textContent = originalText;
    refreshGenerateButton();
  }
}

function renderCreationResults(result: CreationResult): void {
  createNotice.replaceChildren();
  const created = result.results.filter((item) => item.status === "created").length;
  const failed = result.results.filter((item) => item.status === "failed").length;
  const pendingSprint = result.results.filter((item) => item.status === "created_not_sprinted").length;
  const summary = document.createElement("div");
  summary.textContent = failed || pendingSprint
    ? `${created} created in the sprint, ${pendingSprint} created but not added to the sprint, ${failed} failed. You can retry the remaining items.`
    : `All ${created} Stories were created and added to the sprint.`;
  createNotice.className = `notice ${failed || pendingSprint ? "notice-warning" : "notice-success"}`;
  createNotice.append(summary);
  const list = document.createElement("div");
  list.className = "result-list";
  for (const item of result.results) {
    const row = document.createElement("div");
    row.className = "result-row";
    const title = document.createElement("span");
    title.textContent = item.title;
    const status = document.createElement("span");
    status.className = `result-status${item.status === "failed" ? " failed" : item.status === "created_not_sprinted" ? " partial" : ""}`;
    status.textContent = item.issueKey ? `${item.issueKey} · ${item.status === "created" ? "in sprint" : item.status === "created_not_sprinted" ? "not in sprint" : "created"}` : "Failed";
    row.append(title, status);
    list.append(row);
    if (item.status === "created") {
      const draft = drafts.find((candidate) => candidate.id === item.draftId);
      if (draft) draft.status = "created";
    }
    if (item.status === "created_not_sprinted") {
      const draft = drafts.find((candidate) => candidate.id === item.draftId);
      if (draft) { draft.status = "created_not_sprinted"; draft.createdIssueKey = item.issueKey; }
    }
  }
  createNotice.append(list);
  createNotice.classList.remove("hidden");
  const remaining = result.results.filter((item) => item.status !== "created").length;
  createButton.textContent = remaining ? "Retry remaining Stories →" : "Stories created in Jira ✓";
  createButton.disabled = remaining === 0;
}

async function createApproved(): Promise<void> {
  if (!batchId || !drafts.length) return;
  const approved = window.confirm(`Create ${drafts.length} reviewed Stories in the selected Jira sprint?`);
  if (!approved) return;
  hideNotice(createNotice);
  createButton.disabled = true;
  createButton.textContent = "Creating Jira Stories…";
  try {
    const result = await requestJson<CreationResult>("/api/create", postJson({ batchId, drafts }));
    renderCreationResults(result);
  } catch (error) {
    showNotice(createNotice, error instanceof Error ? error.message : "Could not create Jira Stories.", "error");
    createButton.textContent = "Retry approved Stories →";
    createButton.disabled = false;
  }
}

connectButton.addEventListener("click", () => { window.location.href = "/auth/jira/start"; });
disconnectButton.addEventListener("click", async () => {
  await requestJson("/api/logout", postJson({})).catch(() => undefined);
  window.location.href = "/";
});

siteSelect.addEventListener("change", async () => {
  if (!siteSelect.value) return;
  hideNotice(formNotice);
  try {
    await requestJson("/api/jira/site", postJson({ siteId: siteSelect.value }));
    appStatus!.activeSiteId = siteSelect.value;
    selectedKeys.clear();
    sourceStories = [];
    boards = [];
    sprints = [];
    boardSelect.replaceChildren(option("", "Choose a project first"));
    boardSelect.disabled = true;
    sprintSelect.replaceChildren(option("", "Choose a board first"));
    sprintSelect.disabled = true;
    storySearch.value = "";
    storySearch.disabled = true;
    renderIssues();
    await loadProjects();
  } catch (error) {
    showNotice(formNotice, error instanceof Error ? error.message : "Could not select that Jira workspace.", "error");
  }
  refreshGenerateButton();
});

projectSelect.addEventListener("change", async () => {
  selectedKeys.clear();
  sourceStories = [];
  updateSelectionCount();
  renderIssues();
  hideNotice(formNotice);
  if (!projectSelect.value) return;
  await loadBoards(projectSelect.value);
  await loadIssues();
});

boardSelect.addEventListener("change", async () => {
  sprintSelect.value = "";
  sourceStories = [];
  renderIssues();
  if (boardSelect.value) await loadSprints(boardSelect.value);
  await loadIssues();
  refreshGenerateButton();
});
sprintSelect.addEventListener("change", () => {
  refreshGenerateButton();
  void loadIssues();
});
sprintDaysInput.addEventListener("input", refreshGenerateButton);
availableDaysInput.addEventListener("input", refreshGenerateButton);
storySearch.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void loadIssues(), 300);
});
generateButton.addEventListener("click", () => void generate());
createButton.addEventListener("click", () => void createApproved());

void refreshStatus().then(() => {
  if (new URLSearchParams(window.location.search).has("connected")) {
    showToast("Jira is connected. Choose your sprint details to begin.");
    history.replaceState({}, "", "/");
  }
}).catch((error) => {
  showNotice(setupWarning, error instanceof Error ? error.message : "Could not load app status.", "error");
});
