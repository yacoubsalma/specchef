/**
 * Notifications API
 *
 * Utilitaires pour lister/marquer les notifications et obtenir le ticket
 * d'authentification de la connexion WebSocket temps réel. Fetch direct
 * vers /api/backend, même convention que lib/jira-api.ts.
 */

const API_BASE = '/api/backend';

export type NotificationType =
  | 'mention'
  | 'comment_reply'
  | 'comment_resolved'
  | 'comment_reopened'
  | 'comment_reminder'
  | 'project_activity'
  | 'module_activity'
  | 'requirement_activity'
  | 'testcase_activity'
  | 'generation_activity'
  | 'export_activity'
  | 'account_deletion_request';

export interface AppNotification {
  id: string;
  user_id: string;
  type: NotificationType;
  project_id?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  comment_id?: string | null;
  actor_id?: string | null;
  message: string;
  link?: string | null;
  read: boolean;
  read_at?: string | null;
  created_at: string;
}

async function parseJson(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.message || (Array.isArray(data?.message) ? data.message.join(', ') : `HTTP ${res.status}`));
  }
  return data;
}

export async function listNotifications(opts: { page?: number; pageSize?: number; unreadOnly?: boolean } = {}) {
  const params = new URLSearchParams();
  if (opts.page) params.set('page', String(opts.page));
  if (opts.pageSize) params.set('pageSize', String(opts.pageSize));
  if (opts.unreadOnly) params.set('unreadOnly', 'true');
  const res = await fetch(`${API_BASE}/notifications?${params}`);
  const json = await parseJson(res);
  return json.data as {
    items: AppNotification[];
    total: number;
    page: number;
    pageSize: number;
    unreadCount: number;
  };
}

export async function getWsTicket(): Promise<string> {
  const res = await fetch(`${API_BASE}/notifications/ws-ticket`);
  const json = await parseJson(res);
  return json.ticket as string;
}

export async function markNotificationRead(id: string): Promise<void> {
  await fetch(`${API_BASE}/notifications/${id}/read`, { method: 'PATCH' });
}

export async function markAllNotificationsRead(): Promise<void> {
  await fetch(`${API_BASE}/notifications/read-all`, { method: 'PATCH' });
}
