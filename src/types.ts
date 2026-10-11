export type JiraSite = {
  id: string;
  name: string;
  url: string;
  scopes: string[];
};

export type JiraTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
};

export type JiraSession = {
  id: string;
  tokens: JiraTokens;
  sites: JiraSite[];
  activeSiteId?: string;
};

export type SourceStory = {
  key: string;
  summary: string;
  description: string;
  priority: string;
  issueType: string;
  url: string;
};

export type DraftStory = {
  id: string;
  title: string;
  sourceIssueKey: string;
  subtasks: string[];
  definitionOfDone: string[];
  createdIssueKey?: string;
  status?: "draft" | "created" | "created_not_sprinted";
};

export type DraftBatch = {
  id: string;
  sessionId: string;
  siteId: string;
  projectKey: string;
  sprintId: number;
  sourceStories: SourceStory[];
  drafts: DraftStory[];
};

export type JiraProject = {
  id: string;
  key: string;
  name: string;
  projectTypeKey?: string;
};

export type JiraBoard = {
  id: number;
  name: string;
  type: string;
};

export type JiraSprint = {
  id: number;
  name: string;
  state: string;
  startDate?: string;
  endDate?: string;
  goal?: string;
};
