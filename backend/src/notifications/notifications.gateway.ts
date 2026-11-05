import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

/** Événements de collaboration temps réel diffusés sur la room `project:<id>`. */
export type ProjectRealtimeEvent =
  | 'project:renamed'
  | 'project:deleted'
  // ── Campagne de tests (voir ProjectController.launchCampaign/closeCampaign) ──
  // Diffusé à tous les clients de la page projet pour figer/défiger l'UI en
  // direct (boutons de création/édition grisés, bouton d'exécution activé).
  | 'campaign:launched'
  | 'campaign:closed'
  | 'campaign:change-queued'
  | 'module:created'
  | 'module:updated'
  | 'module:deleted'
  | 'requirement:created'
  | 'requirement:updated'
  | 'requirement:deleted'
  | 'testcase:created'
  | 'testcase:updated'
  | 'testcase:deleted'
  | 'generation:started'
  | 'generation:completed'
  // Présence fine "quelqu'un édite ce champ" — best-effort, sans verrou dur
  // (contrairement à generation:*) : sert uniquement d'avertissement visuel
  // pour limiter les collisions, le vrai filet de sécurité est le contrôle
  // de version optimiste posé sur PATCH /projects/requirements/:id (voir
  // ProjectService.editRequirement / RequirementConflictError).
  | 'requirement:editing'
  // Même chose côté cas de test : présence "quelqu'un a des édits locaux non
  // sauvegardés sur ce TC" (voir TCCard.hasEdits / POST
  // test-cases/:id/editing-presence). Contrairement à 'requirement:editing',
  // pas de verrou dur posé ici (l'édition d'un TC est en ligne, pas de champ
  // exclusif à ouvrir) — best-effort comme 'requirement:adding' ci-dessous.
  // C'est ce signal qui manquait pour que les modifications de TC
  // apparaissent dans la bannière "Activité de l'équipe en cours" côté
  // frontend (analyzer/page.tsx, activeTcEdits).
  | 'testcase:editing'
  // Présence "quelqu'un regarde cette ligne" — encore plus léger que
  // 'requirement:editing' : pas de verrou du tout, plusieurs personnes
  // peuvent "voir" la même ligne en même temps (contrairement à l'édition,
  // exclusive). Déclenché à l'ouverture/sélection d'une exigence ou d'un TC
  // dans l'UI (voir ModuleReqEditor.tsx / TCCard dans analyzer/page.tsx),
  // affiché comme un badge "👀 Nom" sur la ligne concernée.
  | 'requirement:viewing'
  | 'testcase:viewing'
  // Présence "quelqu'un a le formulaire + Nouveau TC ouvert pour cette
  // exigence" — même léger que 'requirement:viewing' (pas de verrou), voir
  // POST .../requirements/:id/adding-presence. Alimente la bannière
  // "Activité de l'équipe en cours" côté frontend (avec génération/édition).
  | 'requirement:adding'
  // Rejet d'un TC EN ATTENTE (jamais persisté en DB, donc distinct de
  // 'testcase:deleted' qui suppose une suppression réelle en base) — voir
  // POST .../test-cases/reject-pending.
  | 'testcase:rejected'
  // Nouvelle entrée dans le fil d'activité du projet (voir
  // NotificationsService.notifyProjectActivity) — diffusée à tous les clients
  // ayant la room `project:<id>` ouverte pour alimenter le panneau "Aujourd'hui
  // sur ce projet" en direct, en plus de la persistance en base consultable
  // par scroll (GET /projects/:id/activity).
  | 'activity:new'
  // ── Workflows de test (voir WorkflowController) ──────────────────────────
  | 'workflow:created'
  | 'workflow:updated'
  | 'workflow:deleted'
  | 'workflow:run-updated'
  // Présence "quelqu'un consulte/édite ce workflow" — même mécanique que
  // requirement:viewing/editing ci-dessus (viewing = léger, sans verrou ;
  // editing = verrou dur via tryLockAction, voir WorkflowController).
  | 'workflow:viewing'
  | 'workflow:editing'
  // Diffusion éphémère (aucune écriture en base) du graphe en cours
  // d'édition — voir POST .../workflows/:id/canvas-live. Contrairement à
  // 'workflow:updated', ne déclenche jamais de refetch : les autres clients
  // appliquent nodes/edges reçus directement en local pour un rendu "live".
  | 'workflow:canvas-live';

