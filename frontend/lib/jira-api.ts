/**
 * Jira Export API
 *
 * Utilitaires pour appeler les endpoints d'intégration Jira du backend
 * (connexion du compte, liste des projets, export des cas de test).
 */

const API_BASE = '/api/backend';

export interface JiraConnectionStatus {
  connected: boolean;
  jiraBaseUrl?: string;
  jiraEmail?: string;
  updatedAt?: string;
}

export interface JiraProjectOption {
  id: string;
  key: string;
  name: string;
}

export interface JiraIssueTypeOption {
  id: string;
  name: string;
  iconUrl?: string;
}

export interface JiraEpicOption {
  id: string;
  key: string;
  summary: string;
}

export interface JiraExportResult {
  testCaseId: string;
  testId: string;
  success: boolean;
  issueKey?: string;
  issueUrl?: string;
  error?: string;
  action?: 'created' | 'updated';
}

export interface JiraExportAllResult {
  total: number;
  success: number;
  failed: number;
  results: JiraExportResult[];
}

export interface JiraRequirementHierarchy {
  linked: boolean;
  projectKey?: string;
  epicKey?: string;
  epicUrl?: string;
  storyKey?: string;
  storyUrl?: string;
}

export interface JiraAdminConnectionRow {
  userId: string;
  userName: string;
  userEmail: string;
  userRole: 'ADMIN' | 'QA' | 'BA' | 'PO';
  connected: boolean;
  jiraBaseUrl?: string;
  jiraEmail?: string;
  updatedAt?: string;
}

async function parseJson(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.message || (Array.isArray(data?.message) ? data.message.join(', ') : `HTTP ${res.status}`));
  }
  return data;
}

export async function getJiraStatus(): Promise<JiraConnectionStatus> {
  const res = await fetch(`${API_BASE}/jira/credentials`);
  const data = await parseJson(res);
  return data.data;
}

export async function connectJira(payload: {
  jiraBaseUrl: string;
  jiraEmail: string;
  apiToken: string;
}): Promise<JiraConnectionStatus> {
  const res = await fetch(`${API_BASE}/jira/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await parseJson(res);
  return data.data;
}

export async function disconnectJira(): Promise<void> {
  const res = await fetch(`${API_BASE}/jira/credentials`, { method: 'DELETE' });
  await parseJson(res);
}

export async function listJiraProjects(): Promise<JiraProjectOption[]> {
  const res = await fetch(`${API_BASE}/jira/projects`);
  const data = await parseJson(res);
  return data.data;
}

export async function listJiraIssueTypes(projectKey: string): Promise<JiraIssueTypeOption[]> {
  const res = await fetch(`${API_BASE}/jira/projects/${encodeURIComponent(projectKey)}/issue-types`);
  const data = await parseJson(res);
  return data.data;
}

export async function listJiraEpics(projectKey: string): Promise<JiraEpicOption[]> {
  const res = await fetch(`${API_BASE}/jira/projects/${encodeURIComponent(projectKey)}/epics`);
  const data = await parseJson(res);
  return data.data;
}

export async function createJiraEpic(projectKey: string, summary: string): Promise<JiraEpicOption> {
  const res = await fetch(`${API_BASE}/jira/projects/${encodeURIComponent(projectKey)}/epics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary }),
  });
  const data = await parseJson(res);
  return data.data;
}

// ── Hiérarchie Jira de l'exigence (Epic → Story) ──────────────────────────

export async function getRequirementJiraHierarchy(requirementUuid: string): Promise<JiraRequirementHierarchy> {
  const res = await fetch(`${API_BASE}/jira/requirements/${requirementUuid}/hierarchy`);
  const data = await parseJson(res);
  return data.data;
}

export async function exportTestCaseToJira(
  testCaseId: string,
  projectKey?: string,
  issueTypeId?: string,
  epicKey?: string,
  storySummary?: string,
): Promise<JiraExportResult> {
  const res = await fetch(`${API_BASE}/jira/test-cases/${testCaseId}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectKey, issueTypeId, epicKey, storySummary }),
  });
  const data = await parseJson(res);
  return data.data;
}

export async function exportAllTestCasesToJira(
  requirementUuid: string,
  projectKey?: string,
  issueTypeId?: string,
  epicKey?: string,
  storySummary?: string,
): Promise<JiraExportAllResult> {
  const res = await fetch(`${API_BASE}/jira/requirements/${requirementUuid}/export-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectKey, issueTypeId, epicKey, storySummary }),
  });
  const data = await parseJson(res);
  return data.data;
}

// ── Supervision Admin des accès Atlassian ─────────────────────────────────

export async function listAllJiraConnections(): Promise<JiraAdminConnectionRow[]> {
  const res = await fetch(`${API_BASE}/jira/admin/connections`);
  const data = await parseJson(res);
  return data.data;
}

export async function revokeJiraConnection(userId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/jira/admin/connections/${userId}`, { method: 'DELETE' });
  await parseJson(res);
}