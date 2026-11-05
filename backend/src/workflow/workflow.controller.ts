import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { WorkflowService } from './workflow.service';
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { UpdateWorkflowDto } from './dto/update-workflow.dto';
import { SetWorkflowAccessDto } from './dto/set-workflow-access.dto';
import { SetWorkflowQaAccessDto } from './dto/set-workflow-qa-access.dto';
import { UpdateStepResultDto } from './dto/update-step-result.dto';
import { GenerateTestDataDto } from './dto/generate-test-data.dto';
import { SuggestNextTestCasesDto } from './dto/suggest-next-test-cases.dto';

@ApiTags('workflows')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('projects/:projectId/workflows')
export class WorkflowController {
  constructor(
    private readonly workflowService: WorkflowService,
    private readonly notificationsService: NotificationsService,
    private readonly gateway: NotificationsGateway,
  ) {}

  // Verrou dur anti-édition concurrente d'un workflow — même mécanique que
  // REQUIREMENT_EDIT_LOCK_TTL_MS (project.controller.ts) : une session
  // d'édition abandonnée (onglet fermé sans cleanup) se libère au bout de
  // 5 min pour ne pas bloquer les autres indéfiniment.
  private readonly WORKFLOW_EDIT_LOCK_TTL_MS = 5 * 60 * 1000;
  private workflowEditLockKey(workflowId: string): string {
    return `workflow-edit:${workflowId}`;
  }

  private access(user: AuthenticatedUser) {
    return { userId: user.sub, isAdmin: user.role === 'ADMIN', role: user.role, actorName: user.name || user.email };
  }

  /** Journalise une entrée dans le fil d'activité du projet — best-effort, jamais bloquant. */
  private async logActivity(
    projectId: string,
    user: AuthenticatedUser,
    message: string,
    event: 'workflow:created' | 'workflow:updated' | 'workflow:deleted' | 'workflow:run-updated',
    payload: Record<string, unknown> = {},
    // false pour les actions qui envoient déjà une notification individuelle
    // plus précise ailleurs (ex: validation → notifyProjectMembersByRole
    // ciblée QA) — évite que le membre reçoive deux notifications pour la
    // même action. Le fil d'activité partagé, lui, est toujours journalisé.
    notifyMembers: boolean = true,
  ) {
    try {
      this.gateway.emitToProject(projectId, event, { actorId: user.sub, actorName: user.name || user.email, ...payload });
    } catch { /* diffusion temps réel best-effort */ }
    try {
      await this.notificationsService.notifyProjectActivity({
        projectId,
        actorId: user.sub,
        actorName: user.name || user.email,
        type: 'workflow_activity',
        message,
        notifyMembers,
        // Ouvre directement le workflow concerné (onglet Workflow + workflow
        // pré-sélectionné) plutôt que la page projet générique.
        link: payload.workflowId ? `/analyzer?projectId=${projectId}&view=workflow&workflowId=${payload.workflowId}` : undefined,
      });
    } catch { /* journalisation best-effort — ne bloque jamais la requête */ }
  }

  // ── CRUD workflows ──────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'Lister les workflows de test d’un projet' })
  async list(@Param('projectId') projectId: string, @CurrentUser() user: AuthenticatedUser) {
    const data = await this.workflowService.list(projectId, this.access(user));
    return { success: true, data };
  }

  @Post()
  @Roles(Role.BA, Role.PO)
  @ApiOperation({ summary: 'Créer un nouveau workflow de test (canvas vide par défaut) — BA uniquement' })
  async create(
    @Param('projectId') projectId: string,
    @Body() dto: CreateWorkflowDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const data = await this.workflowService.create(projectId, dto, this.access(user));
    await this.logActivity(projectId, user, `${user.name || user.email} a créé le workflow de test « ${data.name} ».`, 'workflow:created', { workflowId: data.id });
    return { success: true, data };
  }

