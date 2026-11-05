/**
 * Fil d'activité du projet
 *
 * Contrairement à `notifications-api.ts` (individuel : une notification par
 * membre, avec lu/non-lu), ceci lit le journal PARTAGÉ d'un projet — une
 * seule ligne par événement, visible par toute l'équipe, sans notion de
 * lecture. Alimente le panneau "Aujourd'hui sur ce projet".
 */

const API_BASE = '/api/backend';

export type ProjectActivityType =
  | 'project_activity'
  | 'module_activity'
  | 'requirement_activity'
  | 'testcase_activity'
  | 'generation_activity'
  | 'export_activity';

export interface ProjectActivityEntry {
  id: string;
  project_id: string;
  type: ProjectActivityType | string;
  message: string;
  actor_id?: string | null;
  actor_name?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  created_at: string;
}

export interface ProjectActivityPage {
  items: ProjectActivityEntry[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

async function parseJson(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.message || (Array.isArray(data?.message) ? data.message.join(', ') : `HTTP ${res.status}`));
  }
  return data;
}

export async function getProjectActivity(
  projectId: string,
  opts: { page?: number; pageSize?: number } = {},
): Promise<ProjectActivityPage> {
  const params = new URLSearchParams();
  if (opts.page) params.set('page', String(opts.page));
  if (opts.pageSize) params.set('pageSize', String(opts.pageSize));
  const res = await fetch(`${API_BASE}/projects/${projectId}/activity?${params}`);
  const json = await parseJson(res);
  return json.data as ProjectActivityPage;
}
