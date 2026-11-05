import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsGateway } from './notifications.gateway';

export type NotificationType =
  | 'mention'
  | 'comment_reply'
  | 'comment_resolved'
  | 'comment_reopened'
  // Relance explicite envoyée par l'auteur d'un commentaire à un destinataire
  // qui n'a toujours pas lu sa mention/réponse — voir CommentsService.remind.
  // Distinct de 'mention' pour que le frontend puisse l'afficher différemment
  // ("X vous relance") et pour ne jamais compter comme une nouvelle mention.
  | 'comment_reminder'
  // ── Journal d'activité projet (persisté, pour que tout membre puisse voir
  // ce qui s'est passé même s'il n'était pas connecté en direct — voir
  // notifyProjectActivity ci-dessous) ─────────────────────────────────────
  | 'project_activity'
  | 'module_activity'
  | 'requirement_activity'
  | 'testcase_activity'
  | 'generation_activity'
  | 'export_activity'
  // Création/suppression d'un workflow de test, et fin d'exécution (run) —
  // voir WorkflowController.
  | 'workflow_activity'
  // Demande de suppression de compte envoyée aux Admins (POST /users/me/request-deletion).
  | 'account_deletion_request';

export interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  message: string;
  actorId?: string;
  projectId?: string;
  entityType?: string;
  entityId?: string;
  commentId?: string;
  link?: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: NotificationsGateway,
  ) {}

  /**
   * Préfixe un message avec le nom du projet concerné (ex: « SpecChef » —
   * ...) pour qu'un utilisateur membre de plusieurs projets sache toujours
   * de quel projet vient la notification, sans avoir à cliquer dessus.
   * Best-effort : si le projet est introuvable ou la requête échoue, on
   * renvoie le message tel quel plutôt que de faire échouer la notification.
   */
  private async prefixWithProjectName(message: string, projectId?: string): Promise<string> {
    if (!projectId) return message;
    try {
      const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
      return project?.name ? `« ${project.name} » — ${message}` : message;
    } catch {
      return message;
    }
  }

  /**
   * Crée une notification en base et la pousse immédiatement en temps réel
   * (WebSocket) à l'utilisateur ciblé s'il est connecté.
   * Ne notifie jamais un utilisateur pour sa propre action (garde côté appelant
   * ou ici en filet de sécurité).
   */
  async notify(input: CreateNotificationInput) {
    if (input.actorId && input.actorId === input.userId) {
      return null; // on ne se notifie pas soi-même
    }

    const message = await this.prefixWithProjectName(input.message, input.projectId);

    const notification = await this.prisma.notification.create({
      data: {
        user_id: input.userId,
        type: input.type,
        message,
        actor_id: input.actorId,
        project_id: input.projectId,
        entity_type: input.entityType,
        entity_id: input.entityId,
        comment_id: input.commentId,
        link: input.link,
      },
    });

    try {
      this.gateway.pushToUser(input.userId, notification);
    } catch (err: any) {
      this.logger.warn(`Push WebSocket échoué pour user ${input.userId}: ${err.message}`);
    }

    return notification;
  }

  /**
   * Notifie plusieurs utilisateurs d'un même événement (ex: toutes les
   * personnes mentionnées dans un commentaire).
   */
  async notifyMany(userIds: string[], base: Omit<CreateNotificationInput, 'userId'>) {
    const uniqueIds = Array.from(new Set(userIds)).filter(id => id !== base.actorId);
    await Promise.all(uniqueIds.map(userId => this.notify({ ...base, userId })));
  }

  /**
   * Liste les membres d'un projet (propriétaire + utilisateurs assignés).
   * Publique : utilisée aussi par les contrôleurs qui doivent capturer la
   * liste des membres AVANT une suppression (ex: suppression de projet, où
   * la ligne n'existera plus pour la relire après coup).
   */
  async getProjectMemberIds(projectId: string): Promise<string[]> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { owner_id: true, assignedUserIds: true } as any,
    });
    if (!project) return [];
    const ids = new Set<string>();
    if ((project as any).owner_id) ids.add((project as any).owner_id);
    for (const uid of (project as any).assignedUserIds ?? []) ids.add(uid);
    return Array.from(ids);
  }

  /**
   * Notifie uniquement les membres du projet ayant l'un des rôles donnés
   * (ex: prévenir les QA qu'un workflow vient d'être validé et est
   * désormais exécutable). Contrairement à notifyProjectActivity, ceci ne
   * touche PAS le fil d'activité partagé (visible par tous) — uniquement
   * la cloche de notifications des utilisateurs ciblés.
   */
  async notifyProjectMembersByRole(
    projectId: string,
    roles: string[],
    base: Omit<CreateNotificationInput, 'userId'>,
  ): Promise<void> {
    const memberIds = await this.getProjectMemberIds(projectId);
    if (memberIds.length === 0) return;
    const users = await this.prisma.user.findMany({
      where: { id: { in: memberIds }, role: { in: roles as any } },
      select: { id: true },
    });
    const targetIds = users.map(u => u.id);
    if (targetIds.length === 0) return;
    await this.notifyMany(targetIds, base);
  }

  /**
   * Journalise une action de projet (création/modification/suppression de
   * module, exigence, cas de test, génération terminée, export...) et la
   * persiste pour TOUS les membres du projet sauf l'auteur — contrairement
   * aux événements WebSocket "live only" (voir NotificationsGateway.emitToProject),
   * celle-ci reste consultable dans la cloche de notifications même si le
   * membre n'était pas connecté au moment de l'action.
   * Best-effort : n'importe jamais faire échouer l'action métier appelante.
   */
  async notifyProjectActivity(input: {
    projectId: string;
    actorId: string;
    actorName?: string;
    type: NotificationType;
    message: string;
    entityType?: string;
    entityId?: string;
    link?: string;
    /**
     * Si false, n'écrit QUE dans le fil d'activité partagé (panneau "Aujourd'hui
     * sur ce projet") sans créer de notification individuelle (cloche) pour
     * chaque membre. Utile quand une notification individuelle plus précise
     * est déjà envoyée séparément (ex: workflow validé → notifyProjectMembersByRole
     * ciblé QA) pour éviter un doublon dans la cloche de l'utilisateur.
     * true par défaut (comportement historique inchangé).
     */
    notifyMembers?: boolean;
  }) {
    // ── 1) Fil d'activité partagé (une seule ligne par événement) ───────────
    // Contrairement aux notifications individuelles ci-dessous, cette entrée
    // est visible par TOUTE l'équipe (panneau "Aujourd'hui sur ce projet"),
    // y compris les membres qui rejoignent le projet après coup — elle ne
    // dépend donc pas de la liste des membres au moment de l'action.
    try {
      const activity = await this.prisma.projectActivity.create({
        data: {
          project_id: input.projectId,
          actor_id: input.actorId,
          actor_name: input.actorName,
          type: input.type,
          message: input.message,
          entity_type: input.entityType,
          entity_id: input.entityId,
        },
      });
      try {
        this.gateway.emitToProject(input.projectId, 'activity:new', activity as any);
      } catch (err: any) {
        this.logger.warn(`Diffusion temps réel du fil d'activité échouée (projet ${input.projectId}): ${err.message}`);
      }
    } catch (err: any) {
      this.logger.warn(`Journalisation du fil d'activité échouée (projet ${input.projectId}): ${err.message}`);
    }

    // ── 2) Notifications individuelles (cloche) — comportement inchangé ─────
    if (input.notifyMembers === false) return;
    try {
      const memberIds = await this.getProjectMemberIds(input.projectId);
      if (memberIds.length === 0) return;
      await this.notifyMany(memberIds, {
        type: input.type,
        message: input.message,
        actorId: input.actorId,
        projectId: input.projectId,
        entityType: input.entityType,
        entityId: input.entityId,
        link: input.link ?? `/analyzer?projectId=${input.projectId}`,
      });
    } catch (err: any) {
      this.logger.warn(`notifyProjectActivity échouée (projet ${input.projectId}): ${err.message}`);
    }
  }

  /**
   * Fil d'activité paginé d'un projet — historique scrollable de TOUTES les
   * actions de l'équipe (contrairement à `list()` ci-dessus qui est propre à
   * un utilisateur). Pas de notion de lu/non-lu ici : c'est un journal, pas
   * une boîte de réception.
   */
  async listProjectActivity(projectId: string, opts: { page?: number; pageSize?: number } = {}) {
    const page = opts.page && opts.page > 0 ? opts.page : 1;
    const pageSize = opts.pageSize && opts.pageSize > 0 ? Math.min(opts.pageSize, 50) : 30;

    const where = { project_id: projectId };

    const [items, total] = await Promise.all([
      this.prisma.projectActivity.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.projectActivity.count({ where }),
    ]);

    return { items, total, page, pageSize, hasMore: page * pageSize < total };
  }

  async list(userId: string, opts: { page?: number; pageSize?: number; unreadOnly?: boolean } = {}) {
    const page = opts.page && opts.page > 0 ? opts.page : 1;
    const pageSize = opts.pageSize && opts.pageSize > 0 ? Math.min(opts.pageSize, 50) : 20;

    const where = { user_id: userId, ...(opts.unreadOnly ? { read: false } : {}) };

    const [items, total, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { user_id: userId, read: false } }),
    ]);

    return { items, total, page, pageSize, unreadCount };
  }

  async unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { user_id: userId, read: false } });
  }

  async markRead(userId: string, id: string, readerName?: string) {
    const notif = await this.prisma.notification.findUnique({ where: { id } });
    if (!notif || notif.user_id !== userId) {
      return null; // pas de fuite d'info — on renvoie simplement rien
    }
    const updated = await this.prisma.notification.update({
      where: { id },
      data: { read: true, read_at: new Date() },
    });

    await this.pushCommentSeen(updated, userId, readerName);

    return updated;
  }

  async markAllRead(userId: string, readerName?: string) {
    // Capturé AVANT la mise à jour groupée : updateMany ne renvoie pas les
    // lignes affectées, et on a besoin de comment_id/type pour savoir
    // lesquelles correspondent à une mention/réponse à "accuser lue" (voir
    // pushCommentSeen ci-dessous).
    const toNotify = await this.prisma.notification.findMany({
      where: { user_id: userId, read: false, comment_id: { not: null } },
      select: { id: true, comment_id: true, type: true },
    });

    const res = await this.prisma.notification.updateMany({
      where: { user_id: userId, read: false },
      data: { read: true, read_at: new Date() },
    });

    const readAt = new Date();
    await Promise.all(
      toNotify.map(n =>
        this.pushCommentSeen(
          { comment_id: n.comment_id, type: n.type, read_at: readAt } as any,
          userId,
          readerName,
        ),
      ),
    );

    return { updated: res.count };
  }

  /**
   * Accusé "vu" — pousse un événement temps réel `comment:seen` à l'auteur
   * du commentaire (et à quiconque a le fil ouvert) dès qu'une notification
   * de type mention/réponse vient d'être marquée lue. Best-effort : ne fait
   * jamais échouer l'appelant (markRead/markAllRead) si le commentaire a
   * depuis été supprimé ou si le push WebSocket échoue.
   */
  private async pushCommentSeen(
    notif: { comment_id: string | null; type: string; read_at: Date | null },
    userId: string,
    readerName?: string,
  ) {
    if (!notif.comment_id || (notif.type !== 'mention' && notif.type !== 'comment_reply')) return;
    try {
      const comment = await this.prisma.comment.findUnique({ where: { id: notif.comment_id } });
      if (!comment || comment.author_id === userId) return; // pas de fuite / pas de "vu par moi-même"
      this.gateway.notifyCommentSeen({
        commentId: notif.comment_id,
        entityType: comment.entity_type,
        entityId: comment.entity_id,
        authorId: comment.author_id,
        userId,
        userName: readerName || 'Un utilisateur',
        readAt: (notif.read_at ?? new Date()).toISOString(),
      });
    } catch (err: any) {
      this.logger.warn(`Diffusion de l'accusé "vu" échouée (commentaire ${notif.comment_id}): ${err.message}`);
    }
  }
}