  @Post('suggest-next-test-cases')
  @Roles(Role.BA, Role.PO)
  @ApiOperation({ summary: 'Suggestion par IA des cas de test qui pourraient logiquement suivre un cas de test donné (panneau "Ajouter une étape") — BA uniquement' })
  async suggestNextTestCases(
    @Param('projectId') projectId: string,
    @Body() dto: SuggestNextTestCasesDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const data = await this.workflowService.suggestNextTestCases(projectId, dto, this.access(user));
    return { success: true, data };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Récupérer un workflow (nœuds, arêtes, variables)' })
  async getOne(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const data = await this.workflowService.getOne(projectId, id, this.access(user));
    return { success: true, data };
  }

  // ── POST /:id/editing-presence ───────────────────────────────────────────
  // Verrou dur (pas seulement un avertissement visuel), même mécanique que
  // requirementEditingPresence (project.controller.ts) : un BA ne peut ouvrir
  // ce workflow en édition (canvas) que si aucun AUTRE BA n'a déjà la main
  // dessus. `active: true` tente de poser le verrou et refuse (409) s'il est
  // déjà détenu par quelqu'un d'autre ; `active: false` le libère (no-op si
  // détenu par un autre — verrou déjà expiré ou repris). Diffuse aussi
  // 'workflow:editing' pour le badge (point vert + activité) affiché aux
  // autres utilisateurs.
  @Post(':id/editing-presence')
  @Roles(Role.BA, Role.PO)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Signaler/vérifier qu'on édite ce workflow (pose un verrou dur) — BA uniquement" })
  async editingPresence(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() body: { active: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const actorName = user.name || user.email;
    const lockKey = this.workflowEditLockKey(id);
    const active = !!body?.active;

    if (active) {
      const lockedBy = this.gateway.tryLockAction(lockKey, user.sub, actorName, this.WORKFLOW_EDIT_LOCK_TTL_MS);
      if (lockedBy) {
        // Refusé : on NE diffuse PAS de présence, sinon le badge "X modifie"
        // apparaîtrait alors que l'édition ne s'est en réalité pas ouverte.
        throw new ConflictException({ message: `${lockedBy.actorName} modifie déjà ce workflow.`, locked: true, actorName: lockedBy.actorName });
      }
    } else {
      this.gateway.unlockAction(lockKey, user.sub);
    }

    this.gateway.emitToProject(projectId, 'workflow:editing', {
      projectId, workflowId: id, actorId: user.sub, actorName, active, at: new Date().toISOString(),
    });
    return { success: true };
  }

  // ── POST /:id/viewing-presence ───────────────────────────────────────────
  // Présence "légère" (sans verrou, plusieurs viewers simultanés possibles) —
  // contrairement à /editing-presence ci-dessus. `active: true` signale
  // qu'on a ouvert ce workflow en lecture (canvas affiché) ; `active: false`
  // signale qu'on l'a refermé. Diffuse 'workflow:viewing' pour le point vert
  // affiché sur l'avatar aux autres utilisateurs. Ouvert à tous les rôles
  // (BA/QA/ADMIN) — présence purement informative, rien à vérifier côté droits.
  @Post(':id/viewing-presence')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Signaler qu'on consulte ce workflow (présence légère, sans verrou)" })
  async viewingPresence(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() body: { active: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    this.gateway.emitToProject(projectId, 'workflow:viewing', {
      projectId, workflowId: id, actorId: user.sub, actorName: user.name || user.email,
      active: !!body?.active, at: new Date().toISOString(),
    });
    return { success: true };
  }

  // ── POST /:id/canvas-live ────────────────────────────────────────────────
  // Diffusion éphémère (aucune écriture en base, aucun appel à
  // WorkflowService) du graphe en cours d'édition, pour que les autres
  // utilisateurs qui consultent ce workflow voient les nœuds bouger en
  // direct — sans attendre l'autosave débouncé (600ms) ni le refetch complet
  // qui suit normalement 'workflow:updated'. C'est un simple relais temps
  // réel : la sauvegarde réelle continue de passer par PATCH /:id comme
  // avant, cet endpoint ne fait qu'accélérer le retour visuel. Ouvert à tout
  // BA du projet (pas de vérif de verrou ici : au pire quelqu'un sans les
  // droits d'édition déclenche un affichage visuel chez les autres sans
  // jamais pouvoir persister quoi que ce soit, puisque PATCH /:id reste,
  // lui, protégé par le verrou et hasWorkflowAccess).
  @Post(':id/canvas-live')
  @Roles(Role.BA, Role.PO)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Diffuser en direct l'état du canvas en cours d'édition (éphémère, sans sauvegarde) — BA uniquement" })
  async canvasLive(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() body: { nodes?: unknown[]; edges?: unknown[] },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    this.gateway.emitToProject(projectId, 'workflow:canvas-live', {
      projectId, workflowId: id, actorId: user.sub, actorName: user.name || user.email,
      nodes: body?.nodes ?? [], edges: body?.edges ?? [], at: new Date().toISOString(),
    });
    return { success: true };
  }

  @Patch(':id')
  @Roles(Role.BA, Role.PO)
  @ApiOperation({ summary: 'Mettre à jour un workflow (renommer, ou autosave du canvas complet) — BA uniquement' })
  async update(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: UpdateWorkflowDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const actorName = user.name || user.email;
    // ── Verrou dur anti-édition concurrente ──────────────────────────────────
    // Un BA ne doit pas pouvoir sauvegarder un workflow tant qu'un AUTRE BA
    // est en train de le modifier (verrou ouvert via editing-presence
    // ci-dessous, à l'ouverture du canvas). Avec le même actorId,
    // tryLockAction renouvelle simplement son propre verrou sans bloquer —
    // c'est la suite logique de la session d'édition déjà ouverte (chaque
    // autosave prolonge donc le verrou tant que l'onglet reste ouvert).
    const lockedBy = this.gateway.tryLockAction(this.workflowEditLockKey(id), user.sub, actorName, this.WORKFLOW_EDIT_LOCK_TTL_MS);
    if (lockedBy) {
      throw new ConflictException({ message: `${lockedBy.actorName} modifie déjà ce workflow.`, locked: true, actorName: lockedBy.actorName });
    }
    const data = await this.workflowService.update(projectId, id, dto, this.access(user));
    // Diffusion temps réel légère (autre onglet ouvert sur le même workflow) —
    // volontairement PAS de logActivity ici : l'autosave du canvas se déclenche
    // à chaque modification (glisser un nœud, éditer un champ...), le journal
    // d'activité persistant ne doit garder que les événements significatifs
    // (création/suppression/exécution), même logique que l'autosave des
    // pending_test_cases côté Requirement qui ne notifie jamais non plus.
    try {
      this.gateway.emitToProject(projectId, 'workflow:updated', { workflowId: id, actorId: user.sub, actorName });
      // Badge de présence "X édite ce workflow" pour les autres utilisateurs
      // connectés au projet — voir aussi POST /:id/editing-presence, qui émet
      // le même événement à l'ouverture explicite du canvas. Ce PATCH étant
      // désormais le point où le verrou dur est réellement posé/renouvelé
      // (voir tryLockAction ci-dessus, plus posé à l'ouverture), c'est aussi
      // ici qu'on informe les autres qu'une édition est réellement en cours —
      // sans quoi le badge n'apparaît plus jamais depuis que le verrou n'est
      // plus posé à l'ouverture du canvas.
      this.gateway.emitToProject(projectId, 'workflow:editing', {
        projectId, workflowId: id, actorId: user.sub, actorName, active: true, at: new Date().toISOString(),
      });
    } catch { /* best-effort */ }
    return { success: true, data };
  }

  // ── GET /projects/:projectId/workflows/:id/versions ────────────────────
  // Historique des versions (checkpoints) d'un workflow — voir
  // WorkflowService.WORKFLOW_VERSION_THROTTLE_MS pour la fréquence des snapshots.
  @Get(':id/versions')
  @ApiOperation({ summary: 'Historique des versions d\'un workflow' })
  async listVersions(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const data = await this.workflowService.listVersions(projectId, id, this.access(user));
    return { success: true, data };
  }

  // ── POST /projects/:projectId/workflows/:id/versions/:versionId/restore ──
  @Post(':id/versions/:versionId/restore')
  @Roles(Role.BA, Role.PO)
  @ApiOperation({ summary: 'Restaurer une ancienne version du workflow (nom, description, graphe, variables) — BA uniquement' })
  async restoreVersion(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const data = await this.workflowService.restoreVersion(projectId, id, versionId, this.access(user));
    try {
      this.gateway.emitToProject(projectId, 'workflow:updated', { workflowId: id, actorId: user.sub, actorName: user.name || user.email });
    } catch { /* best-effort */ }
    await this.logActivity(projectId, user, `${user.name || user.email} a restauré une ancienne version du workflow « ${data.name} ».`, 'workflow:updated', { workflowId: id });
    return { success: true, data };
  }

  // ── PATCH /:id/access ────────────────────────────────────────────────────
  // Remplace la liste des BA autorisés à voir/modifier/valider ce workflow
  // tant qu'il n'est pas encore validé (en plus du créateur, qui a toujours
  // accès). Réservé au créateur du workflow ou à un Admin (vérifié côté
  // service).
  @Patch(':id/access')
  @Roles(Role.BA, Role.PO, Role.ADMIN)
  @ApiOperation({ summary: "Choisir les BA ayant accès à un workflow (remplace la liste) — créateur du workflow ou Admin uniquement" })
  async setAccess(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: SetWorkflowAccessDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const data = await this.workflowService.setAssignedUsers(projectId, id, dto.userIds, this.access(user));
    try {
      this.gateway.emitToProject(projectId, 'workflow:updated', { workflowId: id, actorId: user.sub, actorName: user.name || user.email });
    } catch { /* best-effort */ }
    return { success: true, data };
  }

  // ── PATCH /:id/qa-access ─────────────────────────────────────────────────
  // Remplace la liste des QA autorisés à exécuter ce workflow (liste vide =
  // fermé à tous les QA). Réservé au créateur du workflow ou à un Admin
  // (vérifié côté service).
  @Patch(':id/qa-access')
  @Roles(Role.BA, Role.PO, Role.ADMIN)
  @ApiOperation({ summary: "Choisir les QA autorisés à exécuter un workflow (remplace la liste) — créateur du workflow ou Admin uniquement" })
  async setQaAccess(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: SetWorkflowQaAccessDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const data = await this.workflowService.setAssignedQaUsers(projectId, id, dto.userIds, this.access(user));
    try {
      this.gateway.emitToProject(projectId, 'workflow:updated', { workflowId: id, actorId: user.sub, actorName: user.name || user.email });
    } catch { /* best-effort */ }
    return { success: true, data };
  }

  @Post(':id/generate-test-data')
  @Roles(Role.BA, Role.PO)
  @ApiOperation({ summary: 'Générer par LLM des valeurs de données de test cohérentes pour toutes les variables du workflow — BA uniquement' })
  async generateTestData(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: GenerateTestDataDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const data = await this.workflowService.generateTestData(projectId, id, dto, this.access(user));
    return { success: true, data };
  }

  @Delete(':id')
  @Roles(Role.BA, Role.PO)
  @ApiOperation({ summary: 'Supprimer un workflow de test — BA uniquement' })
  async remove(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const workflow = await this.workflowService.getOne(projectId, id, this.access(user));
    const data = await this.workflowService.remove(projectId, id, this.access(user));
    await this.logActivity(projectId, user, `${user.name || user.email} a supprimé le workflow de test « ${workflow.name} ».`, 'workflow:deleted', { workflowId: id });
    return { success: true, ...data };
  }

  @Post(':id/validate')
  @Roles(Role.BA, Role.PO)
  @ApiOperation({ summary: 'Valider (publier) un workflow — le rend visible aux autres utilisateurs du projet (BA uniquement)' })
  async validate(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const data = await this.workflowService.validate(projectId, id, this.access(user));
    // notifyMembers=false : la notification individuelle ciblée QA est déjà
    // envoyée dans WorkflowService.validate() — on ne journalise ici QUE le
    // fil d'activité partagé, sans doublonner la cloche de chacun.
    await this.logActivity(projectId, user, `${user.name || user.email} a validé le workflow de test « ${data.name} ».`, 'workflow:updated', { workflowId: id }, false);
    try {
      this.gateway.emitToProject(projectId, 'workflow:updated', { workflowId: id, actorId: user.sub, actorName: user.name || user.email });
    } catch { /* best-effort */ }
    return { success: true, data };
  }

  @Post(':id/unvalidate')
  @Roles(Role.BA, Role.PO)
  @ApiOperation({ summary: 'Repasser un workflow validé en brouillon (BA uniquement)' })
  async unvalidate(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const data = await this.workflowService.unvalidate(projectId, id, this.access(user));
    try {
      this.gateway.emitToProject(projectId, 'workflow:updated', { workflowId: id, actorId: user.sub, actorName: user.name || user.email });
    } catch { /* best-effort */ }
    return { success: true, data };
  }

  // ── Exécution (runs) ────────────────────────────────────────────────────

  @Post(':id/runs')
  @Roles(Role.QA)
  @ApiOperation({ summary: 'Démarrer une nouvelle exécution du workflow — QA uniquement' })
  async startRun(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const data = await this.workflowService.startRun(projectId, id, this.access(user));
    try {
      this.gateway.emitToProject(projectId, 'workflow:run-updated', { workflowId: id, runId: data.id, status: data.status, actorId: user.sub, actorName: user.name || user.email });
    } catch { /* best-effort */ }
    return { success: true, data };
  }

  @Get(':id/runs')
  @ApiOperation({ summary: 'Historique des exécutions d’un workflow' })
  async listRuns(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const data = await this.workflowService.listRuns(projectId, id, this.access(user));
    return { success: true, data };
  }

  @Get(':id/runs/:runId')
  @ApiOperation({ summary: 'Détail d’une exécution (résultats par étape, variables collectées)' })
  async getRun(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Param('runId') runId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const data = await this.workflowService.getRun(projectId, id, runId, this.access(user));
    return { success: true, data };
  }

  @Patch(':id/runs/:runId/steps/:nodeId')
  @Roles(Role.QA)
  @ApiOperation({ summary: 'Enregistrer le résultat d’une étape pendant une exécution en cours — QA uniquement' })
  async updateStepResult(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Param('runId') runId: string,
    @Param('nodeId') nodeId: string,
    @Body() dto: UpdateStepResultDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const data = await this.workflowService.updateStepResult(projectId, id, runId, nodeId, dto, this.access(user));
    try {
      this.gateway.emitToProject(projectId, 'workflow:run-updated', { workflowId: id, runId, nodeId, status: dto.status, actorId: user.sub, actorName: user.name || user.email });
    } catch { /* best-effort */ }
    return { success: true, data };
  }

  @Post(':id/runs/:runId/finish')
  @Roles(Role.QA)
  @ApiOperation({ summary: 'Clôturer une exécution — calcule le statut global à partir des étapes (QA uniquement)' })
  async finishRun(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Param('runId') runId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const data = await this.workflowService.finishRun(projectId, id, runId, this.access(user));
    const statusLabel: Record<string, string> = { passed: 'réussi ✅', failed: 'échoué ❌', partial: 'partiellement réussi ⚠️', aborted: 'abandonné', running: 'en cours' };
    await this.logActivity(
      projectId,
      user,
      `${user.name || user.email} a terminé une exécution du workflow — résultat : ${statusLabel[data.status] || data.status}.`,
      'workflow:run-updated',
      { workflowId: id, runId, status: data.status },
    );
    return { success: true, data };
  }

  @Post(':id/runs/:runId/abort')
  @Roles(Role.QA)
  @ApiOperation({ summary: 'Abandonner une exécution en cours — QA uniquement' })
  async abortRun(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Param('runId') runId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const data = await this.workflowService.abortRun(projectId, id, runId, this.access(user));
    // Diffusion temps réel manquante jusqu'ici : sans elle, un autre
    // utilisateur regardant ce run en direct (ou juste la galerie) ne
    // voyait l'abandon qu'après un rechargement manuel de la page.
    try {
      this.gateway.emitToProject(projectId, 'workflow:run-updated', { workflowId: id, runId, status: data.status, actorId: user.sub, actorName: user.name || user.email });
    } catch { /* best-effort */ }
    return { success: true, data };
  }

  @Delete(':id/runs/:runId')
  @Roles(Role.QA)
  @ApiOperation({ summary: 'Supprimer une exécution de l’historique — QA uniquement' })
  async removeRun(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Param('runId') runId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const data = await this.workflowService.removeRun(projectId, id, runId, this.access(user));
    // Même chose : sans diffusion, l'historique ouvert par un autre
    // utilisateur (ou le run qu'il est en train de regarder) restait
    // périmé tant qu'il ne rouvrait pas la modale.
    try {
      this.gateway.emitToProject(projectId, 'workflow:run-updated', { workflowId: id, runId, deleted: true, actorId: user.sub, actorName: user.name || user.email });
    } catch { /* best-effort */ }
    return { success: true, ...data };
  }
}