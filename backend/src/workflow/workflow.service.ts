import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectService } from '../project/project.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { UpdateWorkflowDto } from './dto/update-workflow.dto';
import { UpdateStepResultDto } from './dto/update-step-result.dto';
import { GenerateTestDataDto } from './dto/generate-test-data.dto';
import { SuggestNextTestCasesDto } from './dto/suggest-next-test-cases.dto';

import { callOllama, PHASE_B_OPTIONS } from '../shared/ollama-client';
import { safeParseJson } from '../shared/tc-utils';
import { computeRunStatus, WorkflowNode, WorkflowStepResult, WorkflowVariable } from '../shared/workflow-types';
import { VersionsService } from '../versions/versions.service';
import { VERSIONED_ENTITY, summarizeChanges } from '../shared/version-types';

interface AccessCheck {
  userId: string;
  isAdmin: boolean;
  role?: string;
  actorName?: string;
}

@Injectable()
export class WorkflowService {
  private readonly logger = new Logger(WorkflowService.name);
  private readonly ollamaUrl: string;
  private readonly model: string;

  // ── Throttle du snapshotting d'historique ───────────────────────────────
  // `update()` sert aussi à l'autosave du canvas (chaque déplacement de nœud,
  // chaque frappe dans un champ) — snapshotter à CHAQUE appel ferait exploser
  // la collection d'historique pour un intérêt quasi nul (des dizaines
  // d'entrées "identiques à 1 pixel près"). On n'archive donc une nouvelle
  // version que si la précédente date de plus de WORKFLOW_VERSION_THROTTLE_MS,
  // ce qui donne un historique de checkpoints espacés plutôt qu'un flux brut.
  private readonly WORKFLOW_VERSION_THROTTLE_MS = 2 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly projectService: ProjectService,
    private readonly config: ConfigService,
    private readonly notificationsService: NotificationsService,
    private readonly versionsService: VersionsService,
  ) {
    this.ollamaUrl = this.config.get('OLLAMA_BASE_URL', 'http://localhost:11434');
    this.model = this.config.get('OLLAMA_MODEL', 'qwen2.5-coder:7b');
  }

  /** Vérifie l'accès au projet (lève ForbiddenException sinon) — même garde que CommentsService. */
  private async assertProjectAccess(projectId: string, access: AccessCheck) {
    await this.projectService.getProject(projectId, access);
  }

  private async findOwnedWorkflow(workflowId: string, projectId: string) {
    const workflow = await this.prisma.testWorkflow.findUnique({ where: { id: workflowId } });
    if (!workflow || workflow.project_id !== projectId) {
      throw new NotFoundException('Workflow introuvable dans ce projet');
    }
    return workflow;
  }

  /**
   * Un workflow est visible (s'il est encore un brouillon) ET modifiable
   * par : un Admin, son créateur, ou un BA explicitement ajouté à sa liste
   * d'accès (assignedUserIds — voir setAssignedUsers ci-dessous). Une fois
   * validé, la visibilité en lecture s'ouvre à tout le projet (voir
   * list/getOne) ; cette fonction continue cependant de déterminer qui peut
   * le modifier/valider/dévalider/supprimer, quel que soit son statut.
   */
  private hasWorkflowAccess(workflow: { created_by_id: string | null; assignedUserIds?: string[] }, access: AccessCheck): boolean {
    if (access.isAdmin) return true;
    if (workflow.created_by_id === access.userId) return true;
    return (workflow.assignedUserIds ?? []).includes(access.userId);
  }

  /** Comme findOwnedWorkflow, mais lève ForbiddenException si l'utilisateur n'a pas accès (créateur/assigné/admin). */
  private async findAccessibleWorkflow(workflowId: string, projectId: string, access: AccessCheck) {
    const workflow = await this.findOwnedWorkflow(workflowId, projectId);
    if (!this.hasWorkflowAccess(workflow, access)) {
      throw new ForbiddenException("Vous n'avez pas accès à ce workflow — demandez au créateur de vous y ajouter");
    }
    return workflow;
  }

  /**
   * Un QA peut exécuter un workflow (démarrer/consulter/clore un run)
   * seulement s'il est explicitement listé dans assignedQaIds, ou s'il est
   * Admin. Liste vide = personne ne peut encore l'exécuter tant que le
   * créateur n'a pas explicitement autorisé au moins un QA (voir
   * setAssignedQaUsers ci-dessous) — accès fermé par défaut.
   */
  private hasQaAccess(workflow: { assignedQaIds?: string[] }, access: AccessCheck): boolean {
    if (access.isAdmin) return true;
    return (workflow.assignedQaIds ?? []).includes(access.userId);
  }

  /** Comme findOwnedWorkflow, mais lève ForbiddenException si le QA n'a pas accès à l'exécution de ce workflow. */
  private async findQaAccessibleWorkflow(workflowId: string, projectId: string, access: AccessCheck) {
    const workflow = await this.findOwnedWorkflow(workflowId, projectId);
    if (!this.hasQaAccess(workflow, access)) {
      throw new ForbiddenException("Vous n'avez pas accès à l'exécution de ce workflow — demandez au créateur de vous y ajouter");
    }
    return workflow;
  }

  // ── CRUD workflows ──────────────────────────────────────────────────────

  // Renvoie une version "allégée" de chaque workflow (sans `edges` ni
  // `variables`, non utilisés par la carte de la galerie — seuls `nodes` sert
  // à compter les étapes et détecter les alertes). Évite de télécharger le
  // graphe complet de TOUS les workflows du projet juste pour afficher la
  // liste ; `getOne` reste le seul endpoint à renvoyer le workflow complet,
  // au moment où on l'ouvre réellement (voir plus bas).
  async list(projectId: string, access: AccessCheck) {
    await this.assertProjectAccess(projectId, access);
    return this.prisma.testWorkflow.findMany({
      where: {
        project_id: projectId,
        // Un brouillon (is_validated=false) n'est visible que par son
        // créateur et les BA explicitement assignés (assignedUserIds) — les
        // autres utilisateurs (QA, ADMIN, autres BA non assignés) ne voient
        // un workflow qu'une fois qu'il a été validé, en lecture seule.
        OR: [{ is_validated: true }, { created_by_id: access.userId }, { assignedUserIds: { has: access.userId } }],
      },
      orderBy: { updated_at: 'desc' },
      select: {
        id: true, project_id: true, name: true, description: true,
        nodes: true, // utilisé par la carte (compteur d'étapes + alertes)
        is_validated: true, validated_at: true,
        created_by: { select: { id: true, name: true, email: true } },
        validated_by: { select: { id: true, name: true, email: true } },
        assignedUsers: { select: { id: true, name: true, email: true, role: true } },
        assignedQas: { select: { id: true, name: true, email: true, role: true } },
        last_run_status: true, last_run_at: true,
        created_at: true, updated_at: true,
      },
    });
  }

  async create(projectId: string, dto: CreateWorkflowDto, access: AccessCheck) {
    await this.assertProjectAccess(projectId, access);
    await this.projectService.assertProjectUnlocked(projectId);
    const assignedUserIds = Array.from(new Set(dto.assignedUserIds ?? [])).filter(uid => uid !== access.userId);
    const created = await this.prisma.testWorkflow.create({
      data: {
        project_id: projectId,
        name: dto.name.trim(),
        description: dto.description,
        nodes: (dto.nodes ?? []) as any,
        edges: (dto.edges ?? []) as any,
        variables: (dto.variables ?? []) as any,
        created_by_id: access.userId,
        assignedUserIds,
        version: 1,
      },
      include: {
        created_by: { select: { id: true, name: true, email: true } },
        assignedUsers: { select: { id: true, name: true, email: true, role: true } },
      },
    });
    await this.versionsService.recordVersionSafe({
      projectId,
      entityType: VERSIONED_ENTITY.WORKFLOW,
      entityId: created.id,
      versionNumber: 1,
      snapshot: { name: created.name, description: created.description, nodes: created.nodes, edges: created.edges, variables: created.variables },
      changeType: 'create',
      changeSummary: 'Création du workflow',
      changedById: access.userId,
      changedByName: access.actorName ?? null,
    });
    return created;
  }

  async getOne(projectId: string, workflowId: string, access: AccessCheck) {
    await this.assertProjectAccess(projectId, access);
    const workflow = await this.prisma.testWorkflow.findUnique({
      where: { id: workflowId },
      include: {
        created_by: { select: { id: true, name: true, email: true } },
        validated_by: { select: { id: true, name: true, email: true } },
        assignedUsers: { select: { id: true, name: true, email: true, role: true } },
        assignedQas: { select: { id: true, name: true, email: true, role: true } },
      },
    });
    if (!workflow || workflow.project_id !== projectId) {
      throw new NotFoundException('Workflow introuvable dans ce projet');
    }
    // Un brouillon non validé reste invisible à tout le monde sauf son
    // créateur et les BA explicitement assignés — une fois validé, il est
    // consultable en lecture seule par tout le projet (QA compris).
    if (!workflow.is_validated && !this.hasWorkflowAccess(workflow, access)) {
      throw new NotFoundException('Workflow introuvable dans ce projet');
    }
    return workflow;
  }

  /**
   * Remplace la liste des BA autorisés à voir/modifier/valider ce workflow
   * (en plus du créateur, qui a toujours accès). Réservé au créateur du
   * workflow ou à un Admin — un BA assigné ne peut pas lui-même modifier
   * cette liste. Notifie best-effort les BA nouvellement ajoutés.
   */
  async setAssignedUsers(projectId: string, workflowId: string, userIds: string[], access: AccessCheck) {
    await this.assertProjectAccess(projectId, access);
    await this.projectService.assertProjectUnlocked(projectId);
    const existing = await this.findOwnedWorkflow(workflowId, projectId);

    if (!access.isAdmin && existing.created_by_id !== access.userId) {
      throw new ForbiddenException("Seul le créateur du workflow ou un Admin peut gérer les BA autorisés");
    }

    const uniqueIds = Array.from(new Set(userIds)).filter(uid => uid !== existing.created_by_id);
    const newlyAddedIds = uniqueIds.filter(uid => !(existing.assignedUserIds ?? []).includes(uid));

    const updated = await this.prisma.testWorkflow.update({
      where: { id: workflowId },
      data: { assignedUserIds: { set: uniqueIds } },
      include: {
        created_by: { select: { id: true, name: true, email: true } },
        validated_by: { select: { id: true, name: true, email: true } },
        assignedUsers: { select: { id: true, name: true, email: true, role: true } },
      },
    });

    if (newlyAddedIds.length > 0) {
      this.notificationsService.notifyMany(newlyAddedIds, {
        type: 'workflow_activity',
        message: `${access.actorName || 'Un utilisateur'} vous a donné accès au workflow « ${updated.name} » — vous pouvez désormais le consulter, le modifier et le valider.`,
        actorId: access.userId,
        projectId,
        entityType: 'workflow',
        entityId: workflowId,
        link: `/analyzer?projectId=${projectId}&view=workflow&workflowId=${workflowId}`,
      }).catch(() => { /* best-effort */ });
    }

    return updated;
  }

  /**
   * Remplace la liste des QA autorisés à exécuter ce workflow (liste vide =
   * fermé à tous les QA tant qu'aucun n'a été explicitement ajouté).
   * Réservé au
   * créateur du workflow ou à un Admin. Notifie best-effort les QA
   * nouvellement ajoutés.
   */
  async setAssignedQaUsers(projectId: string, workflowId: string, userIds: string[], access: AccessCheck) {
    await this.assertProjectAccess(projectId, access);
    await this.projectService.assertProjectUnlocked(projectId);
    const existing = await this.findOwnedWorkflow(workflowId, projectId);

    if (!access.isAdmin && existing.created_by_id !== access.userId) {
      throw new ForbiddenException("Seul le créateur du workflow ou un Admin peut gérer les QA autorisés");
    }

    const uniqueIds = Array.from(new Set(userIds));
    const newlyAddedIds = uniqueIds.filter(uid => !(existing.assignedQaIds ?? []).includes(uid));

    const updated = await this.prisma.testWorkflow.update({
      where: { id: workflowId },
      data: { assignedQaIds: { set: uniqueIds } },
      include: {
        created_by: { select: { id: true, name: true, email: true } },
        validated_by: { select: { id: true, name: true, email: true } },
        assignedUsers: { select: { id: true, name: true, email: true, role: true } },
        assignedQas: { select: { id: true, name: true, email: true, role: true } },
      },
    });

    if (newlyAddedIds.length > 0) {
      this.notificationsService.notifyMany(newlyAddedIds, {
        type: 'workflow_activity',
        message: `${access.actorName || 'Un utilisateur'} vous a donné accès à l'exécution du workflow « ${updated.name} ».`,
        actorId: access.userId,
        projectId,
        entityType: 'workflow',
        entityId: workflowId,
        link: `/analyzer?projectId=${projectId}&view=workflow&workflowId=${workflowId}`,
      }).catch(() => { /* best-effort */ });
    }

    return updated;
  }

  async update(projectId: string, workflowId: string, dto: UpdateWorkflowDto, access: AccessCheck) {
    await this.assertProjectAccess(projectId, access);
    await this.projectService.assertProjectUnlocked(projectId);
    const existing = await this.findAccessibleWorkflow(workflowId, projectId, access);

    const data: Record<string, any> = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.nodes !== undefined) data.nodes = dto.nodes;
    if (dto.edges !== undefined) data.edges = dto.edges;
    if (dto.variables !== undefined) data.variables = dto.variables;

    // Voir WORKFLOW_VERSION_THROTTLE_MS ci-dessus : on ne snapshotte que si
    // assez de temps s'est écoulé depuis le dernier checkpoint (ou s'il n'y
    // en a jamais eu — ex: workflows créés avant l'introduction du versioning).
    const lastVersionAt = await this.versionsService.getLastVersionAt(VERSIONED_ENTITY.WORKFLOW, workflowId);
    const shouldSnapshot = !lastVersionAt || (Date.now() - lastVersionAt.getTime()) > this.WORKFLOW_VERSION_THROTTLE_MS;
    const currentVersion = existing.version ?? 1;
    if (shouldSnapshot) {
      const beforeSnapshot = { name: existing.name, description: existing.description, nodes: existing.nodes, edges: existing.edges, variables: existing.variables };
      await this.versionsService.recordVersionSafe({
        projectId,
        entityType: VERSIONED_ENTITY.WORKFLOW,
        entityId: workflowId,
        versionNumber: currentVersion,
        snapshot: beforeSnapshot,
        changeType: 'update',
        changeSummary: summarizeChanges(beforeSnapshot, data),
        changedById: access.userId,
        changedByName: access.actorName ?? null,
      });
      data.version = currentVersion + 1;
    }

    // Toute modification du contenu (graphe ou variables) d'un workflow déjà
    // validé le repasse en brouillon — le BA doit re-valider avant que les
    // autres utilisateurs ne voient/exécutent la nouvelle version.
    const touchesContent = dto.nodes !== undefined || dto.edges !== undefined || dto.variables !== undefined;
    const willUnvalidate = touchesContent && existing.is_validated;
    if (willUnvalidate) {
      data.is_validated = false;
      data.validated_at = null;
      data.validated_by_id = null;
    }

    const updated = await this.prisma.testWorkflow.update({
      where: { id: workflowId },
      data,
      include: { created_by: { select: { id: true, name: true, email: true } }, validated_by: { select: { id: true, name: true, email: true } }, assignedUsers: { select: { id: true, name: true, email: true, role: true } }, assignedQas: { select: { id: true, name: true, email: true, role: true } } },
    });

    // Prévient le créateur ET les BA assignés (best-effort) que la version
    // validée vient d'être modifiée et doit être re-validée avant de
    // redevenir exécutable par les QA — plutôt que de les laisser le
    // découvrir seuls en rouvrant le workflow. Celui qui vient de faire la
    // modification est automatiquement exclu (notify() s'auto-filtre déjà
    // sur actorId).
    if (willUnvalidate) {
      const recipientIds = Array.from(new Set([existing.created_by_id, ...(existing.assignedUserIds ?? [])].filter((id): id is string => !!id)));
      if (recipientIds.length > 0) {
        this.logger.log(`🔔 [unvalidate] Notification à ${recipientIds.join(', ')} (éditeur=${access.userId}) pour le workflow ${workflowId}`);
        this.notificationsService.notifyMany(recipientIds, {
          type: 'workflow_activity',
          message: `${access.actorName || 'Un utilisateur'} a modifié le workflow « ${updated.name} ». Il repasse en brouillon et devra être revalidé avant de redevenir exécutable par l'équipe.`,
          actorId: access.userId,
          projectId,
          entityType: 'workflow',
          entityId: workflowId,
          link: `/analyzer?projectId=${projectId}&view=workflow&workflowId=${workflowId}`,
        })
          .then(() => this.logger.log(`✅ [unvalidate] Notification(s) envoyée(s) à ${recipientIds.length} destinataire(s)`))
          .catch((err) => this.logger.error(`❌ [unvalidate] Échec de la notification: ${err?.message || err}`));
      }
    } else {
      this.logger.log(`ℹ️ [unvalidate] Pas de notification — willUnvalidate=${willUnvalidate}`);
    }

    return updated;
  }

  // ── Historique / rollback ───────────────────────────────────────────────

  async listVersions(projectId: string, workflowId: string, access: AccessCheck) {
    await this.assertProjectAccess(projectId, access);
    await this.findAccessibleWorkflow(workflowId, projectId, access);
    return this.versionsService.listVersions(VERSIONED_ENTITY.WORKFLOW, workflowId);
  }

  /** Restaure une ancienne version du workflow (nom, description, graphe, variables) — archive l'état courant avant d'écraser. */
  async restoreVersion(projectId: string, workflowId: string, versionId: string, access: AccessCheck) {
    await this.assertProjectAccess(projectId, access);
    await this.projectService.assertProjectUnlocked(projectId);
    const existing = await this.findAccessibleWorkflow(workflowId, projectId, access);

    const version = await this.versionsService.getVersion(VERSIONED_ENTITY.WORKFLOW, workflowId, versionId);
    if (!version) throw new NotFoundException('Version introuvable pour ce workflow');
    const snapshot = version.snapshot as { name?: string; description?: string; nodes?: any; edges?: any; variables?: any };

    const currentVersion = existing.version ?? 1;
    await this.versionsService.recordVersionSafe({
      projectId,
      entityType: VERSIONED_ENTITY.WORKFLOW,
      entityId: workflowId,
      versionNumber: currentVersion,
      snapshot: { name: existing.name, description: existing.description, nodes: existing.nodes, edges: existing.edges, variables: existing.variables },
      changeType: 'restore',
      changeSummary: `Restauration de la version #${version.version_number}`,
      changedById: access.userId,
      changedByName: access.actorName ?? null,
    });

    // Comme pour update() : restaurer un ancien contenu sur un workflow déjà
    // validé le repasse en brouillon, pour cohérence avec la même règle — le
    // créateur et les BA assignés sont notifiés (même logique que update()).
    const willUnvalidate = existing.is_validated;

    const updated = await this.prisma.testWorkflow.update({
      where: { id: workflowId },
      data: {
        name: snapshot.name ?? existing.name,
        description: snapshot.description ?? existing.description,
        nodes: snapshot.nodes ?? existing.nodes,
        edges: snapshot.edges ?? existing.edges,
        variables: snapshot.variables ?? existing.variables,
        version: currentVersion + 1,
        ...(willUnvalidate ? { is_validated: false, validated_at: null, validated_by_id: null } : {}),
      },
      include: { created_by: { select: { id: true, name: true, email: true } }, validated_by: { select: { id: true, name: true, email: true } }, assignedUsers: { select: { id: true, name: true, email: true, role: true } }, assignedQas: { select: { id: true, name: true, email: true, role: true } } },
    });

    if (willUnvalidate) {
      const recipientIds = Array.from(new Set([existing.created_by_id, ...(existing.assignedUserIds ?? [])].filter((id): id is string => !!id)));
      if (recipientIds.length > 0) {
        this.notificationsService.notifyMany(recipientIds, {
          type: 'workflow_activity',
          message: `${access.actorName || 'Un utilisateur'} a restauré une ancienne version du workflow « ${updated.name} ». Il repasse en brouillon et devra être revalidé.`,
          actorId: access.userId,
          projectId,
          entityType: 'workflow',
          entityId: workflowId,
          link: `/analyzer?projectId=${projectId}&view=workflow&workflowId=${workflowId}`,
        }).catch((err) => this.logger.error(`❌ [restoreVersion] Échec de la notification: ${err?.message || err}`));
      }
    }

    return updated;
  }

  /** Valide (publie) un workflow — le rend visible aux autres utilisateurs du projet. */
  async validate(projectId: string, workflowId: string, access: AccessCheck) {
    await this.assertProjectAccess(projectId, access);
    await this.projectService.assertProjectUnlocked(projectId);
    const workflow = await this.findAccessibleWorkflow(workflowId, projectId, access);

    const nodes = (workflow.nodes as unknown as WorkflowNode[]) ?? [];
    if (nodes.length === 0) {
      throw new BadRequestException("Ce workflow n'a aucune étape — ajoutez au moins une étape avant de le valider");
    }

    const updated = await this.prisma.testWorkflow.update({
      where: { id: workflowId },
      data: { is_validated: true, validated_at: new Date(), validated_by_id: access.userId },
      include: { created_by: { select: { id: true, name: true, email: true } }, validated_by: { select: { id: true, name: true, email: true } }, assignedUsers: { select: { id: true, name: true, email: true, role: true } }, assignedQas: { select: { id: true, name: true, email: true, role: true } } },
    });

    // Prévient les QA du projet (best-effort) que ce workflow est désormais
    // exécutable — au lieu qu'ils ne le découvrent qu'en rechargeant la
    // galerie eux-mêmes.
    this.notificationsService.notifyProjectMembersByRole(projectId, ['QA'], {
      type: 'workflow_activity',
      message: `${access.actorName || 'Un utilisateur'} a validé le workflow de test « ${updated.name} ». Il est désormais disponible pour exécution.`,
      actorId: access.userId,
      projectId,
      entityType: 'workflow',
      entityId: workflowId,
      link: `/analyzer?projectId=${projectId}&view=workflow&workflowId=${workflowId}`,
    }).catch(() => { /* best-effort */ });

    return updated;
  }

  /** Repasse un workflow validé en brouillon (retrait de publication). */
  async unvalidate(projectId: string, workflowId: string, access: AccessCheck) {
    await this.assertProjectAccess(projectId, access);
    await this.projectService.assertProjectUnlocked(projectId);
    await this.findAccessibleWorkflow(workflowId, projectId, access);

    return this.prisma.testWorkflow.update({
      where: { id: workflowId },
      data: { is_validated: false, validated_at: null, validated_by_id: null },
      include: { created_by: { select: { id: true, name: true, email: true } }, validated_by: { select: { id: true, name: true, email: true } }, assignedUsers: { select: { id: true, name: true, email: true, role: true } }, assignedQas: { select: { id: true, name: true, email: true, role: true } } },
    });
  }

  async remove(projectId: string, workflowId: string, access: AccessCheck) {
    await this.assertProjectAccess(projectId, access);
    await this.projectService.assertProjectUnlocked(projectId);
    await this.findAccessibleWorkflow(workflowId, projectId, access);
    await this.prisma.testWorkflow.delete({ where: { id: workflowId } });
    return { deleted: true };
  }

  // ── Exécution (runs) ────────────────────────────────────────────────────

  /** Démarre un nouveau run : snapshot du graphe courant + une entrée "idle" par étape.
   *  Contrairement aux autres mutations, EXIGE que la campagne de tests soit
   *  active (voir ProjectService.assertCampaignLaunched) — c'est l'unique
   *  action encore possible une fois le projet figé par le lancement d'une
   *  campagne (voir launchCampaign côté ProjectController). */
  async startRun(projectId: string, workflowId: string, access: AccessCheck) {
    await this.assertProjectAccess(projectId, access);
    await this.projectService.assertCampaignLaunched(projectId);
    const workflow = await this.findQaAccessibleWorkflow(workflowId, projectId, access);

    if (!workflow.is_validated) {
      throw new BadRequestException("Ce workflow est encore un brouillon — il doit être validé par un BA avant de pouvoir être exécuté");
    }

    const nodes = (workflow.nodes as unknown as WorkflowNode[]) ?? [];
    if (nodes.length === 0) {
      throw new BadRequestException("Ce workflow n'a aucune étape — ajoutez au moins un nœud avant de lancer une exécution");
    }

    const initialResults: WorkflowStepResult[] = nodes.map(n => ({ nodeId: n.id, status: 'idle' }));

    const run = await this.prisma.workflowRun.create({
      data: {
        workflow_id: workflowId,
        project_id: projectId,
        status: 'running',
        nodes_snapshot: workflow.nodes as any,
        edges_snapshot: workflow.edges as any,
        step_results: initialResults as any,
        variable_values: {},
        executed_by_id: access.userId,
      },
    });

    await this.prisma.testWorkflow.update({
      where: { id: workflowId },
      data: { last_run_status: 'running', last_run_at: new Date() },
    });

    return run;
  }

  async listRuns(projectId: string, workflowId: string, access: AccessCheck) {
    await this.assertProjectAccess(projectId, access);
    await this.findOwnedWorkflow(workflowId, projectId);
    return this.prisma.workflowRun.findMany({
      where: { workflow_id: workflowId },
      orderBy: { started_at: 'desc' },
      include: { executed_by: { select: { id: true, name: true, email: true } } },
    });
  }

  private async findOwnedRun(runId: string, workflowId: string) {
    const run = await this.prisma.workflowRun.findUnique({
      where: { id: runId },
      include: { executed_by: { select: { id: true, name: true, email: true } } },
    });
    if (!run || run.workflow_id !== workflowId) {
      throw new NotFoundException('Run introuvable pour ce workflow');
    }
    return run;
  }

  async getRun(projectId: string, workflowId: string, runId: string, access: AccessCheck) {
    await this.assertProjectAccess(projectId, access);
    await this.findOwnedWorkflow(workflowId, projectId);
    return this.findOwnedRun(runId, workflowId);
  }

  /**
   * Met à jour le résultat d'une étape pendant un run en cours : statut,
   * note libre, et valeurs des variables produites par cette étape — ces
   * valeurs rejoignent variable_values du run et deviennent visibles par les
   * étapes en aval qui les consomment (c'est la "corrélation" des données de
   * test entre les étapes du flow).
   */
  async updateStepResult(
    projectId: string,
    workflowId: string,
    runId: string,
    nodeId: string,
    dto: UpdateStepResultDto,
    access: AccessCheck,
  ) {
    await this.assertProjectAccess(projectId, access);
    await this.findQaAccessibleWorkflow(workflowId, projectId, access);
    const run = await this.findOwnedRun(runId, workflowId);

    if (run.status !== 'running') {
      throw new BadRequestException('Ce run est déjà terminé — relancez une nouvelle exécution pour ré-enregistrer des résultats');
    }

    const results = ((run.step_results as unknown as WorkflowStepResult[]) ?? []).slice();
    const idx = results.findIndex(r => r.nodeId === nodeId);
    const now = new Date().toISOString();

    const nextEntry: WorkflowStepResult = {
      nodeId,
      status: dto.status,
      note: dto.note,
      variableValues: dto.variableValues,
      startedAt: results[idx]?.startedAt ?? now,
      finishedAt: now,
      executedById: access.userId,
    };

    if (idx >= 0) results[idx] = { ...results[idx], ...nextEntry };
    else results.push(nextEntry);

    const nextVariableValues = {
      ...((run.variable_values as unknown as Record<string, string>) ?? {}),
      ...(dto.variableValues ?? {}),
    };

    return this.prisma.workflowRun.update({
      where: { id: runId },
      data: {
        step_results: results as any,
        variable_values: nextVariableValues as any,
      },
      include: { executed_by: { select: { id: true, name: true, email: true } } },
    });
  }

  /** Clôture un run : calcule le statut global à partir des étapes et le fige. */
  async finishRun(projectId: string, workflowId: string, runId: string, access: AccessCheck) {
    await this.assertProjectAccess(projectId, access);
    await this.findQaAccessibleWorkflow(workflowId, projectId, access);
    const run = await this.findOwnedRun(runId, workflowId);

    if (run.status !== 'running') return run; // déjà clôturé — idempotent

    const results = (run.step_results as unknown as WorkflowStepResult[]) ?? [];
    const status = computeRunStatus(results.map(r => (r.status === 'idle' ? { ...r, status: 'skipped' as const } : r)));

    const updated = await this.prisma.workflowRun.update({
      where: { id: runId },
      data: { status, finished_at: new Date() },
      include: { executed_by: { select: { id: true, name: true, email: true } } },
    });

    await this.prisma.testWorkflow.update({
      where: { id: workflowId },
      data: { last_run_status: status, last_run_at: new Date() },
    });

    return updated;
  }

  /** Abandonne un run en cours sans le faire compter comme un résultat pass/fail définitif. */
  async abortRun(projectId: string, workflowId: string, runId: string, access: AccessCheck) {
    await this.assertProjectAccess(projectId, access);
    await this.findQaAccessibleWorkflow(workflowId, projectId, access);
    const run = await this.findOwnedRun(runId, workflowId);

    if (run.status !== 'running') return run;

    const updated = await this.prisma.workflowRun.update({
      where: { id: runId },
      data: { status: 'aborted', finished_at: new Date() },
      include: { executed_by: { select: { id: true, name: true, email: true } } },
    });

    await this.prisma.testWorkflow.update({
      where: { id: workflowId },
      data: { last_run_status: 'aborted', last_run_at: new Date() },
    });

    return updated;
  }

  async removeRun(projectId: string, workflowId: string, runId: string, access: AccessCheck) {
    await this.assertProjectAccess(projectId, access);
    await this.findQaAccessibleWorkflow(workflowId, projectId, access);
    await this.findOwnedRun(runId, workflowId);
    await this.prisma.workflowRun.delete({ where: { id: runId } });
    return { deleted: true };
  }

  // ── Génération de données de test par LLM ───────────────────────────────

  /**
   * Demande au LLM (Ollama, même moteur que la génération de cas de test) de
   * proposer une valeur réaliste et cohérente pour chaque variable déclarée
   * sur le workflow, en s'appuyant sur le contexte des étapes (libellés,
   * cas de test liés, description) pour que les valeurs se correspondent
   * d'une étape à l'autre (même identifiant de dossier partout, etc.).
   * Les valeurs proposées sont enregistrées comme `exampleValue` sur chaque
   * WorkflowVariable — l'utilisateur les revoit/édite avant de lancer un run.
   */
  async generateTestData(projectId: string, workflowId: string, dto: GenerateTestDataDto, access: AccessCheck) {
    await this.assertProjectAccess(projectId, access);
    await this.projectService.assertProjectUnlocked(projectId);
    const workflow = await this.findAccessibleWorkflow(workflowId, projectId, access);

    const nodes = (workflow.nodes as unknown as WorkflowNode[]) ?? [];
    const variables = (workflow.variables as unknown as WorkflowVariable[]) ?? [];

    if (variables.length === 0) {
      throw new BadRequestException("Ce workflow n'a aucune variable déclarée — ajoutez au moins une variable de donnée de test avant de générer des valeurs");
    }

    const stepsBlock = nodes
      .map((n, i) => {
        const parts = [`${i + 1}. [${n.data.nodeType}] ${n.data.label}`];
        if (n.data.testCaseSnapshot) parts.push(`   Cas de test lié : ${n.data.testCaseSnapshot.testId} — ${n.data.testCaseSnapshot.title}`);
        if (n.data.description) parts.push(`   Description : ${n.data.description}`);
        if (n.data.inputVariables?.length) parts.push(`   Variables reçues : ${n.data.inputVariables.join(', ')}`);
        if (n.data.outputVariables?.length) parts.push(`   Variables produites : ${n.data.outputVariables.join(', ')}`);
        return parts.join('\n');
      })
      .join('\n');

    const variablesBlock = variables.map(v => `- ${v.name}${v.description ? ` (${v.description})` : ''}`).join('\n');

    const systemPrompt = 'You are a JSON API generating realistic test data. Output ONLY raw valid JSON — a flat object mapping each variable name to a single string value. No prose, no markdown, no code fences.';

    const userMessage = [
      `Voici les étapes d'un scénario de test (workflow) : `,
      stepsBlock || '(aucune étape)',
      '',
      `Voici les variables de données de test à valoriser, dans l'ordre où elles circulent entre les étapes :`,
      variablesBlock,
      '',
      dto.notes ? `Contexte additionnel fourni par l'utilisateur : ${dto.notes}` : '',
      '',
      'Génère UNE valeur réaliste et cohérente par variable (même identifiant réutilisé partout où il apparaît, formats plausibles : emails valides, montants numériques, identifiants de dossier au format LN-AAAA-NNNNNN, statuts cohérents avec le contexte de l\'étape qui les produit).',
      `Réponds uniquement avec un objet JSON de la forme { "${variables[0]?.name || 'nomVariable'}": "valeur", ... } couvrant TOUTES les variables listées ci-dessus, rien d'autre.`,
    ].filter(Boolean).join('\n');

    let raw: any;
    try {
      raw = await callOllama(this.ollamaUrl, this.model, userMessage, undefined, systemPrompt, { ...PHASE_B_OPTIONS, format: 'json' as const });
    } catch (err: any) {
      throw new BadRequestException(`Erreur lors de l'appel au modèle de génération : ${err?.message || err}`);
    }

    const content = raw?.message?.content ?? raw?.response ?? raw;
    const parsed = safeParseJson(typeof content === 'string' ? content : JSON.stringify(content));

    if (!parsed || typeof parsed !== 'object') {
      throw new BadRequestException("Le modèle n'a pas renvoyé de données exploitables — réessayez, ou renseignez les valeurs manuellement");
    }

    const values: Record<string, string> = {};
    for (const v of variables) {
      const generated = parsed[v.name];
      values[v.name] = typeof generated === 'string' && generated.trim() ? generated.trim() : (v.exampleValue || '');
    }

    const updatedVariables: WorkflowVariable[] = variables.map(v => ({ ...v, exampleValue: values[v.name] || v.exampleValue }));

    const updated = await this.prisma.testWorkflow.update({
      where: { id: workflowId },
      data: { variables: updatedVariables as any },
      include: { created_by: { select: { id: true, name: true, email: true } } },
    });

    return { workflow: updated, values };
  }

  // ── Suggestion IA de "prochains cas de test" ────────────────────────────

  /**
   * Demande au LLM (même moteur Ollama que la génération de cas de test)
   * quels cas de test du projet pourraient RÉALISTEMENT s'enchaîner après le
   * dernier cas de test du workflow — utilisé par le panneau "Ajouter une
   * étape" pour mettre en évidence les suites logiques probables, au-delà
   * d'une simple heuristique "même module".
   *
   * Important : on ne juge pas le dernier cas de test isolément. On fournit
   * au modèle TOUT le scénario déjà construit dans le workflow (chaque étape
   * déjà ajoutée, dans l'ordre, avec son résultat attendu), pour qu'il tienne
   * compte de l'état déjà établi par les étapes précédentes — pas seulement
   * de la toute dernière — et évite de suggérer une étape qui redouble ou
   * contredit quelque chose déjà couvert plus tôt dans le workflow. Les cas
   * de test déjà présents dans le workflow sont exclus des candidats (déjà
   * ajoutés, ce n'est pas au modèle de les re-proposer).
   *
   * Les identifiants renvoyés qui ne correspondent à aucun candidat proposé
   * sont ignorés (garde-fou contre les hallucinations d'ID).
   */
  async suggestNextTestCases(projectId: string, dto: SuggestNextTestCasesDto, access: AccessCheck) {
    const project: any = await this.projectService.getProject(projectId, access);

    type FlatTc = {
      id: string; testId: string; title: string; moduleName: string; reqId: string;
      steps: string[]; preconditions: string[]; expectedResult: string; type: string;
    };
    const all: FlatTc[] = [];
    for (const mod of project.modules ?? []) {
      for (const req of mod.requirements ?? []) {
        for (const tc of req.test_cases ?? []) {
          all.push({
            id: tc.id,
            testId: tc.test_id,
            title: tc.title,
            moduleName: mod.name,
            reqId: req.req_id,
            steps: tc.steps ?? [],
            preconditions: tc.preconditions ?? [],
            expectedResult: tc.expected_result ?? '',
            type: tc.type,
          });
        }
      }
    }

    const byId = new Map(all.map(tc => [tc.id, tc]));
    const source = byId.get(dto.testCaseId);
    if (!source) throw new NotFoundException('Cas de test introuvable dans ce projet');

    // Séquence complète déjà construite dans le workflow, dans l'ordre — le
    // dernier élément DOIT être `source` (testCaseId). Si le front n'a pas
    // transmis workflowTestCaseIds (ancien appelant / erreur), on retombe sur
    // le comportement dégradé : uniquement le dernier TC comme contexte.
    const orderedIds = dto.workflowTestCaseIds?.length ? dto.workflowTestCaseIds : [dto.testCaseId];
    const scenarioSoFar = orderedIds
      .map(id => byId.get(id))
      .filter((tc): tc is FlatTc => !!tc);
    const inWorkflow = new Set(scenarioSoFar.map(tc => tc.id));

    const candidates = all.filter(tc => !inWorkflow.has(tc.id));
    if (candidates.length === 0) return { suggestions: [] };

    // Cap pour rester dans le budget de contexte du modèle local — au-delà, on
    // garde en priorité les cas de test du même module que le dernier TC (les
    // plus probables), puis on complète avec le reste par ordre d'apparition.
    const MAX_CANDIDATES = 60;
    let pool = candidates;
    if (candidates.length > MAX_CANDIDATES) {
      const sameModule = candidates.filter(tc => tc.moduleName === source.moduleName);
      const others = candidates.filter(tc => tc.moduleName !== source.moduleName);
      pool = [...sameModule, ...others].slice(0, MAX_CANDIDATES);
    }

    const oneLine = (s: string, max = 90) => {
      const t = (s || '').replace(/\s+/g, ' ').trim();
      return t.length > max ? `${t.slice(0, max)}…` : t;
    };

    // Bloc "scénario déjà construit" — une ligne compacte par étape déjà
    // ajoutée, avec un marquage explicite de la DERNIÈRE (celle après
    // laquelle on cherche la suite). Les étapes précédentes ne sont résumées
    // qu'en une ligne (titre + résultat attendu) pour rester compact ; seule
    // la dernière reçoit le détail complet (préconditions/étapes), car c'est
    // elle le point de reprise exact de la séquence.
    const scenarioBlock = scenarioSoFar
      .map((tc, i) => {
        const isLast = i === scenarioSoFar.length - 1;
        const marker = isLast ? '→ DERNIÈRE ÉTAPE (point de reprise)' : `Étape ${i + 1}/${scenarioSoFar.length}`;
        if (!isLast) {
          return `${marker} : [${tc.testId}] ${tc.title} — attendu : ${oneLine(tc.expectedResult, 80) || '(n/a)'}`;
        }
        return [
          `${marker} : [${tc.testId}] ${tc.title}`,
          `  Module : ${tc.moduleName} | Exigence : ${tc.reqId} | Type : ${tc.type}`,
          tc.preconditions.length ? `  Préconditions : ${tc.preconditions.map(p => oneLine(p, 60)).join(' ; ')}` : '',
          tc.steps.length ? `  Étapes : ${tc.steps.map((s, si) => `${si + 1}) ${oneLine(s, 70)}`).join(' ')}` : '',
          tc.expectedResult ? `  Résultat attendu : ${oneLine(tc.expectedResult, 100)}` : '',
        ].filter(Boolean).join('\n');
      })
      .join('\n');

    const candidatesBlock = pool
      .map(tc => `- id="${tc.id}" [${tc.testId}] (${tc.moduleName}) ${tc.title} — attendu : ${oneLine(tc.expectedResult, 70) || '(n/a)'}`)
      .join('\n');

    const systemPrompt = 'You are a JSON API that analyzes software QA test scenarios to find realistic next steps. Output ONLY raw valid JSON — a single object { "suggestions": [{ "id": string, "reason": string }] }. No prose, no markdown, no code fences.';

    const userMessage = [
      scenarioSoFar.length > 1
        ? `Voici le scénario de test déjà construit dans ce workflow, DANS L'ORDRE (${scenarioSoFar.length} étape(s)) :`
        : 'Voici le seul cas de test déjà présent dans ce workflow (point de départ) :',
      scenarioBlock,
      '',
      "Voici une liste d'AUTRES cas de test du même projet, pas encore ajoutés à ce workflow :",
      candidatesBlock,
      '',
      "Parmi cette liste, identifie ceux qui pourraient RÉALISTEMENT s'exécuter JUSTE APRÈS la DERNIÈRE ÉTAPE, en tenant compte de TOUT le scénario déjà construit (pas seulement de la dernière étape isolée) — par exemple parce qu'ils dépendent d'un état déjà établi par une étape précédente (un dossier créé, un compte connecté, une donnée saisie, une action validée), ou parce qu'ils en sont la suite fonctionnelle naturelle dans ce même parcours bout-en-bout. Écarte un candidat qui referait quelque chose déjà couvert par une étape antérieure du scénario, ou qui n'a aucun lien de séquence plausible avec l'état actuel du parcours, même s'il touche un sujet proche.",
      'Réponds uniquement avec un objet JSON { "suggestions": [{ "id": "...", "reason": "..." }] } (reason = une phrase courte en français expliquant le lien de séquence avec l\'état actuel du scénario), ou { "suggestions": [] } si aucun ne convient. N\'invente jamais un id qui ne figure pas dans la liste de candidats ci-dessus.',
    ].join('\n');

    let raw: any;
    try {
      raw = await callOllama(this.ollamaUrl, this.model, userMessage, undefined, systemPrompt, {
        ...PHASE_B_OPTIONS,
        num_ctx: 8192,
        num_predict: 700,
        format: 'json' as const,
      });
    } catch (err: any) {
      throw new BadRequestException(`Erreur lors de l'appel au modèle de suggestion : ${err?.message || err}`);
    }

    const content = raw?.message?.content ?? raw?.response ?? raw;
    const parsed = safeParseJson(typeof content === 'string' ? content : JSON.stringify(content));
    // Important : safeParseJson (partagé avec le reste de l'app) est conçu pour
    // parser un OBJET JSON en tête de réponse (il cherche la première "{") — un
    // tableau JSON nu en tête ([...]) le fait échouer silencieusement (il ne
    // récupère alors que le premier élément, hors tableau). D'où la demande au
    // modèle d'un objet { "suggestions": [...] } plutôt qu'un tableau brut.
    const rawList = Array.isArray(parsed?.suggestions) ? parsed.suggestions : (Array.isArray(parsed) ? parsed : []);

    const validIds = new Set(pool.map(tc => tc.id));
    const suggestions = rawList
      .filter((item: any) => item && typeof item.id === 'string' && validIds.has(item.id))
      .map((item: any) => ({ id: item.id, reason: typeof item.reason === 'string' ? item.reason.slice(0, 220) : undefined }));

    return { suggestions };
  }
}