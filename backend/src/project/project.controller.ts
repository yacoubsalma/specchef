import {
  Controller, Post, Patch, Get, Delete,
  Body, Param, Query, Logger, HttpCode, HttpStatus,
  BadRequestException, NotFoundException, ConflictException, ForbiddenException, UseGuards, Res,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';
import type { Response } from 'express';
import { ProjectService, RequirementConflictError } from './project.service';
import { ExportService } from './export.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { NotificationsGateway, ProjectRealtimeEvent } from '../notifications/notifications.gateway';
import { NotificationsService, NotificationType } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { VersionsService } from '../versions/versions.service';
import { isVersionedEntityType } from '../shared/version-types';

// ─── Modification mise en attente (campagne de tests en cours) ───────────────
// Quand ProjectService renvoie un CampaignPendingResult au lieu de l'entité
// modifiée (voir ProjectService.queueIfCampaignActive), l'action n'a PAS été
// appliquée — elle reste en standby jusqu'à la clôture de la campagne. Le
// contrôleur le signale au front via `pending: true` plutôt que de traiter
// l'appel comme un succès classique.
function isCampaignPending(result: any): result is { pending: true; changeId: string; message: string } {
  return !!result && typeof result === 'object' && result.pending === true && typeof result.changeId === 'string';
}

// ─── Nom de fichier sûr (sans accents/caractères spéciaux) ───────────────────
function slugifyFilename(name: string): string {
  return (name || 'export')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'export';
}

@ApiTags('projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('projects')
export class ProjectController {
  private readonly logger = new Logger(ProjectController.name);
  private readonly ollamaUrl: string;
  private readonly defaultModel: string;

  // Verrou dur d'édition d'exigence (voir editRequirement / requirementEditingPresence) —
  // plus court que le verrou de génération : une session d'édition de champ
  // abandonnée (onglet fermé sans cleanup) doit se libérer vite pour ne pas
  // bloquer les autres inutilement.
  private readonly REQUIREMENT_EDIT_LOCK_TTL_MS = 5 * 60 * 1000;
  private requirementEditLockKey(requirementId: string): string {
    return `requirement-edit:${requirementId}`;
  }

  constructor(
    private readonly projectService: ProjectService,
    private readonly exportService: ExportService,
    private readonly configService: ConfigService,
    private readonly realtimeGateway: NotificationsGateway,
    private readonly notificationsService: NotificationsService,
    private readonly prisma: PrismaService,
    private readonly versionsService: VersionsService,
  ) {
    this.ollamaUrl    = this.configService.get('OLLAMA_URL')   || 'http://localhost:11434';
    this.defaultModel = this.configService.get('OLLAMA_MODEL') || 'qwen2.5-coder:7b';
  }

  // ── Collaboration temps réel ───────────────────────────────────────────────
  // Diffuse un événement à tous les utilisateurs actuellement sur la page du
  // projet (voir NotificationsGateway / useProjectRealtime côté frontend), ET
  // journalise l'action en base pour tous les membres du projet (voir
  // NotificationsService.notifyProjectActivity) — ainsi un membre absent au
  // moment de l'action la retrouve dans sa cloche de notifications au lieu de
  // la manquer purement et simplement (contrairement au WebSocket "live only").
  // N'importe jamais bloquer/faire échouer la requête HTTP : erreurs avalées.
  private broadcast(
    projectId: string | null | undefined,
    event: ProjectRealtimeEvent,
    user: AuthenticatedUser,
    payload: Record<string, unknown> = {},
    options: { skipNotification?: boolean } = {},
  ) {
    if (!projectId) {
      this.logger.warn(`Diffusion temps réel ignorée (${event}) : projectId introuvable pour cette entité.`);
      return;
    }
    const actorName = user.name || user.email;
    try {
      this.realtimeGateway.emitToProject(projectId, event, {
        ...payload,
        projectId,
        actorId: user.sub,
        actorName,
        at: new Date().toISOString(),
      });
    } catch (err: any) {
      this.logger.warn(`Diffusion temps réel échouée (${event}, projet ${projectId}): ${err.message}`);
    }

    // skipNotification : utilisé quand CET événement est redondant avec une
    // autre notification déjà émise pour la même action (ex: 'testcase:created'
    // suite à une génération, déjà couvert par le 'generation:completed'
    // agrégé juste après — voir generateSingleTestCase[WithInstruction]
    // ci-dessous). L'événement WebSocket live reste diffusé normalement (les
    // autres écrans doivent quand même voir le nouveau TC apparaître) ; seule
    // la notification PERSISTÉE (cloche) est sautée pour éviter le doublon.
    if (options.skipNotification) return;

    this.buildActivityLog(event, payload, actorName)
      .then(activity => {
        if (!activity) return;
        return this.notificationsService.notifyProjectActivity({
          projectId,
          actorId: user.sub,
          actorName,
          type: activity.type,
          message: activity.message,
          entityType: activity.entityType,
          entityId: activity.entityId,
        });
      })
      .catch((err: any) => this.logger.warn(`Journalisation d'activité échouée (${event}, projet ${projectId}): ${err.message}`));
  }

  // ── Libellés métier d'un cas de test (pour le fil d'activité) ─────────────
  // Résout un UUID de TestCase vers ses identifiants LISIBLES : TC-x (test_id),
  // FR-x (req_id de l'exigence parente) et le nom du module — jamais les UUID
  // internes. Renvoie déjà le séparateur " — " prêt à concaténer, ou '' si
  // introuvable (TC déjà supprimé, id manquant...).
  private async describeTestCase(testCaseId?: string | null): Promise<string> {
    if (!testCaseId) return '';
    try {
      const tc = await this.prisma.testCase.findUnique({
        where: { id: testCaseId },
        select: { test_id: true, requirement: { select: { req_id: true, module: { select: { name: true } } } } },
      });
      if (!tc) return '';
      const idParts = [tc.test_id, tc.requirement?.req_id].filter(Boolean).join(' · ');
      const moduleLabel = tc.requirement?.module?.name ? ` (${tc.requirement.module.name})` : '';
      return idParts ? ` — ${idParts}${moduleLabel}` : '';
    } catch {
      return '';
    }
  }

  // ── Traduction événement temps réel → notification persistée ──────────────
  // `generation:started` n'est volontairement pas journalisé (transitoire,
  // suivi de près par `generation:completed` ou par l'erreur HTTP renvoyée à
  // l'appelant) — seul le résultat compte pour un membre absent.
  private async buildActivityLog(
    event: ProjectRealtimeEvent,
    payload: Record<string, unknown>,
    actorName: string,
  ): Promise<{ type: NotificationType; message: string; entityType?: string; entityId?: string } | null> {
    switch (event) {
      case 'project:renamed':
        return { type: 'project_activity', message: `${actorName} a renommé le projet en « ${payload.name} ».` };
      case 'project:deleted':
        return { type: 'project_activity', message: `${actorName} a supprimé le projet.` };
      case 'module:created': {
        const mod = payload.module as any;
        return { type: 'module_activity', message: `${actorName} a créé le module « ${mod?.name ?? ''} ».`, entityType: 'module', entityId: mod?.id };
      }
      case 'module:updated': {
        const mod = payload.module as any;
        return { type: 'module_activity', message: `${actorName} a modifié le module « ${mod?.name ?? ''} ».`, entityType: 'module', entityId: mod?.id };
      }
      case 'module:deleted':
        return { type: 'module_activity', message: `${actorName} a supprimé un module.`, entityType: 'module', entityId: payload.moduleId as string };
      case 'requirement:created': {
        const req = payload.requirement as any;
        return { type: 'requirement_activity', message: `${actorName} a ajouté l'exigence « ${req?.req_id ?? ''} ».`, entityType: 'requirement', entityId: req?.id };
      }
      case 'requirement:updated': {
        const req = payload.requirement as any;
        return { type: 'requirement_activity', message: `${actorName} a modifié l'exigence « ${req?.req_id ?? ''} ».`, entityType: 'requirement', entityId: req?.id };
      }
      case 'requirement:deleted':
        return { type: 'requirement_activity', message: `${actorName} a supprimé une exigence.`, entityType: 'requirement', entityId: payload.requirementId as string };
      // 'testcase:created' n'est journalisé QUE pour la création MANUELLE et
      // la VALIDATION d'un TC en attente (POST .../test-cases, sans
      // skipNotification) — les créations issues d'une génération PUIS
      // auto-validées passent toutes par skipNotification:true pour l'événement
      // 'testcase:created' initial (voir plus haut), déjà couvertes par le
      // message agrégé "a généré N cas de test" (generation_activity
      // ci-dessous) : sinon on aurait une ligne par TC EN PLUS de la ligne
      // agrégée, ce qui noie le fil. `manuallyEdited` (voir NewTCForm côté
      // front) distingue les deux cas qui ARRIVENT ici : un TC réellement
      // tapé à la main VS un TC généré qu'on vient de valider/persister.
      case 'testcase:created': {
        const tc = payload.testCase as any;
        const label = tc?.title ?? tc?.testId ?? tc?.test_id ?? '';
        const suffix = await this.describeTestCase(tc?.id);
        // Source unique de vérité : le champ `manually_edited` TEL QUE
        // PERSISTÉ EN BASE (renvoyé directement par Prisma dans `tc`, donc
        // fiable) — pas une valeur recopiée séparément dans le payload, qui
        // pourrait se perdre en route. true = tapé à la main (NewTCForm) ;
        // false = candidat généré par le LLM qu'on vient de valider.
        const manuallyEdited = tc?.manually_edited === true || tc?.manuallyEdited === true;
        // Log temporaire — à retirer une fois le comportement confirmé côté
        // prod. Si le message reste incorrect après déploiement, ce log dira
        // exactement ce que le backend a reçu/lu (valeur brute Prisma).
        this.logger.debug(`[activity] testcase:created manuallyEdited=${manuallyEdited} raw.manually_edited=${tc?.manually_edited} raw.manuallyEdited=${tc?.manuallyEdited} tc.id=${tc?.id}`);
        const message = manuallyEdited
          ? `${actorName} a créé le cas de test « ${label} »${suffix}.`
          : `${actorName} a validé le cas de test en attente « ${label} »${suffix}.`;
        return { type: 'testcase_activity', message, entityType: 'testcase', entityId: tc?.id };
      }
      case 'testcase:updated': {
        const tc = payload.testCase as any;
        const label = tc?.title ?? tc?.testId ?? tc?.test_id ?? '';
        const action = payload.action as string | undefined;
        // 'regenerated_pending' = POST test-cases/regen-in-memory — TC pas
        // encore en DB, pas d'UUID à résoudre via describeTestCase() : les
        // libellés métier sont déjà dans le payload (voir regenerateMemoryTestCase).
        if (action === 'regenerated_pending') {
          const idParts = [payload.testId, payload.reqId].filter(Boolean).join(' · ');
          const moduleLabel = payload.moduleName ? ` (${payload.moduleName})` : '';
          const suf = idParts ? ` — ${idParts}${moduleLabel}` : moduleLabel;
          return { type: 'testcase_activity', message: `${actorName} a régénéré le cas de test « ${label} »${suf}.`, entityType: 'testcase' };
        }
        const suffix = await this.describeTestCase(tc?.id);
        // 'reviewed' = PATCH test-cases/:id/review (validate/reject/pending)
        if (action === 'reviewed') {
          const status = payload.reviewStatus as string | undefined;
          const verb = status === 'validated' ? 'validé' : status === 'rejected' ? 'rejeté' : 'remis en attente';
          return { type: 'testcase_activity', message: `${actorName} a ${verb} le cas de test « ${label} »${suffix}.`, entityType: 'testcase', entityId: tc?.id };
        }
        // 'regenerated' = POST test-cases/:id/regenerate (TC déjà en DB)
        if (action === 'regenerated') {
          return { type: 'testcase_activity', message: `${actorName} a régénéré le cas de test « ${label} »${suffix}.`, entityType: 'testcase', entityId: tc?.id };
        }
        return { type: 'testcase_activity', message: `${actorName} a modifié le cas de test « ${label} »${suffix}.`, entityType: 'testcase', entityId: tc?.id };
      }
      // 'testcase:rejected' = POST test-cases/reject-pending — TC en attente
      // JAMAIS persisté, donc pas d'UUID/describeTestCase() possible ; les
      // libellés métier sont déjà dans le payload (testId + req_id/module de
      // l'exigence, voir rejectPendingTestCase), même pattern que
      // 'regenerated_pending' ci-dessus.
      case 'testcase:rejected': {
        const label = (payload.title as string) || (payload.testId as string) || '';
        const idParts = [payload.testId, payload.reqId].filter(Boolean).join(' · ');
        const moduleLabel = payload.moduleName ? ` (${payload.moduleName})` : '';
        const suffix = idParts ? ` — ${idParts}${moduleLabel}` : moduleLabel;
        return { type: 'testcase_activity', message: `${actorName} a rejeté le cas de test « ${label} »${suffix}.`, entityType: 'requirement', entityId: payload.requirementId as string };
      }
      case 'testcase:deleted': {
        const count = payload.count as number | undefined;
        const idParts = [payload.testId, payload.reqId].filter(Boolean).join(' · ');
        const moduleLabel = payload.moduleName ? ` (${payload.moduleName})` : '';
        const suffix = idParts ? ` — ${idParts}${moduleLabel}` : moduleLabel;
        const title = payload.title as string | undefined;
        const message = count
          ? `${actorName} a supprimé ${count} cas de test${suffix}.`
          : title
            ? `${actorName} a supprimé le cas de test « ${title} »${suffix}.`
            : `${actorName} a supprimé un cas de test${suffix}.`;
        return {
          type: 'testcase_activity',
          message,
          entityType: 'testcase',
          entityId: (payload.testCaseId as string) || (payload.requirementId as string),
        };
      }
      case 'generation:completed': {
        const mode = payload.mode as string | undefined;
        const tc = payload.testCase as any;
        const label = mode === 'bulk' ? 'une série de cas de test' : 'un cas de test';
        // Génération single (project.controller) : le TC candidat n'est PAS
        // encore persisté en base à ce stade (persist différé — pattern
        // "validate-to-persist", voir createAndValidateTestCase), donc pas
        // d'UUID pour describeTestCase(). MAIS le pipeline renvoie déjà
        // testId/requirementId/moduleId en clair (voir
        // _runGeneratePipelineFast dans project.service.ts : requirementId
        // ici = req_id métier, PAS l'UUID ; moduleId = nom du module, pas un
        // id) — on les réutilise directement, sans requête supplémentaire.
        let suffix = '';
        if (tc) {
          const idParts = [tc.testId, tc.requirementId].filter(Boolean).join(' · ');
          const moduleLabel = tc.moduleId ? ` (${tc.moduleId})` : '';
          suffix = idParts ? ` — ${idParts}${moduleLabel}` : moduleLabel;
        }
        return { type: 'generation_activity', message: `${actorName} a généré ${label}${suffix}.`, entityType: 'requirement', entityId: payload.requirementId as string };
      }
      default:
        return null;
    }
  }

  // ── POST /projects (create empty, no file) ────────────────────────────────
  @Post()
  @Roles(Role.ADMIN, Role.BA, Role.PO)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Créer un projet vide (sans fichier) — Admin/BA uniquement' })
  async createEmptyProject(
    @Body() body: { name: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!body.name?.trim()) throw new BadRequestException('name is required');
    try {
      const project = await this.projectService.createEmptyProject(body.name, user.sub);
      return { success: true, data: project, projectId: project.id };
    } catch (err: any) { throw new BadRequestException(err.message); }
  }

  // ── PATCH /projects/:id (rename) ──────────────────────────────────────────
  @Patch(':id')
  @Roles(Role.ADMIN, Role.BA, Role.PO)
  @ApiOperation({ summary: 'Renommer un projet — Admin/BA (+ vérif. propriétaire) uniquement' })
  async renameProject(
    @Param('id') id: string,
    @Body() body: { name: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!body.name?.trim()) throw new BadRequestException('name is required');
    try {
      const project = await this.projectService.renameProject(id, body.name, {
        userId: user.sub,
        isAdmin: user.role === 'ADMIN',
      });
      this.broadcast(id, 'project:renamed', user, { name: body.name });
      return { success: true, data: project };
    } catch (err: any) {
      if (err?.status === 403) throw err;
      throw new BadRequestException(err.message);
    }
  }

  // ── POST /projects/:id/campaign/launch ──────────────────────────────────
  // Lance la campagne de tests : fige les workflows (aucune création/
  // modification/suppression, voir WorkflowService) et met en standby toute
  // modification de module/exigence/cas de test (voir
  // ProjectService.queueIfCampaignActive — plus de blocage dur pour ces
  // entités), et à l'inverse débloque le démarrage d'exécutions de workflow
  // (voir WorkflowService.startRun / assertCampaignLaunched).
  // Réservé au PO : rôle hiérarchiquement supérieur au BA, seul habilité à
  // décider du lancement d'une campagne de tests.
  @Post(':id/campaign/launch')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.PO)
  @ApiOperation({ summary: 'Lancer la campagne de tests — fige les workflows, met en standby le reste (PO uniquement)' })
  async launchCampaign(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    const data = await this.projectService.launchCampaign(
      id,
      { id: user.sub, name: user.name || user.email },
      { userId: user.sub, isAdmin: user.role === 'ADMIN' },
    );
    this.broadcast(id, 'campaign:launched', user, {
      campaign_status: data.campaign_status,
      campaign_launched_at: data.campaign_launched_at,
    });
    return { success: true, data };
  }

  // ── GET /projects/:id/campaign/pending-changes ────────────────────────────
  // Liste les modifications mises en standby pendant la campagne en cours,
  // pas encore résolues (garder/annuler) — alimente l'écran de clôture.
  @Get(':id/campaign/pending-changes')
  @ApiOperation({ summary: 'Lister les modifications en attente de résolution pour la clôture de campagne' })
  async listPendingCampaignChanges(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    const data = await this.projectService.listPendingCampaignChanges(id, { userId: user.sub, isAdmin: user.role === 'ADMIN' });
    return { success: true, data };
  }

  // ── GET /projects/:id/campaign/progress ──────────────────────────────────
  // Avancement détaillé de la campagne (courante ou dernière clôturée) : TC
  // (réussi/échoué/non testé), workflows validés (dernier run), modifications
  // en attente. Alimente la page /campaigns/:projectId (widget PO + détail).
  @Get(':id/campaign/progress')
  @ApiOperation({ summary: "Avancement de la campagne de tests d'un projet (TC + workflows + modifications en attente)" })
  async getCampaignProgress(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    const data = await this.projectService.getCampaignProgress(id, { userId: user.sub, isAdmin: user.role === 'ADMIN' });
    return { success: true, data };
  }

  // ── GET /projects/:id/campaign/history ────────────────────────────────────
  // Historique des campagnes CLÔTURÉES du projet (voir CampaignRun) —
  // alimente l'onglet "Historique" de /campaigns/:projectId.
  @Get(':id/campaign/history')
  @ApiOperation({ summary: "Historique des campagnes de tests clôturées d'un projet" })
  async getCampaignHistory(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    const data = await this.projectService.getCampaignHistory(id, { userId: user.sub, isAdmin: user.role === 'ADMIN' });
    return { success: true, data };
  }

  // ── POST /projects/:id/campaign/close ───────────────────────────────────
  // Clôture la campagne : redonne la main sur le projet (création/édition/
  // suppression à nouveau possibles) et referme le démarrage d'exécutions.
  // `resolutions` : { [changeId]: 'keep' | 'discard' } — DOIT couvrir CHAQUE
  // modification encore en attente (voir GET .../pending-changes), sinon la
  // clôture est refusée (400) pour ne jamais perdre silencieusement une
  // modification en standby.
  @Post(':id/campaign/close')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.PO)
  @ApiOperation({ summary: 'Clôturer la campagne de tests — dégèle le projet, résout les modifications en attente (PO uniquement)' })
  @ApiBody({
    required: false,
    schema: {
      type: 'object',
      properties: {
        resolutions: {
          type: 'object',
          description: "Clé = id de la modification en attente (CampaignChange.id), valeur = 'keep' ou 'discard'",
          additionalProperties: { type: 'string', enum: ['keep', 'discard'] },
        },
      },
    },
  })
  async closeCampaign(
    @Param('id') id: string,
    @Body() body: { resolutions?: Record<string, 'keep' | 'discard'> },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    try {
      const { project, applied, discarded, failed } = await this.projectService.closeCampaign(
        id,
        { id: user.sub, name: user.name || user.email },
        { userId: user.sub, isAdmin: user.role === 'ADMIN' },
        body?.resolutions ?? {},
      );
      this.broadcast(id, 'campaign:closed', user, {
        campaign_status: project.campaign_status,
        appliedCount: applied.length,
        discardedCount: discarded.length,
        failedCount: failed.length,
      });
      return { success: true, data: project, applied, discarded, failed };
    } catch (err: any) {
      if (err?.status === 403) throw err;
      throw new BadRequestException(err.message);
    }
  }

  // ── POST /projects/:id/pin — épingler pour l'utilisateur courant (tous rôles) ──
  @Post(':id/pin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Épingler un projet pour l'utilisateur connecté" })
  async pinProject(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    try {
      const pinnedProjectIds = await this.projectService.pinProject(user.sub, id);
      return { success: true, pinnedProjectIds };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  // ── DELETE /projects/:id/pin — désépingler pour l'utilisateur courant (tous rôles) ──
  @Delete(':id/pin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Désépingler un projet pour l'utilisateur connecté" })
  async unpinProject(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    try {
      const pinnedProjectIds = await this.projectService.unpinProject(user.sub, id);
      return { success: true, pinnedProjectIds };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  // ── GET /projects ──────────────────────────────────────────────────────────
  // Un Admin voit tous les projets ; QA/BA ne voient que les leurs.
  @Get()
  listProjects(@CurrentUser() user: AuthenticatedUser) {
    return this.projectService.listProjects({ userId: user.sub, isAdmin: user.role === 'ADMIN' });
  }

  // ── GET /projects/:id ──────────────────────────────────────────────────────
  @Get(':id')
  async getProject(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    try {
      return await this.projectService.getProject(id, {
        userId: user.sub,
        isAdmin: user.role === 'ADMIN',
      });
    }
    catch (err: any) {
      if (err?.status === 403) throw err;
      throw new NotFoundException(`Project ${id} not found`);
    }
  }

  // ── GET /projects/:id/activity ───────────────────────────────────────────
  // Fil d'activité du projet — "Aujourd'hui sur ce projet" : historique
  // scrollable de TOUTES les actions de l'équipe (pas seulement les siennes,
  // contrairement à la cloche de notifications qui est individuelle). Même
  // contrôle d'accès que GET /projects/:id (403 si ni membre ni admin).
  @Get(':id/activity')
  async getProjectActivity(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    try {
      await this.projectService.getProject(id, {
        userId: user.sub,
        isAdmin: user.role === 'ADMIN',
      });
    } catch (err: any) {
      if (err?.status === 403) throw err;
      throw new NotFoundException(`Project ${id} not found`);
    }
    const data = await this.notificationsService.listProjectActivity(id, {
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
    });
    return { success: true, data };
  }

  // ── GET /projects/versions/:entityType/:entityId ───────────────────────────
  // Historique des versions d'un module, d'une exigence ou d'un cas de test —
  // ouvert à tous les rôles authentifiés (BA/QA/Admin), en lecture seule.
  // entityType ∈ { requirement_module, requirement, test_case } — le workflow
  // a son propre endpoint dans WorkflowController (porté par WorkflowService).
  @Get('versions/:entityType/:entityId')
  @ApiOperation({ summary: 'Historique des versions d\'un module, d\'une exigence ou d\'un cas de test' })
  async listEntityVersions(@Param('entityType') entityType: string, @Param('entityId') entityId: string) {
    if (!isVersionedEntityType(entityType) || entityType === 'test_workflow') {
      throw new BadRequestException(`Type d'entité versionnée inconnu : ${entityType}`);
    }
    const data = await this.versionsService.listVersions(entityType, entityId);
    return { success: true, data };
  }

  // ── POST /projects/versions/:entityType/:entityId/restore/:versionId ─────
  // Restaure (rollback) une ancienne version — l'état courant est d'abord
  // archivé comme nouvelle entrée d'historique (change_type='restore'), rien
  // n'est jamais perdu. Réservé au BA pour module/exigence, au QA pour un cas
  // de test — mêmes droits que l'édition normale de chaque entité.
  @Post('versions/:entityType/:entityId/restore/:versionId')
  @Roles(Role.BA, Role.PO, Role.QA, Role.ADMIN)
  @ApiOperation({ summary: 'Restaurer une ancienne version d\'un module, d\'une exigence ou d\'un cas de test' })
  async restoreEntityVersion(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Param('versionId') versionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!isVersionedEntityType(entityType) || entityType === 'test_workflow') {
      throw new BadRequestException(`Type d'entité versionnée inconnu : ${entityType}`);
    }
    if (entityType === 'requirement_module' && user.role !== Role.BA && user.role !== Role.PO && user.role !== Role.ADMIN) {
      throw new ForbiddenException('Seul un BA ou un PO peut restaurer un module');
    }
    if (entityType === 'requirement' && user.role !== Role.BA && user.role !== Role.PO && user.role !== Role.ADMIN) {
      throw new ForbiddenException('Seul un BA ou un PO peut restaurer une exigence');
    }
    if (entityType === 'test_case' && user.role !== Role.QA && user.role !== Role.ADMIN) {
      throw new ForbiddenException('Seul un QA peut restaurer un cas de test');
    }

    try {
      const data = await this.projectService.restoreEntityVersion(
        entityType as 'requirement_module' | 'requirement' | 'test_case',
        entityId, versionId, { id: user.sub, name: user.name || user.email },
      );
      if (isCampaignPending(data)) return { success: true, ...data };

      const projectId = entityType === 'requirement_module' ? await this.projectService.getProjectIdForModule(entityId)
        : entityType === 'requirement' ? await this.projectService.getProjectIdForRequirement(entityId)
        : await this.projectService.getProjectIdForTestCase(entityId);
      const event: ProjectRealtimeEvent = entityType === 'requirement_module' ? 'module:updated'
        : entityType === 'requirement' ? 'requirement:updated' : 'testcase:updated';
      const payloadKey = entityType === 'requirement_module' ? 'module' : entityType === 'requirement' ? 'requirement' : 'testCase';
      this.broadcast(projectId, event, user, { [payloadKey]: data, action: 'restored' });

      return { success: true, data };
    } catch (err: any) { throw new BadRequestException(err.message); }
  }

  // ── POST /projects/test-cases/verify-memory ─────────────────────────────
  // Vérifier les modifications manuelles d'un TC en mémoire (sans UUID)
  @Post('test-cases/verify-memory')
  @Roles(Role.QA)
  @HttpCode(HttpStatus.OK)
  async verifyMemoryTestCase(
    @Body() body: { testCase: any; changedFields: string[]; model?: string; reqDescription: string; },
  ) {
    if (!body.testCase)               throw new BadRequestException('testCase is required');
    if (!body.reqDescription?.trim()) throw new BadRequestException('reqDescription is required');
    try {
      const result = await this.projectService.verifyTestCase(
        body.testCase, body.changedFields || [],
        body.model || this.defaultModel, this.ollamaUrl, body.reqDescription,
      );
      return { success: true, test_case: result };
    } catch (err: any) { throw new BadRequestException(err.message); }
  }

  // ── POST /projects/test-cases/:id/verify ─────────────────────────────────
  // Vérifier les modifications manuelles d'un TC en DB (avec UUID).
  // Le résultat du LLM est ensuite persisté (editTestCase) — sinon la
  // modification ne vivait que dans le state React et disparaissait au reload.
  @Post('test-cases/:id/verify')
  @Roles(Role.QA)
  @HttpCode(HttpStatus.OK)
  async verifyPersistedTestCase(
    @Param('id') id: string,
    @Body() body: { testCase: any; changedFields: string[]; model?: string; reqDescription: string; },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!body.testCase)               throw new BadRequestException('testCase is required');
    if (!body.reqDescription?.trim()) throw new BadRequestException('reqDescription is required');
    try {
      const result = await this.projectService.verifyTestCase(
        body.testCase, body.changedFields || [],
        body.model || this.defaultModel, this.ollamaUrl, body.reqDescription,
      );
      const persisted = await this.projectService.editTestCase(id, {
        title: result.title,
        steps: result.steps,
        preconditions: result.preconditions,
        test_data: result.testData,
        expected_result: result.expectedResult,
        type: result.type,
        priority: result.priority,
      } as any, { id: user.sub, name: user.name || user.email });
      if (isCampaignPending(persisted)) return { success: true, ...persisted };
      this.broadcast(await this.projectService.getProjectIdForTestCase(id), 'testcase:updated', user, { testCase: persisted });
      return { success: true, test_case: { ...result, id: persisted.id } };
    } catch (err: any) { throw new BadRequestException(err.message); }
  }

  // ── POST /projects/test-cases/regenerate-memory ───────────────────────────
  // Régénérer un TC en mémoire (sans UUID DB) via Ollama.
  // Utilisé quand le TC n'a pas encore été validé/persisté.
  @Post('test-cases/regen-in-memory')
  @Roles(Role.QA)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Régénérer un TC en mémoire (sans UUID)',
    description: 'Pour les TC pas encore persistés en DB. Retourne le TC modifié sans le sauvegarder.',
  })
  async regenerateMemoryTestCase(
    @Body() body: {
      testCase: {
        testId: string; moduleId: string; requirementId: string;
        title: string; type: string; priority: string;
        preconditions: string[]; steps: string[];
        testData: string[]; expectedResult: string;
      };
      instruction: string;
      model?: string;
      projectId?: string;
      reqDescription: string;
      otherTestCases?: any[];
      acceptSimilar?: boolean;
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!body.testCase) throw new BadRequestException('testCase is required');
    if (!body.reqDescription?.trim()) throw new BadRequestException('reqDescription is required');
    if (!body.instruction?.trim()) throw new BadRequestException('instruction is required');

    this.logger.log(`🔄 Regenerate memory TC: ${body.testCase.testId}`);
    try {
      const result = await this.projectService.regenerateMemoryTestCase(
        body.testCase,
        body.instruction,
        body.model || 'mistral:7b',
        this.ollamaUrl,
        body.reqDescription,
        body.otherTestCases || [],
        body.projectId || 'default',
        body.acceptSimilar || false,  // ← NOUVEAU: pass to service
      );
      // Contrairement à /test-cases/:id/regenerate (TC déjà en DB), ce TC
      // n'a pas d'UUID — testId/requirementId/moduleId sont déjà les
      // libellés métier (voir _runGeneratePipelineFast), pas de lookup Prisma
      // nécessaire pour enrichir le message.
      if (body.projectId) {
        this.broadcast(body.projectId, 'testcase:updated', user, {
          testCase: { title: body.testCase.title },
          action: 'regenerated_pending',
          testId: body.testCase.testId,
          reqId: body.testCase.requirementId,
          moduleName: body.testCase.moduleId,
        });
      }
      return { success: true, test_case: result };
    } catch (err: any) { throw new BadRequestException(err.message); }
  }

  // ── POST /projects/:projectId/modules ─────────────────────────────────────
  @Post(':projectId/modules')
  @Roles(Role.BA, Role.PO)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Créer un nouveau module dans un projet — BA uniquement' })
  async createModule(
    @Param('projectId') projectId: string,
    @Body() body: { name: string; description?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!body.name?.trim()) throw new BadRequestException('name is required');
    try {
      const data = await this.projectService.createModule(projectId, body, { id: user.sub, name: user.name || user.email });
      if (isCampaignPending(data)) return { success: true, ...data };
      this.broadcast(projectId, 'module:created', user, { module: data });
      return { success: true, data };
    }
    catch (err: any) { throw new BadRequestException(err.message); }
  }

  // ── PATCH /projects/modules/:id ───────────────────────────────────────────
  @Patch('modules/:id')
  @Roles(Role.BA, Role.PO)
  @ApiOperation({ summary: 'Modifier nom/description d\'un module — BA uniquement' })
  async editModule(@Param('id') id: string, @Body() dto: { name?: string; description?: string }, @CurrentUser() user: AuthenticatedUser) {
    try {
      const data = await this.projectService.editModule(id, dto, { id: user.sub, name: user.name || user.email });
      if (isCampaignPending(data)) return { success: true, ...data };
      this.broadcast(await this.projectService.getProjectIdForModule(id), 'module:updated', user, { module: data });
      return { success: true, data };
    }
    catch (err: any) { throw new NotFoundException(`Module ${id} not found`); }
  }

  // ── DELETE /projects/modules/:id ──────────────────────────────────────────
  @Delete('modules/:id')
  @Roles(Role.BA, Role.PO)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Supprimer un module et tous ses requirements/TC — BA uniquement' })
  async deleteModule(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    const projectId = await this.projectService.getProjectIdForModule(id);
    try {
      const result = await this.projectService.deleteModule(id, { id: user.sub, name: user.name || user.email });
      if (isCampaignPending(result)) return { success: true, ...result };
      this.broadcast(projectId, 'module:deleted', user, { moduleId: id });
      return { success: true, id };
    }
    catch (err: any) { throw new NotFoundException(`Module ${id} not found`); }
  }

  // ── GET /projects/:projectId/export/pdf ────────────────────────────────────
  // Export complet du projet : tous les modules, leurs exigences et cas de test.
  @Get(':projectId/export/pdf')
  @ApiOperation({ summary: "Exporter tout le projet (modules + exigences + cas de test) en PDF" })
  async exportProjectPdf(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ) {
    const project = await this.projectService.getProject(projectId, {
      userId: user.sub, isAdmin: user.role === 'ADMIN',
    });
    const modules = (project as any).modules ?? [];

    const buffer = await this.exportService.buildProjectPdf(project.name, modules);
    const filename = `${slugifyFilename(project.name)}-export-complet.pdf`;
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }

  // ── GET /projects/:projectId/export/excel ──────────────────────────────────
  @Get(':projectId/export/excel')
  @ApiOperation({ summary: "Exporter tout le projet (modules + exigences + cas de test) en Excel" })
  async exportProjectExcel(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ) {
    const project = await this.projectService.getProject(projectId, {
      userId: user.sub, isAdmin: user.role === 'ADMIN',
    });
    const modules = (project as any).modules ?? [];

    const buffer = await this.exportService.buildProjectExcel(project.name, modules);
    const filename = `${slugifyFilename(project.name)}-export-complet.xlsx`;
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }

  // ── GET /projects/:projectId/modules/:moduleId/export/pdf ─────────────────
  // Pas de restriction @Roles : lecture seule, mêmes droits que GET /projects/:id
  @Get(':projectId/modules/:moduleId/export/pdf')
  @ApiOperation({ summary: "Exporter les exigences et cas de test d'un module en PDF" })
  async exportModulePdf(
    @Param('projectId') projectId: string,
    @Param('moduleId') moduleId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ) {
    const project = await this.projectService.getProject(projectId, {
      userId: user.sub, isAdmin: user.role === 'ADMIN',
    });
    const mod = (project as any).modules?.find((m: any) => m.id === moduleId);
    if (!mod) throw new NotFoundException(`Module ${moduleId} not found`);

    const buffer = await this.exportService.buildModulePdf(project.name, mod);
    const filename = `${slugifyFilename(mod.name)}-${slugifyFilename(project.name)}.pdf`;
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }

  // ── GET /projects/:projectId/modules/:moduleId/export/excel ───────────────
  @Get(':projectId/modules/:moduleId/export/excel')
  @ApiOperation({ summary: "Exporter les exigences et cas de test d'un module en Excel" })
  async exportModuleExcel(
    @Param('projectId') projectId: string,
    @Param('moduleId') moduleId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ) {
    const project = await this.projectService.getProject(projectId, {
      userId: user.sub, isAdmin: user.role === 'ADMIN',
    });
    const mod = (project as any).modules?.find((m: any) => m.id === moduleId);
    if (!mod) throw new NotFoundException(`Module ${moduleId} not found`);

    const buffer = await this.exportService.buildModuleExcel(project.name, mod);
    const filename = `${slugifyFilename(mod.name)}-${slugifyFilename(project.name)}.xlsx`;
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }

  // ── POST /projects/modules/:moduleId/requirements ─────────────────────────
  @Post('modules/:moduleId/requirements')
  @Roles(Role.BA, Role.PO)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Ajouter une exigence à un module — BA uniquement' })
  async createRequirement(
    @Param('moduleId') moduleId: string,
    @Body() body: { req_id: string; description: string; priority: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!body.req_id?.trim())       throw new BadRequestException('req_id is required');
    if (!body.description?.trim())  throw new BadRequestException('description is required');
    if (!body.priority?.trim())     throw new BadRequestException('priority is required');
    try {
      const data = await this.projectService.createRequirement(moduleId, body, { id: user.sub, name: user.name || user.email });
      if (isCampaignPending(data)) return { success: true, ...data };
      this.broadcast(await this.projectService.getProjectIdForModule(moduleId), 'requirement:created', user, { requirement: data });
      return { success: true, data };
    }
    catch (err: any) { throw new BadRequestException(err.message); }
  }

  // ── DELETE /projects/requirements/:id ─────────────────────────────────────
  @Delete('requirements/:id')
  @Roles(Role.BA, Role.PO)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Supprimer une exigence et tous ses TC — BA uniquement' })
  async deleteRequirement(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    const projectId = await this.projectService.getProjectIdForRequirement(id);
    try {
      const result = await this.projectService.deleteRequirement(id, { id: user.sub, name: user.name || user.email });
      if (isCampaignPending(result)) return { success: true, ...result };
      this.broadcast(projectId, 'requirement:deleted', user, { requirementId: id });
      return { success: true, id };
    }
    catch (err: any) { throw new NotFoundException(`Requirement ${id} not found`); }
  }

  // ── PATCH /projects/requirements/:id ──────────────────────────────────────
  @Patch('requirements/:id')
  @Roles(Role.BA, Role.PO)
  async editRequirement(@Param('id') id: string, @Body() dto: any, @CurrentUser() user: AuthenticatedUser) {
    // `expectedUpdatedAt` est un champ de contrôle (verrou optimiste, voir
    // ProjectService.editRequirement) — jamais une donnée à persister sur le
    // requirement, on le sort de `fields` avant de le transmettre au service
    // pour ne pas polluer le payload Prisma.
    const { expectedUpdatedAt, ...fields } = dto || {};
    const actorName = user.name || user.email;

    // ── Verrou dur anti-édition concurrente ──────────────────────────────────
    // Un BA ne doit pas pouvoir sauvegarder une exigence tant qu'un AUTRE
    // utilisateur est en train de la modifier (champ ouvert via
    // requirement-editing-presence ci-dessous). `tryLockAction` avec le même
    // actorId renouvelle simplement son propre verrou sans bloquer — normal :
    // c'est la suite logique de la session d'édition qu'il a déjà ouverte.
    const lockedBy = this.realtimeGateway.tryLockAction(this.requirementEditLockKey(id), user.sub, actorName, this.REQUIREMENT_EDIT_LOCK_TTL_MS);
    if (lockedBy) {
      throw new ConflictException({ message: `${lockedBy.actorName} modifie déjà cette exigence.`, locked: true, actorName: lockedBy.actorName });
    }

    try {
      const data = await this.projectService.editRequirement(id, fields, expectedUpdatedAt, { id: user.sub, name: user.name || user.email });
      if (isCampaignPending(data)) return { success: true, ...data };
      this.broadcast(await this.projectService.getProjectIdForRequirement(id), 'requirement:updated', user, { requirement: data });
      return { success: true, data };
    }
    catch (err: any) {
      if (err instanceof RequirementConflictError) {
        // 409 explicite avec la version actuelle en base — le frontend s'en
        // sert pour actualiser le champ affiché au lieu d'écraser à l'aveugle.
        throw new ConflictException({ message: err.message, conflict: true, current: err.current });
      }
      // `findUniqueOrThrow` lève une PrismaClientKnownRequestError P2025
      // quand le requirement n'existe vraiment pas — dans ce cas seulement,
      // 404 générique. Toute autre erreur (bug ailleurs dans editRequirement,
      // ex: impact analysis, embeddings...) était avant AVALÉE et déguisée en
      // "Requirement not found", ce qui rendait le vrai problème indiagnosticable
      // côté logs/front. On la journalise et on la propage désormais telle quelle.
      if (err?.code === 'P2025') {
        throw new NotFoundException(`Requirement ${id} not found`);
      }
      this.logger.error(`[editRequirement] ${id}: ${err?.message}`, err?.stack);
      throw new BadRequestException(err?.message || `Failed to edit requirement ${id}`);
    }
  }

  // ── POST /projects/requirements/:id/editing-presence ──────────────────────
  // Verrou dur (pas seulement un avertissement visuel) : un utilisateur ne
  // peut ouvrir un champ d'édition (id/description) sur cette exigence que si
  // personne d'autre n'a déjà la main dessus. `active: true` tente de poser
  // le verrou et refuse (409) s'il est déjà détenu par quelqu'un d'autre ;
  // `active: false` le libère (uniquement s'il est encore détenu par ce même
  // utilisateur — no-op sinon, ex: verrou déjà expiré ou repris par un autre).
  // Diffuse aussi 'requirement:editing' pour le badge affiché aux autres
  // utilisateurs (voir ModuleReqEditor.tsx).
  @Post('requirements/:id/editing-presence')
  @HttpCode(HttpStatus.OK)
  async requirementEditingPresence(
    @Param('id') id: string,
    @Body() body: { active: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const actorName = user.name || user.email;
    const lockKey = this.requirementEditLockKey(id);
    const active = !!body?.active;

    if (active) {
      const lockedBy = this.realtimeGateway.tryLockAction(lockKey, user.sub, actorName, this.REQUIREMENT_EDIT_LOCK_TTL_MS);
      if (lockedBy) {
        // Refusé : on NE diffuse PAS de présence, sinon le badge "X modifie"
        // apparaîtrait alors que ce champ ne s'est en réalité pas ouvert.
        throw new ConflictException({ message: `${lockedBy.actorName} modifie déjà cette exigence.`, locked: true, actorName: lockedBy.actorName });
      }
    } else {
      this.realtimeGateway.unlockAction(lockKey, user.sub);
    }

    const projectId = await this.projectService.getProjectIdForRequirement(id).catch(() => null);
    if (projectId) {
      this.realtimeGateway.emitToProject(projectId, 'requirement:editing', {
        projectId, requirementId: id, actorId: user.sub, actorName, active, at: new Date().toISOString(),
      });
    }
    return { success: true };
  }

  // ── POST /projects/requirements/:id/viewing-presence ──────────────────────
  // Présence "légère" (sans verrou, plusieurs viewers simultanés possibles) —
  // contrairement à /editing-presence ci-dessus qui pose un vrai verrou
  // d'édition. `active: true` signale qu'on a ouvert/sélectionné la ligne
  // (ex: dépliage de l'exigence dans analyzer/page.tsx) ; `active: false`
  // signale qu'on l'a refermée. Diffuse 'requirement:viewing' pour le badge
  // "👀 Nom" affiché aux autres utilisateurs (voir ModuleReqEditor.tsx /
  // analyzer/page.tsx). Ouvert à tous les rôles (BA/QA/Admin), rien à
  // vérifier côté droits — c'est de la présence purement informative.
  @Post('requirements/:id/viewing-presence')
  @HttpCode(HttpStatus.OK)
  async requirementViewingPresence(
    @Param('id') id: string,
    @Body() body: { active: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const projectId = await this.projectService.getProjectIdForRequirement(id).catch(() => null);
    if (projectId) {
      this.realtimeGateway.emitToProject(projectId, 'requirement:viewing', {
        projectId, requirementId: id, actorId: user.sub, actorName: user.name || user.email,
        active: !!body?.active, at: new Date().toISOString(),
      });
    }
    return { success: true };
  }

  // ── POST /projects/test-cases/:id/viewing-presence ─────────────────────────
  // Même mécanique que requirementViewingPresence ci-dessus, pour le badge
  // "👀 Nom" affiché sur une ligne de cas de test (voir TCCard, déclenché à
  // l'ouverture du détail du TC).
  @Post('test-cases/:id/viewing-presence')
  @HttpCode(HttpStatus.OK)
  async testCaseViewingPresence(
    @Param('id') id: string,
    @Body() body: { active: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const projectId = await this.projectService.getProjectIdForTestCase(id).catch(() => null);
    if (projectId) {
      this.realtimeGateway.emitToProject(projectId, 'testcase:viewing', {
        projectId, testCaseId: id, actorId: user.sub, actorName: user.name || user.email,
        active: !!body?.active, at: new Date().toISOString(),
      });
    }
    return { success: true };
  }

  // ── POST /projects/test-cases/:id/editing-presence ─────────────────────────
  // Présence "légère" (sans verrou, comme viewing-presence) — signale qu'on a
  // des modifications LOCALES en attente sur ce cas de test (voir TCCard,
  // `hasEdits`). Contrairement à requirementEditingPresence ci-dessus, pas de
  // verrou dur : l'édition d'un TC se fait en ligne (pas de champ exclusif à
  // poser), le vrai filet de sécurité contre l'écrasement reste la sauvegarde
  // elle-même (PATCH test-cases/:id). `testId`/`requirementId` sont fournis
  // par le client (déjà connus côté TCCard) et simplement relayés dans
  // l'événement diffusé, pour éviter un aller-retour DB supplémentaire ici.
  // Alimente activeTcEdits côté analyzer/page.tsx, fusionné dans la bannière
  // "Activité de l'équipe en cours" avec génération/édition d'exigence/ajout.
  @Post('test-cases/:id/editing-presence')
  @HttpCode(HttpStatus.OK)
  async testCaseEditingPresence(
    @Param('id') id: string,
    @Body() body: { active: boolean; testId?: string; requirementId?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const projectId = await this.projectService.getProjectIdForTestCase(id).catch(() => null);
    if (projectId) {
      this.realtimeGateway.emitToProject(projectId, 'testcase:editing', {
        projectId, testCaseId: id, requirementId: body?.requirementId, testId: body?.testId,
        actorId: user.sub, actorName: user.name || user.email,
        active: !!body?.active, at: new Date().toISOString(),
      });
    }
    return { success: true };
  }

  // ── POST /projects/requirements/:id/adding-presence ────────────────────────
  // Présence "légère" (sans verrou, comme viewing-presence ci-dessus) —
  // signale qu'on a le formulaire "+ Nouveau TC" ouvert pour cette exigence
  // (voir NewTCForm dans page.tsx). Alimente la bannière "Activité de
  // l'équipe en cours" (fusionnée avec les générations/éditions actives),
  // pour que "ajout" soit visible en direct comme "génération"/"modification".
  @Post('requirements/:id/adding-presence')
  @HttpCode(HttpStatus.OK)
  async requirementAddingPresence(
    @Param('id') id: string,
    @Body() body: { active: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const projectId = await this.projectService.getProjectIdForRequirement(id).catch(() => null);
    if (projectId) {
      this.realtimeGateway.emitToProject(projectId, 'requirement:adding', {
        projectId, requirementId: id, actorId: user.sub, actorName: user.name || user.email,
        active: !!body?.active, at: new Date().toISOString(),
      });
    }
    return { success: true };
  }

  // ── PATCH /projects/requirements/:id/acknowledge-review ──────────────────
  // Lève manuellement le flag "à réviser" d'une exigence couplée — réservé au BA
  // (le QA lève le flag des TC individuellement via reviewTestCase/editTestCase).
  @Patch('requirements/:id/acknowledge-review')
  @Roles(Role.BA, Role.PO)
  async acknowledgeRequirementReview(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    try {
      const data = await this.projectService.acknowledgeRequirementReview(id, { id: user.sub, name: user.name || user.email });
      if (isCampaignPending(data)) return { success: true, ...data };
      this.broadcast(await this.projectService.getProjectIdForRequirement(id), 'requirement:updated', user, { requirement: data });
      return { success: true, data };
    }
    catch { throw new NotFoundException(`Requirement ${id} not found`); }
  }

  // ── PATCH /projects/requirements/:id/revert-edit ──────────────────────────
  // Annule la dernière édition (retour à l'ancienne description + levée des
  // flags "à réviser" posés par cette édition) — bouton "Revenir à l'ancienne
  // version" du modal/bandeau d'impact, alternative à "Garder & réviser".
  @Patch('requirements/:id/revert-edit')
  @Roles(Role.BA, Role.PO)
  async revertRequirementEdit(@Param('id') id: string, @Body() dto: { description: string; impactedRequirementIds?: string[] }, @CurrentUser() user: AuthenticatedUser) {
    if (!dto?.description) throw new BadRequestException('description is required');
    try {
      const data = await this.projectService.revertRequirementEdit(id, dto.description, dto.impactedRequirementIds ?? [], { id: user.sub, name: user.name || user.email });
      if (isCampaignPending(data)) return { success: true, ...data };
      this.broadcast(await this.projectService.getProjectIdForRequirement(id), 'requirement:updated', user, { requirement: data });
      return { success: true, data };
    } catch { throw new NotFoundException(`Requirement ${id} not found`); }
  }

  // ── PATCH /projects/test-cases/:id ────────────────────────────────────────
  @Patch('test-cases/:id')
  @Roles(Role.QA)
  async editTestCase(@Param('id') id: string, @Body() dto: any, @CurrentUser() user: AuthenticatedUser) {
    try {
      const data = await this.projectService.editTestCase(id, dto, { id: user.sub, name: user.name || user.email });
      if (isCampaignPending(data)) return { success: true, ...data };
      this.broadcast(await this.projectService.getProjectIdForTestCase(id), 'testcase:updated', user, { testCase: data });
      return { success: true, data };
    }
    catch { throw new NotFoundException(`TestCase ${id} not found`); }
  }

  // ── PATCH /projects/test-cases/:id/review ─────────────────────────────────
  // Workflow QA persistant : valider / rejeter / remettre en attente un TC.
  // Contrairement à DELETE, 'rejected' conserve le TC en base (audit/historique).
  @Patch('test-cases/:id/review')
  @Roles(Role.QA)
  @ApiOperation({ summary: 'Valider, rejeter ou remettre en attente un test case — QA uniquement' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['status'],
      properties: { status: { type: 'string', enum: ['validated', 'rejected', 'pending'] } },
    },
  })
  async reviewTestCase(@Param('id') id: string, @Body() body: { status: 'validated' | 'rejected' | 'pending' }, @CurrentUser() user: AuthenticatedUser) {
    if (!['validated', 'rejected', 'pending'].includes(body.status)) {
      throw new BadRequestException("status must be 'validated', 'rejected' or 'pending'");
    }
    try {
      const data = await this.projectService.reviewTestCase(id, body.status, { id: user.sub, name: user.name || user.email });
      if (isCampaignPending(data)) return { success: true, ...data };
      this.broadcast(await this.projectService.getProjectIdForTestCase(id), 'testcase:updated', user, { testCase: data, action: 'reviewed', reviewStatus: body.status });
      return { success: true, data };
    }
    catch { throw new NotFoundException(`TestCase ${id} not found`); }
  }

  // ── PATCH /projects/test-cases/:id/execution ───────────────────────────────
  // Saisie du résultat d'exécution QA pendant une campagne (bouton
  // Réussi/Échoué/Non testé sur la carte du TC) — distinct de /review qui
  // valide/rejette le CONTENU du TC. Réservé au QA, uniquement pendant une
  // campagne active (voir ProjectService.recordTestCaseExecution).
  @Patch('test-cases/:id/execution')
  @Roles(Role.QA)
  @ApiOperation({ summary: "Enregistrer le résultat d'exécution d'un test case pendant la campagne (réussi/échoué/non testé) — QA uniquement" })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['status'],
      properties: { status: { type: 'string', enum: ['passed', 'failed', 'not_tested'] } },
    },
  })
  async recordTestCaseExecution(
    @Param('id') id: string,
    @Body() body: { status: 'passed' | 'failed' | 'not_tested' },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!['passed', 'failed', 'not_tested'].includes(body.status)) {
      throw new BadRequestException("status must be 'passed', 'failed' or 'not_tested'");
    }
    try {
      const data = await this.projectService.recordTestCaseExecution(id, body.status, { id: user.sub, name: user.name || user.email });
      this.broadcast(await this.projectService.getProjectIdForTestCase(id), 'testcase:updated', user, { testCase: data, action: 'executed', executionStatus: body.status });
      return { success: true, data };
    } catch (err: any) {
      if (err?.status === 403) throw err;
      throw new BadRequestException(err.message);
    }
  }

  // ── PATCH /projects/test-cases/:id/acknowledge-review ─────────────────────
  // Lève manuellement le flag "à réviser" d'un TC — réservé au QA, symétrique
  // de requirements/:id/acknowledge-review côté BA. Ne change pas review_status.
  @Patch('test-cases/:id/acknowledge-review')
  @Roles(Role.QA)
  async acknowledgeTestCaseReview(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    try {
      const data = await this.projectService.acknowledgeTestCaseReview(id, { id: user.sub, name: user.name || user.email });
      if (isCampaignPending(data)) return { success: true, ...data };
      this.broadcast(await this.projectService.getProjectIdForTestCase(id), 'testcase:updated', user, { testCase: data });
      return { success: true, data };
    }
    catch { throw new NotFoundException(`TestCase ${id} not found`); }
  }

  // ── DELETE /projects/test-cases/:id ───────────────────────────────────────
  @Delete('test-cases/:id')
  @Roles(Role.QA)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Supprimer définitivement un test case — QA uniquement' })
  async deleteTestCase(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    const projectId = await this.projectService.getProjectIdForTestCase(id);
    // Capturé AVANT suppression : describeTestCase()/le titre ne seraient
    // plus résolvables une fois la ligne effacée en base (voir buildActivityLog).
    const tcInfo = await this.prisma.testCase.findUnique({
      where: { id },
      select: { title: true, test_id: true, requirement: { select: { req_id: true, module: { select: { name: true } } } } },
    }).catch(() => null);
    try {
      const result = await this.projectService.deleteTestCase(id, { id: user.sub, name: user.name || user.email });
      if (isCampaignPending(result)) return { success: true, ...result };
      this.broadcast(projectId, 'testcase:deleted', user, {
        testCaseId: id,
        title: tcInfo?.title,
        testId: tcInfo?.test_id,
        reqId: tcInfo?.requirement?.req_id,
        moduleName: tcInfo?.requirement?.module?.name,
      });
      return { success: true, id };
    }
    catch (err: any) { throw new NotFoundException(err.message); }
  }

  // ── DELETE /projects/requirements/:id/test-cases ───────────────────────────
  @Delete('requirements/:id/test-cases')
  @Roles(Role.QA)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Supprimer tous les test cases d\'un requirement — QA uniquement' })
  async deleteAllTestCasesForRequirement(@Param('id') requirementId: string, @CurrentUser() user: AuthenticatedUser) {
    const projectId = await this.projectService.getProjectIdForRequirement(requirementId);
    // Capturé AVANT suppression, même raison que deleteTestCase ci-dessus.
    const reqInfo = await this.prisma.requirement.findUnique({
      where: { id: requirementId },
      select: { req_id: true, module: { select: { name: true } } },
    }).catch(() => null);
    try {
      const result = await this.projectService.deleteAllTestCasesForRequirement(requirementId, { id: user.sub, name: user.name || user.email });
      if (isCampaignPending(result)) return { success: true, ...result };
      this.broadcast(projectId, 'testcase:deleted', user, {
        requirementId, count: result.count,
        reqId: reqInfo?.req_id, moduleName: reqInfo?.module?.name,
      });
      return { success: true, count: result.count, message: `${result.count} test case(s) supprimé(s)` };
    }
    catch (err: any) { throw new BadRequestException(err.message); }
  }

  // ── POST /projects/requirements/:id/test-cases ────────────────────────────
  // Créer + valider un TC en DB (validate-to-persist)
  @Post('requirements/:id/test-cases')
  @Roles(Role.QA)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Créer + valider un test case (validate-to-persist) — QA uniquement' })
  async createAndValidateTestCase(
    @Param('id') requirementUuid: string,
    @Body() body: {
      testId: string; title: string; preconditions: string[];
      steps: string[]; testData?: string[]; expectedResult: string;
      type: string; priority: string; validated?: boolean; needsReview?: boolean;
      manuallyEdited?: boolean;
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!body.testId?.trim())         throw new BadRequestException('testId is required');
    if (!body.title?.trim())          throw new BadRequestException('title is required');
    if (!body.expectedResult?.trim()) throw new BadRequestException('expectedResult is required');
    try {
      const tc = await this.projectService.createAndValidateTestCase(requirementUuid, {
        testId: body.testId, title: body.title,
        preconditions: body.preconditions ?? [], steps: body.steps ?? [],
        testData: body.testData ?? [], expectedResult: body.expectedResult,
        type: body.type, priority: body.priority,
        validated: typeof body.validated === 'boolean' ? body.validated : undefined,
        needsReview: typeof body.needsReview === 'boolean' ? body.needsReview : undefined,
        manuallyEdited: typeof body.manuallyEdited === 'boolean' ? body.manuallyEdited : undefined,
      }, { id: user.sub, name: user.name || user.email });
      if (isCampaignPending(tc)) return { success: true, ...tc };
      this.broadcast(await this.projectService.getProjectIdForRequirement(requirementUuid), 'testcase:created', user, { testCase: tc, requirementId: requirementUuid, manuallyEdited: !!body.manuallyEdited });
      return { success: true, data: tc };
    } catch (err: any) { throw new BadRequestException(err.message); }
  }

  // ── POST /projects/requirements/:id/test-cases/reject-pending ─────────────
  // Rejet d'un TC EN ATTENTE, jamais persisté en DB (pattern
  // "validate-to-persist" : tant qu'on n'a pas cliqué Valider, le TC n'existe
  // qu'en mémoire côté front). Rien à supprimer en base — cet endpoint ne
  // fait donc QUE journaliser l'action dans le fil d'activité, contrairement
  // à DELETE test-cases/:id qui gère un TC réellement persisté.
  @Post('requirements/:id/test-cases/reject-pending')
  @Roles(Role.QA)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Journaliser le rejet d\'un TC en attente (non persisté) — QA uniquement' })
  async rejectPendingTestCase(
    @Param('id') requirementUuid: string,
    @Body() body: { testId?: string; title?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const projectId = await this.projectService.getProjectIdForRequirement(requirementUuid);
    // Pas de TC en DB à interroger (jamais persisté) — on récupère juste
    // req_id/module depuis l'exigence, comme pour regenerated_pending.
    const reqInfo = await this.prisma.requirement.findUnique({
      where: { id: requirementUuid },
      select: { req_id: true, module: { select: { name: true } } },
    }).catch(() => null);
    // Retrait synchrone de Requirement.pending_test_cases — voir le
    // commentaire sur ProjectService.removePendingTestCase : sans ça, un
    // refresh concurrent (déclenché par l'événement 'activity:new' émis
    // juste en dessous) pouvait recharger un pending_test_cases encore
    // périmé et faire réapparaître le TC qu'on vient de rejeter.
    if (body.testId) {
      await this.projectService.removePendingTestCase(requirementUuid, body.testId).catch(() => { /* best-effort — ne doit pas faire échouer le rejet */ });
    }
    if (projectId) {
      await this.prisma.project.update({
        where: { id: projectId },
        data: { rejected_pending_dates: { push: new Date() } },
      }).catch((err: any) => {
        // Ce catch avalait toute erreur en silence, donc
        // si le champ rejected_pending_dates n'existait pas encore côté DB
        // (pas de dossier prisma/migrations dans ce projet → schéma poussé
        // via `npx prisma db push`, à relancer après tout ajout de champ),
        // le compteur restait figé pour toujours sans qu'aucune erreur ne
        // remonte nulle part. On logue désormais l'échec pour le détecter.
        this.logger.warn(`Enregistrement rejected_pending_dates échoué (projet ${projectId}) : ${err?.message}`);
      });
    }
    this.broadcast(projectId, 'testcase:rejected', user, {
      requirementId: requirementUuid,
      testId: body.testId,
      title: body.title,
      reqId: reqInfo?.req_id,
      moduleName: reqInfo?.module?.name,
    });
    return { success: true };
  }

  // ── PATCH /projects/requirements/:id/pending-test-cases ───────────────────
  // Autosave invisible des TC générés pas encore validés (voir Requirement.
  // pending_test_cases). N'affiche rien de nouveau côté UI : sert uniquement
  // à ce qu'un reload restaure exactement l'état "en mémoire" d'avant reload.
  @Patch('requirements/:id/pending-test-cases')
  @Roles(Role.QA)
  async savePendingTestCases(@Param('id') requirementId: string, @Body() body: { testCases?: any[] }, @CurrentUser() user: AuthenticatedUser) {
    try {
      await this.projectService.savePendingTestCases(requirementId, body.testCases ?? []);
      // Diffusion temps réel : ces TC "en attente" vivent dans Requirement.
      // pending_test_cases, un champ partagé en base (visible par tous au
      // reload — voir refreshCurrentProject côté front) — ils méritent donc
      // la même notification live que les TC déjà persistés, sinon les autres
      // utilisateurs ne voient les brouillons en cours qu'après un F5 manuel.
      this.broadcast(await this.projectService.getProjectIdForRequirement(requirementId), 'testcase:updated', user, { requirementId, testIds: (body.testCases ?? []).map((t: any) => t.testId).filter(Boolean) }, { skipNotification: true });
      return { success: true };
    } catch (err: any) { throw new BadRequestException(err.message); }
  }


  // ── GET /projects/requirements/:id/saturation ────────────────────────────
  // Retourne le statut de saturation sémantique d'un requirement.
  // Utilisé par le frontend pour afficher la bannière d'avertissement.
  // Réponse : { isSaturated, tcCount, rejectionRate, avgScore, reason, threshold }
  @Get('requirements/:id/saturation')
  @ApiOperation({
    summary: 'Statut de saturation sémantique d\'un requirement',
    description: 'Indique si l\'espace sémantique est saturé — plus aucun TC distinct ne peut être généré.',
  })
  @ApiParam({ name: 'id', description: 'UUID du requirement' })
  async getRequirementSaturation(@Param('id') requirementUuid: string) {
    try {
      const status = await this.projectService.getRequirementSaturationStatus(requirementUuid);
      return { success: true, ...status };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  // ── POST /projects/requirements/:id/generate-single ──────────────────────
  @Post('requirements/:id/generate-single')
  @Roles(Role.QA)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Générer un seul TC pour un requirement (sans instruction) — QA uniquement',
    description:
      'Utilise Phase A→B + self-critique + dédup sémantique via generationHistoryEntries.',
  })
  @ApiParam({ name: 'id', description: 'UUID du requirement' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        model:         { type: 'string', example: 'qwen2.5:7b' },
        acceptSimilar: { type: 'boolean', example: false },
      },
    },
  })
  async generateSingleTestCase(
    @Param('id') requirementUuid: string,
    @Body() body: { model?: string; acceptSimilar?: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    this.logger.log(`🆕 [generateSingleTestCase] req=${requirementUuid}`);
    const projectId = await this.projectService.getProjectIdForRequirement(requirementUuid);

    const lockedBy = this.realtimeGateway.tryLockGeneration(requirementUuid, user.sub, user.name || user.email);
    if (lockedBy) {
      throw new ConflictException(`${lockedBy.actorName} est déjà en train de générer un cas de test pour cette exigence — réessayez dans un instant.`);
    }

    this.broadcast(projectId, 'generation:started', user, { requirementId: requirementUuid, mode: 'single' });
    if (projectId) this.realtimeGateway.setActivity(projectId, user.sub, 'generating', 'un cas de test');
    try {
      const tc = await this.projectService.generateSingleTestCase(
        requirementUuid,
        body.model        || this.defaultModel,
        this.ollamaUrl,
        body.acceptSimilar ?? false,
      );
      this.broadcast(projectId, 'testcase:created', user, { testCase: tc, requirementId: requirementUuid }, { skipNotification: true });
      this.broadcast(projectId, 'generation:completed', user, { requirementId: requirementUuid, mode: 'single', testCase: tc });
      return { success: true, test_case: tc };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    } finally {
      if (projectId) this.realtimeGateway.setActivity(projectId, user.sub, 'idle');
      this.realtimeGateway.unlockGeneration(requirementUuid, user.sub);
    }
  }
 
  // ── POST /projects/requirements/:id/generate-single-with-instruction ─────
  // Génère UN seul TC pour un requirement avec instruction obligatoire
  @Post('requirements/:id/generate-single-with-instruction')
  @Roles(Role.QA)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Générer un seul TC pour un requirement avec instruction',
    description:
      'Injection de l\'instruction comme premier angle Phase A. Dédup sémantique complète.',
  })
  @ApiParam({ name: 'id', description: 'UUID du requirement' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['instruction'],
      properties: {
        instruction:   { type: 'string', example: 'Tester le cas de verrouillage de compte' },
        model:         { type: 'string', example: 'qwen2.5:7b' },
        acceptSimilar: { type: 'boolean', example: false },
      },
    },
  })
  async generateSingleTestCaseWithInstruction(
    @Param('id') requirementUuid: string,
    @Body() body: { instruction: string; model?: string; acceptSimilar?: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!body.instruction?.trim())
      throw new BadRequestException('instruction is required');
 
    this.logger.log(
      `🆕 [generateSingleWithInstruction] req=${requirementUuid} ` +
      `| "${body.instruction.slice(0, 60)}"`,
    );
    const projectId = await this.projectService.getProjectIdForRequirement(requirementUuid);

    const lockedBy = this.realtimeGateway.tryLockGeneration(requirementUuid, user.sub, user.name || user.email);
    if (lockedBy) {
      throw new ConflictException(`${lockedBy.actorName} est déjà en train de générer un cas de test pour cette exigence — réessayez dans un instant.`);
    }

    this.broadcast(projectId, 'generation:started', user, { requirementId: requirementUuid, mode: 'single-with-instruction' });
    if (projectId) this.realtimeGateway.setActivity(projectId, user.sub, 'generating', 'un cas de test');
    try {
      const tc = await this.projectService.generateSingleTestCaseWithInstruction(
        requirementUuid,
        body.instruction,
        body.model        || this.defaultModel,
        this.ollamaUrl,
        body.acceptSimilar ?? false,
      );
      this.broadcast(projectId, 'testcase:created', user, { testCase: tc, requirementId: requirementUuid }, { skipNotification: true });
      this.broadcast(projectId, 'generation:completed', user, { requirementId: requirementUuid, mode: 'single-with-instruction', testCase: tc });
      return { success: true, test_case: tc };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    } finally {
      if (projectId) this.realtimeGateway.setActivity(projectId, user.sub, 'idle');
      this.realtimeGateway.unlockGeneration(requirementUuid, user.sub);
    }
  }
  /*// ── POST /projects/:id/chat/init ───────────────────────────────────────────
  @Post(':id/chat/init')
  @HttpCode(HttpStatus.OK)
  async initChat(@Param('id') projectId: string, @Body() body: { sessionId: string; model?: string }) {
    if (!body.sessionId) throw new BadRequestException('sessionId is required');
    await this.projectService.initChatSession(body.sessionId, projectId, this.ollamaUrl, body.model || this.defaultModel);
    return { success: true, sessionId: body.sessionId };
  }

  // ── POST /projects/:id/chat/message ───────────────────────────────────────
  @Post(':id/chat/message')
  @HttpCode(HttpStatus.OK)
  async chatMessage(@Param('id') projectId: string, @Body() body: { sessionId: string; message: string; model?: string }) {
    if (!body.sessionId)       throw new BadRequestException('sessionId is required');
    if (!body.message?.trim()) throw new BadRequestException('message is required');
    return this.projectService.chat(body.sessionId, body.message, projectId, this.ollamaUrl, body.model || this.defaultModel);
  }

  // ── DELETE /projects/:id/chat/:sessionId ──────────────────────────────────
  @Delete(':id/chat/:sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async clearChat(@Param('sessionId') sessionId: string) {
    await this.projectService.clearChat(sessionId);
  }
*/
  // ── PATCH /projects/:id/assignees ─────────────────────────────────────────
  // Remplace la liste des utilisateurs assignés (collaborateurs) d'un projet.
  // Réservé au propriétaire du projet ou à un Admin.
  @Patch(':id/assignees')
  @Roles(Role.ADMIN, Role.BA, Role.PO)
  @ApiOperation({ summary: 'Assigner des utilisateurs à un projet (remplace la liste) — Admin/BA (+ vérif. propriétaire) uniquement' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['userIds'],
      properties: { userIds: { type: 'array', items: { type: 'string' } } },
    },
  })
  async setAssignees(
    @Param('id') id: string,
    @Body() body: { userIds: string[] },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!Array.isArray(body.userIds)) throw new BadRequestException('userIds must be an array');
    try {
      const project = await this.projectService.setAssignedUsers(id, body.userIds, {
        userId: user.sub,
        isAdmin: user.role === 'ADMIN',
      });
      return { success: true, data: project };
    } catch (err: any) {
      if (err?.status === 403) throw err;
      throw new BadRequestException(err.message);
    }
  }

  // ── DELETE /projects/:id ──────────────────────────────────────────────────
  @Delete(':id')
  @Roles(Role.ADMIN, Role.BA, Role.PO)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Supprimer un projet — Admin/BA (+ vérif. propriétaire) uniquement' })
  async deleteProject(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    // Capturé AVANT suppression : une fois le projet supprimé, sa ligne (et
    // donc owner_id/assignedUserIds) n'est plus lisible pour journaliser
    // l'action auprès des membres — voir notifyProjectActivity.
    const memberIdsBeforeDelete = await this.notificationsService.getProjectMemberIds(id);
    try {
      await this.projectService.deleteProject(id, {
        userId: user.sub,
        isAdmin: user.role === 'ADMIN',
      });
      this.broadcast(id, 'project:deleted', user, {});
      this.notificationsService
        .notifyMany(memberIdsBeforeDelete, {
          type: 'project_activity',
          message: `${user.name || user.email} a supprimé le projet.`,
          actorId: user.sub,
        })
        .catch((err: any) => this.logger.warn(`Journalisation de suppression échouée (projet ${id}): ${err.message}`));
      return { success: true, message: 'Projet supprimé', id };
    }
    catch (err: any) {
      if (err?.status === 403) throw err;
      throw new NotFoundException(`Project ${id} not found`);
    }
  }

  // ── POST /projects/requirements/:id/regenerate ────────────────────────────
  // ── POST /projects/test-cases/:id/regenerate ──────────────────────────────
  @Post('test-cases/:id/regenerate')
  @Roles(Role.QA)
  @HttpCode(HttpStatus.OK)
  async regenerateSingleTestCase(
    @Param('id') id: string,
    @Body() body: { 
      instruction: string; 
      model?: string; 
      reqDescription: string; 
      memoryTestCases?: any[];
      acceptSimilar?: boolean;
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!body.instruction?.trim()) throw new BadRequestException('instruction is required');
    this.logger.log(`🔄 Regenerate TC ${id}: "${body.instruction.slice(0, 60)}"`);
    try {
      const testCase = await this.projectService.regenerateSingleTestCase(
        id, body.model || 'mistral:7b', this.ollamaUrl, body.instruction, body.memoryTestCases || [], body.acceptSimilar || false,
      );
      this.broadcast(await this.projectService.getProjectIdForTestCase(id), 'testcase:updated', user, { testCase, action: 'regenerated' });
      return { success: true, test_case: testCase };
    } catch (err: any) { throw new BadRequestException(err.message); }
  }

  // ── POST /projects/test-cases/:id/validate ────────────────────────────────
}