/** Statut d'activité affiché en direct sur l'avatar de présence d'un utilisateur. */
export type PresenceActivity = 'idle' | 'editing' | 'generating';

/**
 * Gateway de notifications ET de commentaires temps réel.
 *
 * Auth : le socket.io "ticket" JWT court (60s), obtenu via
 * GET /notifications/ws-ticket (authentifié normalement via JwtAuthGuard,
 * donc compatible avec le proxy Next.js existant), est passé par le client
 * en tant que `auth: { ticket }` à la connexion. On ne réutilise pas
 * directement le token d'accès principal pour éviter de l'exposer côté
 * transport WebSocket sur une durée de vie plus longue que nécessaire.
 *
 * Trois types de rooms :
 * - `user:<userId>` — notifications personnelles (mentions, résolutions...).
 * - `entity:<entityType>:<entityId>` — mises à jour live du fil de commentaires
 *   d'une exigence/TC précise ; un client la rejoint uniquement pendant que
 *   le drawer de commentaires correspondant est ouvert (voir CommentThread).
 * - `project:<projectId>` — collaboration temps réel à l'échelle d'un projet :
 *   présence des utilisateurs connectés (`project:presence`) + diffusion de
 *   toute création/modification/suppression de module, exigence ou cas de
 *   test, et des étapes de génération IA (voir ProjectRealtimeEvent). Un
 *   client la rejoint tant que la page du projet est ouverte (voir
 *   useProjectRealtime côté frontend).
 */
