/**
 * Confluence Status API
 *
 * Utilitaires pour suivre le statut de l'espace Confluence auto-créé
 * (à l'upload du SRS) pour un projet donné.
 */

const API_BASE = '/api/backend';

export interface ConfluenceSpaceStatus {
  status: 'none' | 'pending' | 'created' | 'failed';
  spaceKey?: string | null;
  spaceUrl?: string | null;
  error?: string | null;
  createdAt?: string | null;
}

async function parseJson(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.message || `HTTP ${res.status}`);
  }
  return data;
}

export interface ConfluenceSpaceSummary {
  key: string;
  name: string;
  id: string;
}

export interface ConfluencePageSummary {
  id: string;
  title: string;
  spaceKey: string;
  webui: string;
  lastModified?: string;
}

export async function listConfluenceSpaces(): Promise<ConfluenceSpaceSummary[]> {
  const res = await fetch(`${API_BASE}/confluence/spaces`);
  const data = await parseJson(res);
  return data.data;
}

export async function searchConfluencePages(spaceKey: string, query?: string): Promise<ConfluencePageSummary[]> {
  const params = query ? `?query=${encodeURIComponent(query)}` : '';
  const res = await fetch(`${API_BASE}/confluence/spaces/${encodeURIComponent(spaceKey)}/pages${params}`);
  const data = await parseJson(res);
  return data.data;
}

export async function importFromConfluence(
  spaceKey: string,
  pageId: string,
  projectName?: string,
  projectDescription?: string,
): Promise<{ projectId: string; status: string }> {
  const res = await fetch(`${API_BASE}/documents/import-confluence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spaceKey, pageId, projectName, projectDescription }),
  });
  const data = await parseJson(res);
  return data;
}

export async function getConfluenceStatus(projectId: string): Promise<ConfluenceSpaceStatus> {
  const res = await fetch(`${API_BASE}/confluence/projects/${projectId}/status`);
  const data = await parseJson(res);
  return data.data;
}

export async function retryConfluenceSpace(projectId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/confluence/projects/${projectId}/retry`, { method: 'POST' });
  await parseJson(res);
}