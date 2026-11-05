import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectService } from '../project/project.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { CreateCommentDto } from './dto/create-comment.dto';

interface AccessCheck {
  userId: string;
  isAdmin: boolean;
}

@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectService: ProjectService,
    private readonly notificationsService: NotificationsService,
    private readonly gateway: NotificationsGateway,
  ) {}

  /** Vérifie que l'utilisateur a accès au projet (lève ForbiddenException sinon). */
  private async assertProjectAccess(projectId: string, access: AccessCheck) {
    await this.projectService.getProject(projectId, access); // lève déjà ForbiddenException si non membre
  }

  private buildLink(entityType: string, entityId: string, projectId: string, commentId: string) {
    // Doit matcher les query params lus par app/(site)/analyzer/page.tsx :
    // `projectId` déclenche le chargement du projet, `commentEntityType`/`commentEntityId`
    // indiquent au frontend d'ouvrir directement le drawer de commentaires correspondant.
    return `/analyzer?projectId=${projectId}&commentEntityType=${entityType}&commentEntityId=${entityId}&commentId=${commentId}`;
  }

  async create(projectId: string, dto: CreateCommentDto, access: AccessCheck, authorName: string) {
    await this.assertProjectAccess(projectId, access);

    if (dto.parentId) {
      const parent = await this.prisma.comment.findUnique({ where: { id: dto.parentId } });
      if (!parent || parent.project_id !== projectId) {
        throw new BadRequestException('Commentaire parent introuvable dans ce projet');
      }
    }

    const project = await this.projectService.getProject(projectId, access);
    const memberIds = new Set<string>([
      ...((project as any).assignedUsers?.map((u: any) => u.id) ?? []),
      ...((project as any).owner ? [(project as any).owner.id] : []),
    ]);

    const mentionedUserIds = (dto.mentionedUserIds ?? []).filter(id => memberIds.has(id));

    const comment = await this.prisma.comment.create({
      data: {
        project_id: projectId,
        entity_type: dto.entityType,
        entity_id: dto.entityId,
        content: dto.content,
        mentioned_user_ids: mentionedUserIds,
        author_id: access.userId,
        parent_id: dto.parentId,
        requires_resolution: dto.requiresResolution ?? false,
      },
    });

    // ── Temps réel ──────────────────────────────────────────────────────
    this.gateway.emitToEntity(dto.entityType, dto.entityId, 'comment:new', comment);

    // Badge "non vu" — tous les membres du projet (hors auteur), pas seulement
    // les mentionnés, doivent voir le point rouge s'allumer sur l'exigence/TC.
    const otherMemberIds = [...memberIds].filter(id => id !== access.userId);
    if (otherMemberIds.length > 0) {
      this.gateway.emitUnseenComment(otherMemberIds, {
        projectId,
        entityType: dto.entityType,
        entityId: dto.entityId,
      });
    }

    // ── Notifications ────────────────────────────────────────────────────
    const link = this.buildLink(dto.entityType, dto.entityId, projectId, comment.id);

    // Mentions directes
    if (mentionedUserIds.length > 0) {
      await this.notificationsService.notifyMany(mentionedUserIds, {
        type: 'mention',
        actorId: access.userId,
        message: `${authorName} vous a mentionné dans un commentaire.`,
        projectId,
        entityType: dto.entityType,
        entityId: dto.entityId,
        commentId: comment.id,
        link,
      });
    }

    // Réponse dans un fil : notifier l'auteur du commentaire parent (s'il n'est pas déjà mentionné)
    if (dto.parentId) {
      const parent = await this.prisma.comment.findUnique({ where: { id: dto.parentId } });
      if (parent && !mentionedUserIds.includes(parent.author_id)) {
        await this.notificationsService.notify({
          userId: parent.author_id,
          type: 'comment_reply',
          actorId: access.userId,
          message: `${authorName} a répondu à votre commentaire.`,
          projectId,
          entityType: dto.entityType,
          entityId: dto.entityId,
          commentId: comment.id,
          link,
        });
      }
    }

    return comment;
  }

  async listForEntity(projectId: string, entityType: string, entityId: string, access: AccessCheck) {
    await this.assertProjectAccess(projectId, access);
    return this.prisma.comment.findMany({
      where: { project_id: projectId, entity_type: entityType, entity_id: entityId },
      orderBy: { created_at: 'asc' },
    });
  }

  async resolve(id: string, access: AccessCheck, authorName: string) {
    return this.setResolved(id, true, access, authorName);
  }

  async reopen(id: string, access: AccessCheck, authorName: string) {
    return this.setResolved(id, false, access, authorName);
  }

  private async setResolved(id: string, resolved: boolean, access: AccessCheck, authorName: string) {
    const comment = await this.prisma.comment.findUnique({ where: { id } });
    if (!comment) throw new NotFoundException('Commentaire introuvable');

    // Tout membre du projet peut résoudre/rouvrir un commentaire (décision produit)
    await this.assertProjectAccess(comment.project_id, access);

    const updated = await this.prisma.comment.update({
      where: { id },
      data: resolved
        ? { resolved: true, resolved_by_id: access.userId, resolved_at: new Date() }
        : { resolved: false, resolved_by_id: null, resolved_at: null },
    });

    this.gateway.emitToEntity(comment.entity_type, comment.entity_id, 'comment:updated', updated);

    if (comment.author_id !== access.userId) {
      const link = this.buildLink(comment.entity_type, comment.entity_id, comment.project_id, comment.id);
      await this.notificationsService.notify({
        userId: comment.author_id,
        type: resolved ? 'comment_resolved' : 'comment_reopened',
        actorId: access.userId,
        message: resolved
          ? `${authorName} a marqué votre commentaire comme résolu.`
          : `${authorName} a rouvert votre commentaire.`,
        projectId: comment.project_id,
        entityType: comment.entity_type,
        entityId: comment.entity_id,
        commentId: comment.id,
        link,
      });
    }

    return updated;
  }

  /**
   * Marque le fil de commentaires d'une exigence/TC comme lu par l'utilisateur
   * courant, et diffuse en direct un accusé "vu" à la room de l'entité (voir
   * getReadReceipts ci-dessous) pour que les petits avatars "vu" affichés sous
   * chaque commentaire se mettent à jour immédiatement chez toute personne qui
   * a le fil ouvert au même moment — sans ça, il faudrait recharger le drawer.
   */
  async markRead(projectId: string, entityType: string, entityId: string, access: AccessCheck, userName: string) {
    await this.assertProjectAccess(projectId, access);

    const record = await this.prisma.commentRead.upsert({
      where: {
        user_id_entity_type_entity_id: {
          user_id: access.userId,
          entity_type: entityType,
          entity_id: entityId,
        },
      },
      create: {
        user_id: access.userId,
        project_id: projectId,
        entity_type: entityType,
        entity_id: entityId,
        last_read_at: new Date(),
      },
      update: { last_read_at: new Date() },
    });

    // Consulter le fil vaut aussi accusé de lecture pour les mentions/réponses
    // qui s'y trouvent : sans ça, "Relancer" ne disparaissait que si le
    // mentionné cliquait explicitement sur la notification 🔔 — le simple fait
    // d'avoir déjà le fil ouvert (ou de l'ouvrir) ne suffisait pas, même en
    // direct, puisque ce sont deux systèmes de lecture distincts (CommentRead
    // générique vs Notification.read spécifique aux mentions). Best-effort :
    // ne fait jamais échouer le marquage "vu" générique ci-dessus.
    try {
      const threadCommentIds = (
        await this.prisma.comment.findMany({
          where: { project_id: projectId, entity_type: entityType, entity_id: entityId },
          select: { id: true },
        })
      ).map(c => c.id);

      if (threadCommentIds.length > 0) {
        const pending = await this.prisma.notification.findMany({
          where: {
            user_id: access.userId,
            read: false,
            type: { in: ['mention', 'comment_reply'] },
            comment_id: { in: threadCommentIds },
          },
          select: { id: true },
        });
        // Chaque appel diffuse déjà son propre événement temps réel 'comment:seen'
        // (voir NotificationsService.markRead → pushCommentSeen) — c'est ce qui
        // met à jour "Relancer" côté auteur sans qu'il ait à recharger.
        await Promise.all(pending.map(n => this.notificationsService.markRead(access.userId, n.id, userName)));
      }
    } catch {
      // Pas critique : l'accusé "vu" générique reste enregistré même si la
      // synchronisation avec les notifications de mention échoue.
    }

    this.gateway.notifyThreadSeen({
      entityType,
      entityId,
      userId: access.userId,
      userName,
      readAt: record.last_read_at.toISOString(),
    });

    return { success: true };
  }

  /**
   * Accusés de lecture ("vu") de TOUT le fil d'une exigence/TC, dérivés de
   * CommentRead : contrairement à getSeenBy ci-dessous (réservé aux mentions/
   * réponses et à l'auteur du commentaire), celui-ci couvre chaque commentaire
   * du fil et est consultable par n'importe quel membre du projet. Renvoie,
   * pour chaque membre ayant déjà consulté le fil, la date de sa dernière
   * lecture — le frontend en déduit ensuite, commentaire par commentaire, qui
   * l'a "vu" en comparant cette date à la date de création du commentaire
   * (et en excluant systématiquement l'auteur de son propre commentaire).
   */
  async getReadReceipts(projectId: string, entityType: string, entityId: string, access: AccessCheck) {
    await this.assertProjectAccess(projectId, access);

    const reads = await this.prisma.commentRead.findMany({
      where: { project_id: projectId, entity_type: entityType, entity_id: entityId },
    });
    if (reads.length === 0) return [];

    const userIds = reads.map(r => r.user_id);
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true },
    });
    const nameById = new Map(users.map(u => [u.id, u.name]));

    return reads.map(r => ({
      userId: r.user_id,
      userName: nameById.get(r.user_id) ?? 'Utilisateur',
      readAt: r.last_read_at,
    }));
  }

  /**
   * Renvoie, pour l'utilisateur courant, les exigences et cas de test du projet
   * portant au moins un commentaire (d'un autre utilisateur) plus récent que sa
   * dernière consultation — ou jamais consulté du tout.
   */
  async getUnreadEntities(projectId: string, access: AccessCheck) {
    await this.assertProjectAccess(projectId, access);

    const latestByEntity = await this.prisma.comment.groupBy({
      by: ['entity_type', 'entity_id'],
      where: { project_id: projectId, author_id: { not: access.userId } },
      _max: { created_at: true },
    });

    if (latestByEntity.length === 0) {
      return { requirement: [], test_case: [] };
    }

    const reads = await this.prisma.commentRead.findMany({
      where: { project_id: projectId, user_id: access.userId },
    });
    const lastReadByEntity = new Map(reads.map(r => [`${r.entity_type}:${r.entity_id}`, r.last_read_at]));

    const result: { requirement: string[]; test_case: string[] } = { requirement: [], test_case: [] };
    for (const group of latestByEntity) {
      const lastCommentAt = group._max.created_at;
      if (!lastCommentAt) continue;
      const lastReadAt = lastReadByEntity.get(`${group.entity_type}:${group.entity_id}`);
      const isUnread = !lastReadAt || lastReadAt < lastCommentAt;
      if (isUnread && (group.entity_type === 'requirement' || group.entity_type === 'test_case')) {
        result[group.entity_type as 'requirement' | 'test_case'].push(group.entity_id);
      }
    }

    return result;
  }

  /**
   * Accusés de lecture ("vu") d'un commentaire : pour chaque destinataire
   * ayant reçu une notification liée (mention directe, ou réponse à ce
   * commentaire), indique s'il l'a déjà lue et à quel moment — utile à
   * l'auteur pour savoir s'il doit relancer un coéquipier ou non. Réservé à
   * l'auteur du commentaire (et aux admins) : ce n'est pas une information
   * publique du fil, contrairement au contenu du commentaire lui-même.
   */
  async getSeenBy(id: string, access: AccessCheck) {
    const comment = await this.prisma.comment.findUnique({ where: { id } });
    if (!comment) throw new NotFoundException('Commentaire introuvable');

    await this.assertProjectAccess(comment.project_id, access);

    if (comment.author_id !== access.userId && !access.isAdmin) {
      throw new ForbiddenException("Seul l'auteur du commentaire peut consulter les accusés de lecture");
    }

    // Destinataires attendus pour CE commentaire : les utilisateurs mentionnés,
    // plus l'auteur du commentaire parent si celui-ci est une réponse (c'est
    // lui qui reçoit la notification 'comment_reply' — voir create() plus haut).
    // Source de vérité = le commentaire lui-même, PAS "les notifications qui
    // existent en base" comme avant : si une notification n'a jamais été créée
    // pour un destinataire (auto-notification filtrée, incident ponctuel...),
    // l'ancien calcul l'ignorait silencieusement — il pouvait alors manquer un
    // destinataire réel et faire disparaître "Relancer" dès qu'UN SEUL des
    // destinataires effectivement suivis avait lu, même s'il en restait
    // d'autres qui n'avaient jamais rien reçu.
    const recipientIds = new Set<string>(comment.mentioned_user_ids ?? []);
    if (comment.parent_id) {
      const parent = await this.prisma.comment.findUnique({ where: { id: comment.parent_id } });
      if (parent && parent.author_id !== comment.author_id) recipientIds.add(parent.author_id);
    }
    recipientIds.delete(comment.author_id); // jamais soi-même

    if (recipientIds.size === 0) return [];

    const ids = Array.from(recipientIds);
    const [notifs, users] = await Promise.all([
      this.prisma.notification.findMany({
        where: { comment_id: id, type: { in: ['mention', 'comment_reply'] }, user_id: { in: ids } },
      }),
      this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    ]);
    const notifByUser = new Map(notifs.map(n => [n.user_id, n]));
    const nameById = new Map(users.map(u => [u.id, u.name]));

    return ids.map(userId => {
      const notif = notifByUser.get(userId);
      return {
        userId,
        userName: nameById.get(userId) ?? 'Utilisateur',
        read: notif?.read ?? false,
        readAt: notif?.read_at ?? null,
      };
    });
  }

  /**
   * Relance : renvoie une notification ciblée aux seuls destinataires
   * (mentionnés / répondu-à) qui n'ont PAS encore lu ce commentaire — c'est
   * tout l'intérêt par rapport à re-mentionner tout le monde à nouveau.
   * Réservé à l'auteur du commentaire, comme getSeenBy ci-dessus.
   */
  async remind(id: string, access: AccessCheck, authorName: string) {
    const comment = await this.prisma.comment.findUnique({ where: { id } });
    if (!comment) throw new NotFoundException('Commentaire introuvable');

    await this.assertProjectAccess(comment.project_id, access);

    if (comment.author_id !== access.userId && !access.isAdmin) {
      throw new ForbiddenException("Seul l'auteur du commentaire peut relancer");
    }

    const notifs = await this.prisma.notification.findMany({
      where: { comment_id: id, type: { in: ['mention', 'comment_reply'] }, read: false },
    });
    const unseenUserIds = Array.from(new Set(notifs.map(n => n.user_id)));

    if (unseenUserIds.length === 0) {
      throw new BadRequestException('Tout le monde a déjà lu ce commentaire — rien à relancer');
    }

    const link = this.buildLink(comment.entity_type, comment.entity_id, comment.project_id, comment.id);
    await this.notificationsService.notifyMany(unseenUserIds, {
      type: 'comment_reminder',
      actorId: access.userId,
      message: `${authorName} vous relance au sujet d'un commentaire resté sans réponse.`,
      projectId: comment.project_id,
      entityType: comment.entity_type,
      entityId: comment.entity_id,
      commentId: comment.id,
      link,
    });

    return { reminded: unseenUserIds.length, userIds: unseenUserIds };
  }

  async remove(id: string, access: AccessCheck) {
    const comment = await this.prisma.comment.findUnique({ where: { id } });
    if (!comment) throw new NotFoundException('Commentaire introuvable');

    const isAuthor = comment.author_id === access.userId;
    if (!isAuthor) {
      throw new ForbiddenException("Seul l'auteur d'un commentaire peut le supprimer");
    }

    await this.prisma.comment.delete({ where: { id } });
    this.gateway.emitToEntity(comment.entity_type, comment.entity_id, 'comment:deleted', { id });
    return { deleted: true };
  }
}