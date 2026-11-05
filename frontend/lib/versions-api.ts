/**
 * Historique des versions / rollback
 *
 * Client générique pour Requirement, RequirementModule et TestCase — les 3
 * types d'entités portées par ProjectService côté backend (endpoints
 * `/projects/versions/:entityType/:entityId`). Le workflow a son propre
 * client dans workflow-api.ts (portée par WorkflowService, throttlée).
 *
 * Suit la même convention que lib/project-activity-api.ts : fetch direct vers
 * le proxy /api/backend, qui injecte le Bearer token côté serveur.
 */

const API_BASE = '/api/backend';

export type VersionedEntityType = 'requirement_module' | 'requirement' | 'test_case';

export interface EntityVersion {
  id: string;
  project_id: string;
  entity_type: VersionedEntityType | string;
  entity_id: string;
  version_number: number;
  snapshot: Record<string, any>;
  change_type: 'create' | 'update' | 'delete' | 'restore';
  change_summary?: string | null;
  changed_by_id?: string | null;
  changed_by_name?: string | null;
  created_at: string;
}

async function parseJson(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.message || (Array.isArray(data?.message) ? data.message.join(', ') : `HTTP ${res.status}`));
  }
  return data;
}

/** Historique des versions d'un module, d'une exigence ou d'un cas de test — trié du plus récent au plus ancien. */
export async function getEntityVersions(entityType: VersionedEntityType, entityId: string): Promise<EntityVersion[]> {
  const res = await fetch(`${API_BASE}/projects/versions/${entityType}/${entityId}`);
  const json = await parseJson(res);
  return json.data as EntityVersion[];
}

/**
 * Restaure une ancienne version — l'état courant est d'abord archivé (rien
 * n'est jamais perdu), puis l'entité est écrasée avec le contenu de la
 * version choisie. Retourne l'entité à jour (Requirement | RequirementModule
 * | TestCase selon `entityType`).
 */
export async function restoreEntityVersion(entityType: VersionedEntityType, entityId: string, versionId: string): Promise<{ pending: boolean; message?: string; data?: any }> {
  const res = await fetch(`${API_BASE}/projects/versions/${entityType}/${entityId}/restore/${versionId}`, { method: 'POST' });
  const json = await parseJson(res);
  if (json?.pending) return { pending: true, message: json.message };
  return { pending: false, data: json.data };
}