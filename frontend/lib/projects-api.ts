/**
 * Projects API (extrait minimal)
 *
 * Récupère les membres d'un projet (propriétaire + utilisateurs assignés)
 * pour l'autocomplete @mention des commentaires. Réutilise l'endpoint
 * GET /projects/:id déjà utilisé ailleurs dans l'app.
 */

const API_BASE = '/api/backend';

export interface ProjectMember {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'QA' | 'BA' | 'PO';
}

export async function getProjectMembers(projectId: string): Promise<ProjectMember[]> {
  const res = await fetch(`${API_BASE}/projects/${projectId}`);
  if (!res.ok) return [];
  const json = await res.json().catch(() => null);
  const project = json?.data ?? json;
  if (!project) return [];

  const members = new Map<string, ProjectMember>();
  if (project.owner) members.set(project.owner.id, project.owner);
  for (const u of project.assignedUsers ?? []) members.set(u.id, u);
  return Array.from(members.values());
}
