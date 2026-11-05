/**
 * Comments API
 *
 * Utilitaires pour appeler les endpoints de collaboration (commentaires,
 * mentions, résolution) sur les exigences et cas de test. Suit la même
 * convention que lib/jira-api.ts : fetch direct vers le proxy /api/backend,
 * qui injecte le Bearer token côté serveur à partir de la session cookie.
 */

const API_BASE = '/api/backend';

export type CommentEntityType = 'requirement' | 'test_case';

export interface Comment {
  id: string;
  project_id: string;
  entity_type: CommentEntityType;
  entity_id: string;
  content: string;
  mentioned_user_ids: string[];
  author_id: string;
  parent_id?: string | null;
  // Coché par l'auteur à la création : seuls les autres membres du projet
  // (jamais l'auteur lui-même) verront le bouton "Résoudre" sur ce commentaire.
  requires_resolution: boolean;
  resolved: boolean;
  resolved_by_id?: string | null;
  resolved_at?: string | null;
  created_at: string;
  updated_at: string;
}

async function parseJson(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.message || (Array.isArray(data?.message) ? data.message.join(', ') : `HTTP ${res.status}`));
  }
  return data;
}

export async function listComments(
  projectId: string,
  entityType: CommentEntityType,
  entityId: string,
): Promise<Comment[]> {
  const params = new URLSearchParams({ entityType, entityId });
  const res = await fetch(`${API_BASE}/projects/${projectId}/comments?${params}`);
  const data = await parseJson(res);
  return data.data;
}

export async function createComment(
  projectId: string,
  input: { entityType: CommentEntityType; entityId: string; content: string; mentionedUserIds?: string[]; parentId?: string; requiresResolution?: boolean },
): Promise<Comment> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = await parseJson(res);
  return data.data;
}

export async function resolveComment(projectId: string, commentId: string): Promise<Comment> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/comments/${commentId}/resolve`, { method: 'PATCH' });
  const data = await parseJson(res);
  return data.data;
}

export async function reopenComment(projectId: string, commentId: string): Promise<Comment> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/comments/${commentId}/reopen`, { method: 'PATCH' });
  const data = await parseJson(res);
  return data.data;
}

export async function deleteComment(projectId: string, commentId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/comments/${commentId}`, { method: 'DELETE' });
  await parseJson(res);
}

/** Exigences/TC du projet portant un commentaire pas encore vu par l'utilisateur courant. */
export async function getUnreadEntities(projectId: string): Promise<{ requirement: string[]; test_case: string[] }> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/comments/unread-entities`);
  const data = await parseJson(res);
  return data.data;
}

/** Accusé de lecture ("vu") pour un destinataire d'une mention/réponse. */
export interface CommentSeenBy {
  userId: string;
  userName: string;
  read: boolean;
  readAt?: string | null;
}

/**
 * Accusés de lecture d'un commentaire (qui, parmi les mentionnés / le
 * destinataire d'une réponse, l'a déjà lu). Réservé à l'auteur du
 * commentaire côté backend — un utilisateur non-auteur reçoit un 403.
 */
export async function getCommentSeenBy(projectId: string, commentId: string): Promise<CommentSeenBy[]> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/comments/${commentId}/seen-by`);
  const data = await parseJson(res);
  return data.data;
}

/**
 * Relance les destinataires (mentionnés / répondu-à) d'un commentaire qui ne
 * l'ont pas encore lu. Réservé à l'auteur du commentaire côté backend.
 * Lève une erreur si tout le monde a déjà lu (rien à relancer).
 */
export async function remindComment(projectId: string, commentId: string): Promise<{ reminded: number; userIds: string[] }> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/comments/${commentId}/remind`, { method: 'POST' });
  const data = await parseJson(res);
  return data;
}

/** Accusé de lecture ("vu") d'un membre du projet sur TOUT le fil d'une exigence/TC. */
export interface ReadReceipt {
  userId: string;
  userName: string;
  readAt: string;
}

/**
 * Accusés de lecture de tout le fil (contrairement à getCommentSeenBy,
 * limité aux mentions/réponses et réservé à l'auteur) : un par membre ayant
 * déjà consulté ce fil, avec la date de sa dernière lecture. Consultable par
 * n'importe quel membre du projet. Le frontend en déduit ensuite, pour
 * chaque commentaire, qui l'a "vu" en comparant cette date à sa date de
 * création — voir CommentThread.
 */
export async function getReadReceipts(
  projectId: string,
  entityType: CommentEntityType,
  entityId: string,
): Promise<ReadReceipt[]> {
  const params = new URLSearchParams({ entityType, entityId });
  const res = await fetch(`${API_BASE}/projects/${projectId}/comments/read-receipts?${params}`);
  const data = await parseJson(res);
  return data.data;
}

/** Marque le fil de commentaires d'une exigence/TC comme lu par l'utilisateur courant. */
export async function markCommentsRead(
  projectId: string,
  entityType: CommentEntityType,
  entityId: string,
): Promise<void> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/comments/mark-read`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entityType, entityId }),
  });
  await parseJson(res);
}