@WebSocketGateway({
  cors: {
    origin: ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3004'],
    credentials: true,
  },
  namespace: '/notifications',
})
export class NotificationsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(NotificationsGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const ticket =
        (client.handshake.auth as any)?.ticket ||
        (client.handshake.query as any)?.ticket;

      if (!ticket) {
        throw new Error('Ticket manquant');
      }

      const secret = this.configService.get<string>('JWT_SECRET', 'secret');
      const payload = await this.jwtService.verifyAsync(ticket, { secret });

      if (payload?.purpose !== 'ws-ticket' || !payload?.sub) {
        throw new Error('Ticket invalide');
      }

      (client.data as any).userId = payload.sub;
      (client.data as any).userName = payload.name || payload.email || 'Utilisateur';
      client.join(`user:${payload.sub}`);
      this.logger.debug(`Client connecté (user ${payload.sub})`);
    } catch (err: any) {
      this.logger.warn(`Connexion WebSocket refusée: ${err.message}`);
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    const userId = (client.data as any)?.userId;
    if (userId) this.logger.debug(`Client déconnecté (user ${userId})`);
    // Retire le client de toutes les rooms projet où il était présent et
    // notifie les autres participants (présence live).
    for (const projectId of Array.from((client.data as any)?.projectRooms ?? [])) {
      this.leaveProjectPresence(client, projectId as string);
    }
    // Onglet fermé/perdu en pleine frappe : évite un indicateur "X écrit un
    // commentaire..." fantôme qui resterait affiché indéfiniment côté des
    // autres participants (voir onTyping ci-dessous).
    const typing = this.typingBySocket.get(client.id);
    if (typing) {
      this.typingBySocket.delete(client.id);
      this.server?.to(this.entityRoom(typing.entityType, typing.entityId)).emit('comment:typing', {
        entityType: typing.entityType,
        entityId: typing.entityId,
        actorId: userId,
        actorName: (client.data as any)?.userName || 'Utilisateur',
        active: false,
      });
    }
  }

  private entityRoom(entityType: string, entityId: string) {
    return `entity:${entityType}:${entityId}`;
  }

  private projectRoom(projectId: string) {
    return `project:${projectId}`;
  }

  // ── Présence par projet ──────────────────────────────────────────────────
  // Map<projectId, Map<socketId, { userId, userName, activity, activityLabel }>>
  // — en mémoire (process unique) ; suffisant pour un seul backend NestJS.
  // À déplacer vers un adapter Redis (socket.io-redis) si le backend est un
  // jour scalé horizontalement.
  private presence = new Map<string, Map<string, { userId: string; userName: string; activity: PresenceActivity; activityLabel?: string }>>();

  private broadcastPresence(projectId: string) {
    const members = Array.from(this.presence.get(projectId)?.values() ?? []);
    // Dédoublonne par userId (un même utilisateur peut avoir plusieurs onglets ouverts).
    const uniqueByUser = Array.from(new Map(members.map(m => [m.userId, m])).values());
    this.server?.to(this.projectRoom(projectId)).emit('project:presence', { projectId, users: uniqueByUser });
  }

  /** Le client rejoint la room d'un projet pour recevoir les mises à jour live (exigences, TC, génération...). */
  @SubscribeMessage('project:join')
  onJoinProject(@ConnectedSocket() client: Socket, @MessageBody() body: { projectId: string }) {
    const projectId = body?.projectId;
    const userId = (client.data as any)?.userId;
    const userName = (client.data as any)?.userName || 'Utilisateur';
    if (!projectId || !userId) return;

    client.join(this.projectRoom(projectId));
    const rooms: Set<string> = (client.data as any).projectRooms ?? new Set();
    rooms.add(projectId);
    (client.data as any).projectRooms = rooms;

    if (!this.presence.has(projectId)) this.presence.set(projectId, new Map());
    this.presence.get(projectId)!.set(client.id, { userId, userName, activity: 'idle' });
    this.broadcastPresence(projectId);

    // Rattrapage : un utilisateur qui ouvre le projet APRÈS le démarrage
    // d'une génération (angles, cas de test, ou remplissage du formulaire
    // Signature — voir trackGenerationSnapshot) n'a jamais reçu l'événement
    // 'generation:started' correspondant puisqu'il n'était pas encore dans
    // la room à ce moment-là. On le lui renvoie individuellement dès qu'il
    // rejoint, pour que le bandeau "X (Mode Y) fait Z pour FR-..." apparaisse
    // immédiatement — le frontend le traite exactement comme un événement
    // 'generation:started' normal (voir handleProjectRealtimeEvent).
    for (const gen of this.getActiveGenerationsSnapshot(projectId)) {
      if (gen.actorId === userId) continue; // pas son propre badge
      client.emit('generation:started', {
        projectId, requirementId: gen.requirementId, actorId: gen.actorId, actorName: gen.actorName,
        genMode: gen.genMode, step: gen.step, at: new Date().toISOString(),
      });
    }
    for (const edit of this.getActiveEditsSnapshot(projectId)) {
      if (edit.actorId === userId) continue;
      client.emit('requirement:editing', {
        projectId, requirementId: edit.requirementId, actorId: edit.actorId, actorName: edit.actorName,
        active: true, at: new Date().toISOString(),
      });
    }
    for (const view of this.getActiveViewsSnapshot(projectId)) {
      if (view.actorId === userId) continue;
      client.emit(view.entityType === 'testcase' ? 'testcase:viewing' : 'requirement:viewing', {
        projectId,
        [view.entityType === 'testcase' ? 'testCaseId' : 'requirementId']: view.entityId,
        actorId: view.actorId, actorName: view.actorName, active: true, at: new Date().toISOString(),
      });
    }
  }

  /** Le client quitte la room d'un projet (fermeture / changement de projet). */
  @SubscribeMessage('project:leave')
  onLeaveProject(@ConnectedSocket() client: Socket, @MessageBody() body: { projectId: string }) {
    if (!body?.projectId) return;
    this.leaveProjectPresence(client, body.projectId);
  }

  private leaveProjectPresence(client: Socket, projectId: string) {
    client.leave(this.projectRoom(projectId));
    (client.data as any).projectRooms?.delete(projectId);
    this.presence.get(projectId)?.delete(client.id);
    if (this.presence.get(projectId)?.size === 0) this.presence.delete(projectId);
    this.broadcastPresence(projectId);
  }

  /**
   * Met à jour l'activité affichée pour un utilisateur sur un projet (idle /
   * editing / generating) et redistribue la présence à jour. Appelée soit
   * directement par le client (voir `onActivity` ci-dessous, ex: ouverture
   * du mode édition), soit par le backend lui-même autour d'une génération
   * IA (voir ProjectController / LlmController).
   */
  setActivity(projectId: string, userId: string, activity: PresenceActivity, activityLabel?: string) {
    const room = this.presence.get(projectId);
    if (!room) return;
    let changed = false;
    for (const entry of room.values()) {
      if (entry.userId === userId) {
        entry.activity = activity;
        entry.activityLabel = activityLabel;
        changed = true;
      }
    }
    if (changed) this.broadcastPresence(projectId);
  }

  /** Le client signale son activité courante (édition, génération, retour à idle). */
  @SubscribeMessage('project:activity')
  onActivity(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { projectId: string; activity: PresenceActivity; label?: string },
  ) {
    const userId = (client.data as any)?.userId;
    if (!userId || !body?.projectId || !body?.activity) return;
    this.setActivity(body.projectId, userId, body.activity, body.label);
  }

  /** Le client rejoint la room d'une exigence/TC pour recevoir ses commentaires en direct. */
  @SubscribeMessage('comments:join')
  onJoinEntity(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { entityType: string; entityId: string },
  ) {
    if (!body?.entityType || !body?.entityId) return;
    client.join(this.entityRoom(body.entityType, body.entityId));
  }

  /** Le client quitte la room (drawer fermé / changement d'exigence). */
  @SubscribeMessage('comments:leave')
  onLeaveEntity(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { entityType: string; entityId: string },
  ) {
    if (!body?.entityType || !body?.entityId) return;
    client.leave(this.entityRoom(body.entityType, body.entityId));
  }

  // ── Indicateur de frappe ("X écrit un commentaire...") ───────────────────
  // Best-effort, comme la présence "viewing"/"editing" ci-dessus : aucune
  // persistance, juste un relais direct aux autres clients ayant la room de
  // l'entité ouverte (drawer de commentaires visible). On garde une trace
  // légère par socket (typingBySocket) uniquement pour pouvoir couper
  // proprement l'indicateur si l'onglet se ferme en pleine frappe (voir
  // handleDisconnect ci-dessus) — pas de TTL de rattrapage nécessaire ici,
  // contrairement aux snapshots de génération/édition/vue : un nouvel
  // arrivant sur le fil n'a pas besoin de savoir qui tapait il y a 2 secondes.
  private typingBySocket = new Map<string, { entityType: string; entityId: string }>();

  /** Le client signale qu'il commence/arrête de taper un commentaire sur une exigence/TC. */
  @SubscribeMessage('comments:typing')
  onTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { entityType: string; entityId: string; active: boolean },
  ) {
    const userId = (client.data as any)?.userId;
    const userName = (client.data as any)?.userName || 'Utilisateur';
    if (!userId || !body?.entityType || !body?.entityId) return;

    if (body.active) {
      this.typingBySocket.set(client.id, { entityType: body.entityType, entityId: body.entityId });
    } else {
      this.typingBySocket.delete(client.id);
    }

    // Diffusé aux autres occupants de la room uniquement (pas à l'émetteur
    // lui-même) — même logique que emitToEntity, mais via `client.to(...)`.
    client.to(this.entityRoom(body.entityType, body.entityId)).emit('comment:typing', {
      entityType: body.entityType,
      entityId: body.entityId,
      actorId: userId,
      actorName: userName,
      active: Boolean(body.active),
    });
  }

  /** Pousse une notification à toutes les connexions ouvertes d'un utilisateur. */
  pushToUser(userId: string, notification: unknown) {
    this.server?.to(`user:${userId}`).emit('notification', notification);
  }

  /**
   * Signale à un ensemble d'utilisateurs (typiquement les membres du projet,
   * hors auteur) qu'un commentaire vient d'être ajouté sur une exigence/TC,
   * pour que le badge rouge correspondant s'allume en direct côté frontend
   * (indépendamment des notifications de mention/réponse).
   */
  emitUnseenComment(userIds: string[], payload: { projectId: string; entityType: string; entityId: string }) {
    for (const userId of userIds) {
      this.server?.to(`user:${userId}`).emit('comment:unseen', payload);
    }
  }

  /** Diffuse un événement de commentaire (création/résolution/réouverture) à tous ceux qui regardent cette entité. */
  emitToEntity(entityType: string, entityId: string, event: 'comment:new' | 'comment:updated' | 'comment:deleted', payload: unknown) {
    this.server?.to(this.entityRoom(entityType, entityId)).emit(event, payload);
  }

  /**
   * Accusé "vu" : notifie en direct qu'un destinataire (mentionné, ou auteur
   * du commentaire parent pour une réponse) vient de lire la notification
   * liée à `commentId` — voir NotificationsService.markRead/markAllRead, qui
   * appelle ceci après avoir persisté `read`/`read_at` sur la notification.
   * Poussé à deux endroits :
   * - `user:<authorId>` : l'auteur du commentaire voit le badge "Vu" changer
   *   même s'il n'a pas le drawer ouvert (ex: depuis la cloche de notifs).
   * - la room de l'entité : si l'auteur (ou toute autre personne) a le fil
   *   de commentaires ouvert au même moment, la mise à jour arrive sans
   *   attendre un rechargement.
   */
  notifyCommentSeen(payload: {
    commentId: string;
    entityType?: string;
    entityId?: string;
    authorId?: string;
    userId: string;
    userName: string;
    readAt: string;
  }) {
    if (payload.authorId) {
      this.server?.to(`user:${payload.authorId}`).emit('comment:seen', payload);
    }
    if (payload.entityType && payload.entityId) {
      this.server?.to(this.entityRoom(payload.entityType, payload.entityId)).emit('comment:seen', payload);
    }
  }

  /**
   * Accusé "vu" générique de fil (voir CommentsService.markRead /
   * getReadReceipts) : contrairement à notifyCommentSeen ci-dessus (limité
   * aux destinataires d'une mention/réponse précise), celui-ci concerne
   * n'importe quel membre ayant consulté le fil, pour n'importe quel
   * commentaire. Diffusé uniquement à la room de l'entité — c'est elle qui
   * porte les petits avatars "vu" sous chaque commentaire côté frontend — pour
   * que ceux qui ont le drawer ouvert au même moment les voient apparaître
   * sans recharger.
   */
  notifyThreadSeen(payload: { entityType: string; entityId: string; userId: string; userName: string; readAt: string }) {
    this.server?.to(this.entityRoom(payload.entityType, payload.entityId)).emit('comment:thread-seen', payload);
  }

  /**
   * Diffuse un événement de collaboration temps réel (module/exigence/cas de
   * test créé, modifié, supprimé, génération démarrée/terminée, projet
   * renommé...) à tous les utilisateurs actuellement sur ce projet, hors
   * l'auteur de l'action (optionnel, via excludeUserId) pour éviter que
   * l'auteur ne se voie notifier son propre changement.
   *
   * `payload` inclut toujours `actorId` / `actorName` pour permettre au
   * frontend d'afficher "Jean a ajouté une exigence" côté des autres
   * utilisateurs.
   */
  emitToProject(projectId: string, event: ProjectRealtimeEvent, payload: Record<string, unknown>) {
    this.trackGenerationSnapshot(projectId, event, payload);
    this.trackEditingSnapshot(projectId, event, payload);
    this.trackViewingSnapshot(projectId, event, payload);
    this.server?.to(this.projectRoom(projectId)).emit(event, payload);
  }

  // ── Snapshot des générations actives par exigence (pour le rattrapage des
  // nouveaux arrivants, voir onJoinProject ci-dessus) ────────────────────────
  // Map<projectId, Map<requirementId, { actorId, actorName, genMode, step, at }>>
  // Alimentée automatiquement à chaque emitToProject('generation:started'/
  // 'generation:completed', ...) — aucun appelant n'a besoin d'y toucher
  // directement. En mémoire (process unique), même limite que `presence`
  // ci-dessus (adapter Redis nécessaire si le backend est scalé un jour).
  private activeGenerationsByProject = new Map<string, Map<string, { actorId?: string; actorName: string; genMode?: string; step?: string; at: number }>>();
  private readonly GENERATION_SNAPSHOT_TTL_MS = 10 * 60 * 1000; // filet de sécurité si un 'completed' n'arrive jamais (process planté)

  private trackGenerationSnapshot(projectId: string, event: ProjectRealtimeEvent, payload: Record<string, unknown>) {
    const requirementId = payload.requirementId as string | undefined;
    if (!requirementId || (event !== 'generation:started' && event !== 'generation:completed')) return;

    if (event === 'generation:started') {
      if (!this.activeGenerationsByProject.has(projectId)) this.activeGenerationsByProject.set(projectId, new Map());
      this.activeGenerationsByProject.get(projectId)!.set(requirementId, {
        actorId: payload.actorId as string | undefined,
        actorName: (payload.actorName as string) || 'Un utilisateur',
        genMode: payload.genMode as string | undefined,
        step: payload.step as string | undefined,
        at: Date.now(),
      });
      return;
    }

    // event === 'generation:completed'
    const projectMap = this.activeGenerationsByProject.get(projectId);
    if (!projectMap) return;
    // Même garde anti-race que côté frontend (voir handleProjectRealtimeEvent
    // dans analyzer/page.tsx) : une étape informative qui se termine (angles/
    // form) ne doit pas effacer une étape 'testcases' déjà en cours si les
    // événements arrivent dans le désordre.
    const current = projectMap.get(requirementId);
    if (current && payload.step && current.step && current.step !== payload.step) return;
    projectMap.delete(requirementId);
    if (projectMap.size === 0) this.activeGenerationsByProject.delete(projectId);
  }

  /** Générations actuellement en cours sur un projet, filtrées des entrées trop anciennes (filet de sécurité). */
  private getActiveGenerationsSnapshot(projectId: string): Array<{ requirementId: string; actorId?: string; actorName: string; genMode?: string; step?: string }> {
    const projectMap = this.activeGenerationsByProject.get(projectId);
    if (!projectMap) return [];
    const now = Date.now();
    const out: Array<{ requirementId: string; actorId?: string; actorName: string; genMode?: string; step?: string }> = [];
    for (const [requirementId, info] of projectMap.entries()) {
      if (now - info.at > this.GENERATION_SNAPSHOT_TTL_MS) { projectMap.delete(requirementId); continue; }
      out.push({ requirementId, actorId: info.actorId, actorName: info.actorName, genMode: info.genMode, step: info.step });
    }
    return out;
  }

  // ── Snapshot des exigences en cours d'édition par un utilisateur (présence
  // fine, best-effort — voir 'requirement:editing' dans ProjectRealtimeEvent) ──
  // Même mécanique que activeGenerationsByProject ci-dessus, mais TTL plus
  // courte : contrairement à une génération LLM qui peut légitimement durer
  // plusieurs minutes, une session d'édition de champ qui ne se referme
  // jamais (onglet fermé sans déclencher le cleanup côté front) est presque
  // toujours un abandon — mieux vaut l'oublier vite plutôt que de bloquer le
  // badge indéfiniment pour les autres.
  private activeEditsByProject = new Map<string, Map<string, { actorId?: string; actorName: string; at: number }>>();
  private readonly EDITING_SNAPSHOT_TTL_MS = 2 * 60 * 1000;

  private trackEditingSnapshot(projectId: string, event: ProjectRealtimeEvent, payload: Record<string, unknown>) {
    const requirementId = payload.requirementId as string | undefined;
    if (!requirementId || event !== 'requirement:editing') return;
    const active = Boolean(payload.active);

    if (active) {
      if (!this.activeEditsByProject.has(projectId)) this.activeEditsByProject.set(projectId, new Map());
      this.activeEditsByProject.get(projectId)!.set(requirementId, {
        actorId: payload.actorId as string | undefined,
        actorName: (payload.actorName as string) || 'Un utilisateur',
        at: Date.now(),
      });
      return;
    }

    const projectMap = this.activeEditsByProject.get(projectId);
    if (!projectMap) return;
    projectMap.delete(requirementId);
    if (projectMap.size === 0) this.activeEditsByProject.delete(projectId);
  }

  /** Exigences actuellement en cours d'édition sur un projet, filtrées des entrées trop anciennes (filet de sécurité). */
  private getActiveEditsSnapshot(projectId: string): Array<{ requirementId: string; actorId?: string; actorName: string }> {
    const projectMap = this.activeEditsByProject.get(projectId);
    if (!projectMap) return [];
    const now = Date.now();
    const out: Array<{ requirementId: string; actorId?: string; actorName: string }> = [];
    for (const [requirementId, info] of projectMap.entries()) {
      if (now - info.at > this.EDITING_SNAPSHOT_TTL_MS) { projectMap.delete(requirementId); continue; }
      out.push({ requirementId, actorId: info.actorId, actorName: info.actorName });
    }
    return out;
  }

  // ── Snapshot "qui regarde quoi" (présence de visualisation, PAS un verrou) ──
  // Contrairement à activeEditsByProject ci-dessus (un seul éditeur à la
  // fois, imposé par le verrou dur posé côté controller), plusieurs
  // personnes peuvent "voir" la même ligne en même temps — d'où une Map
  // interne par actorId plutôt qu'une entrée unique par entité. Clé externe
  // = `requirement:<id>` ou `testcase:<id>`. TTL courte comme pour l'édition :
  // best-effort, on préfère oublier vite un onglet fermé sans cleanup plutôt
  // que d'afficher un badge fantôme indéfiniment.
  private activeViewsByProject = new Map<string, Map<string, Map<string, { actorName: string; at: number }>>>();
  private readonly VIEWING_SNAPSHOT_TTL_MS = 2 * 60 * 1000;

  private viewingEntityKey(event: ProjectRealtimeEvent, payload: Record<string, unknown>): { entityType: 'requirement' | 'testcase'; entityId: string } | null {
    if (event === 'requirement:viewing') {
      const id = payload.requirementId as string | undefined;
      return id ? { entityType: 'requirement', entityId: id } : null;
    }
    if (event === 'testcase:viewing') {
      const id = payload.testCaseId as string | undefined;
      return id ? { entityType: 'testcase', entityId: id } : null;
    }
    return null;
  }

  private trackViewingSnapshot(projectId: string, event: ProjectRealtimeEvent, payload: Record<string, unknown>) {
    const entity = this.viewingEntityKey(event, payload);
    if (!entity) return;
    const actorId = payload.actorId as string | undefined;
    if (!actorId) return;
    const active = Boolean(payload.active);
    const entityKey = `${entity.entityType}:${entity.entityId}`;

    if (active) {
      if (!this.activeViewsByProject.has(projectId)) this.activeViewsByProject.set(projectId, new Map());
      const projectMap = this.activeViewsByProject.get(projectId)!;
      if (!projectMap.has(entityKey)) projectMap.set(entityKey, new Map());
      projectMap.get(entityKey)!.set(actorId, { actorName: (payload.actorName as string) || 'Un utilisateur', at: Date.now() });
      return;
    }

    const projectMap = this.activeViewsByProject.get(projectId);
    const viewers = projectMap?.get(entityKey);
    viewers?.delete(actorId);
    if (viewers && viewers.size === 0) projectMap!.delete(entityKey);
    if (projectMap && projectMap.size === 0) this.activeViewsByProject.delete(projectId);
  }

  /** Vues actuellement actives sur un projet (tous types confondus), filtrées des entrées trop anciennes. */
  private getActiveViewsSnapshot(projectId: string): Array<{ entityType: 'requirement' | 'testcase'; entityId: string; actorId: string; actorName: string }> {
    const projectMap = this.activeViewsByProject.get(projectId);
    if (!projectMap) return [];
    const now = Date.now();
    const out: Array<{ entityType: 'requirement' | 'testcase'; entityId: string; actorId: string; actorName: string }> = [];
    for (const [entityKey, viewers] of projectMap.entries()) {
      const [entityType, entityId] = entityKey.split(/:(.+)/) as ['requirement' | 'testcase', string];
      for (const [actorId, info] of viewers.entries()) {
        if (now - info.at > this.VIEWING_SNAPSHOT_TTL_MS) { viewers.delete(actorId); continue; }
        out.push({ entityType, entityId, actorId, actorName: info.actorName });
      }
      if (viewers.size === 0) projectMap.delete(entityKey);
    }
    return out;
  }

  // ── Verrou anti-action concurrente (générique) ────────────────────────────
  // Empêche deux utilisateurs de lancer la MÊME action « longue » (génération
  // LLM, export Jira, création d'espace Confluence...) sur la MÊME ressource
  // en même temps — gaspillage (tokens, appels API externes) + risque de
  // doublons. En mémoire (process unique), avec expiration de sécurité si un
  // process plante en cours de route sans libérer le verrou.
  //
  // La clé est libre (convention `<kind>:<resourceId>`, ex: `generation:<reqId>`,
  // `jira-export:<testCaseId>`, `confluence-space:<projectId>`) — un même
  // "kind" ne bloque jamais un autre "kind" puisque les clés sont distinctes.
  private actionLocks = new Map<string, { actorId: string; actorName: string; startedAt: number }>();
  private readonly ACTION_LOCK_TTL_MS = 10 * 60 * 1000; // 10 min

  /**
   * Tente de poser un verrou sur une ressource identifiée par `key`.
   * - Renvoie `null` si le verrou est posé avec succès (l'appelant peut agir).
   * - Renvoie le détenteur actuel du verrou si quelqu'un d'autre a déjà la
   *   main dessus (l'appelant doit refuser/avertir avec ce détenteur).
   * - Si le même utilisateur relance (double-clic, retry), on renouvelle son
   *   propre verrou sans bloquer.
   */
  tryLockAction(key: string, actorId: string, actorName: string, ttlMs = this.ACTION_LOCK_TTL_MS): { actorId: string; actorName: string } | null {
    const existing = this.actionLocks.get(key);
    if (existing && existing.actorId !== actorId && Date.now() - existing.startedAt < ttlMs) {
      return { actorId: existing.actorId, actorName: existing.actorName };
    }
    this.actionLocks.set(key, { actorId, actorName, startedAt: Date.now() });
    return null;
  }

  /** Libère le verrou — uniquement s'il est toujours détenu par ce même utilisateur. */
  unlockAction(key: string, actorId: string) {
    const existing = this.actionLocks.get(key);
    if (existing?.actorId === actorId) this.actionLocks.delete(key);
  }

  // ── Rétrocompatibilité : verrou de génération (ancienne API, conservée telle
  // quelle pour ne pas casser les appelants existants) — délègue au verrou
  // générique ci-dessus avec la clé `generation:<requirementId>`.
  tryLockGeneration(requirementId: string, actorId: string, actorName: string): { actorId: string; actorName: string } | null {
    return this.tryLockAction(`generation:${requirementId}`, actorId, actorName);
  }

  unlockGeneration(requirementId: string, actorId: string) {
    this.unlockAction(`generation:${requirementId}`, actorId);
  }
}