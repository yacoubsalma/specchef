import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import type { Project, Requirement, TestCase } from '@prisma/client';
import { RequirementsJson, TestCaseGenerationResult } from '../llm/llm.service';
import { CacheService } from '../cache/cache.service';
import { SrsService } from '../srs/srs.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { MongoVectorService } from '../vector/mongo-vector.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { LangfuseService } from '../shared/langfuse.service';
import {
  cosineSimilarity,
  IMPACT_CHANGE_THRESHOLD,
  IMPACT_COUPLING_THRESHOLD,
  ImpactResult,
  ImpactedRequirement,
} from '../shared/impact-analysis';
import { VersionsService } from '../versions/versions.service';

// Identité de l'auteur d'une modification, pour l'historisation (voir EntityVersion.changed_by_*).
// Facultatif partout (rétrocompatible) : une historisation sans acteur connu
// enregistre quand même le snapshot, juste sans attribution nominative.
export interface VersionActor {
  id?: string | null;
  name?: string | null;
}

// Sentinelle renvoyée par une méthode CRUD (module/exigence/cas de test) quand
// une campagne de tests est active : la mutation demandée n'a PAS été
// appliquée, elle a été mise en standby (voir ProjectService.queueIfCampaignActive).
// Le contrôleur doit renvoyer cet objet tel quel plutôt que de traiter
// l'appel comme un succès classique.
export interface CampaignPendingResult {
  pending: true;
  changeId: string;
  message: string;
}

// ─── Shared utilities (source de vérité unique) ───────────────────────────────
import { normalizeTcType } from '../shared/tc-types';
import {
  buildPhaseAPrompt,
  buildPhaseASinglePrompt,
  buildPhaseABSinglePrompt,
  buildPhaseBPrompt,
  buildSelfCritiquePrompt,
  RegenAngle,
  ExistingTC,
} from '../shared/prompt-builders';
import {
  validateTestCase,
  isTitleTooClose,
  isAngleCovered,
  TcSnapshot,
  buildExistingTCs,
  buildForbiddenTitles,
  extractExistingTypes,
  filterHistoryTitles,
} from '../shared/tc-utils';
import {
  callOllamaAndParse,
  PHASE_A_OPTIONS,
  PHASE_A_SINGLE_OPTIONS,
  PHASE_B_OPTIONS,
  PHASE_B_SINGLE_OPTIONS,
  PHASE_AB_FAST_OPTIONS,
  SELF_CRITIQUE_OPTIONS,
  VERIFY_OPTIONS,
  PHASE_A_REGEN_OPTIONS,
  PHASE_B_REGEN_OPTIONS,
  OllamaOptions,
} from '../shared/ollama-client';
import { VERSIONED_ENTITY, summarizeChanges } from '../shared/version-types';

// ─── Service ──────────────────────────────────────────────────────────────────

// ── Conflit d'édition concurrente (verrou optimiste) ────────────────────────
// Levée par editRequirement() quand `expectedUpdatedAt` (la version que le
// client avait sous les yeux au moment d'ouvrir le champ) ne correspond plus
// à `updated_at` en base — signe que quelqu'un d'autre a sauvegardé entre
// temps. `current` porte la version réelle en base pour que l'appelant
// (project.controller.ts) puisse la renvoyer au front et éviter d'écraser
// silencieusement le travail de l'autre utilisateur.
export class RequirementConflictError extends Error {
  constructor(public readonly current: any) {
    super('Cette exigence a été modifiée entre-temps par un autre utilisateur.');
    this.name = 'RequirementConflictError';
  }
}

@Injectable()
export class ProjectService {
  private readonly logger = new Logger(ProjectService.name);

  private readonly SIMILARITY_STRICT  = 0.89;
  private readonly SIMILARITY_WARNING = 0.83;
  private readonly LLM_CALL_TIMEOUT_MS = 120_000;
  private readonly historyLocks = new Map<string, { busy: boolean; queue: Array<(release: () => void) => void> }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: CacheService,
    private readonly srsService: SrsService,
    private readonly mongoVector: MongoVectorService,
    private readonly embeddingService: EmbeddingService,
    private readonly langfuseService: LangfuseService,
    private readonly notificationsService: NotificationsService,
    private readonly notificationsGateway: NotificationsGateway,
    private readonly versionsService: VersionsService,
  ) {}

  // ── Résolution du projectId (utilisé par le contrôleur pour diffuser les
  // événements temps réel — voir NotificationsGateway.emitToProject) ─────────
  // Requêtes minimales (select-only), pas de coût significatif ajouté sur les
  // routes de mutation existantes.
  async getProjectIdForModule(moduleId: string): Promise<string | null> {
    const mod = await this.prisma.requirementModule.findUnique({
      where: { id: moduleId },
      select: { project_id: true },
    });
    return mod?.project_id ?? null;
  }

  async getProjectIdForRequirement(requirementId: string): Promise<string | null> {
    const req = await this.prisma.requirement.findUnique({
      where: { id: requirementId },
      select: { module: { select: { project_id: true } } },
    });
    return req?.module?.project_id ?? null;
  }

  async getProjectIdForTestCase(testCaseId: string): Promise<string | null> {
    const tc = await this.prisma.testCase.findUnique({
      where: { id: testCaseId },
      select: { requirement_id: true },
    });
    if (!tc?.requirement_id) return null;
    return this.getProjectIdForRequirement(tc.requirement_id);
  }

  // ── Campagne de tests (gel global du projet) ────────────────────────────
  // À appeler en tête de toute méthode qui crée/modifie/supprime une donnée
  // persistée (module, exigence, cas de test, workflow...) : lève une
  // ForbiddenException si une campagne est en cours pour ce projet. `null`
  // (projectId non résolu) est toléré sans bloquer — mêmes garanties que les
  // helpers getProjectIdFor* ci-dessus, qui peuvent renvoyer null.
  async assertProjectUnlocked(projectId: string | null | undefined): Promise<void> {
    if (!projectId) return;
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { campaign_status: true },
    });
    if (project?.campaign_status === 'launched') {
      throw new ForbiddenException(
        'Une campagne de tests est en cours : le projet est figé, aucune création/modification/suppression n\'est autorisée tant qu\'elle n\'est pas clôturée.',
      );
    }
  }

  /**
   * Pendant une campagne active, une mutation de contenu (module / exigence /
   * cas de test) n'est PLUS refusée (voir assertProjectUnlocked, toujours
   * utilisé tel quel pour les workflows) — elle est mise "en standby" :
   * enregistrée dans CampaignChange SANS toucher à l'entité réelle, et
   * rejouée seulement à la clôture de la campagne si l'utilisateur choisit
   * de la garder (voir closeCampaign). `method` doit être le nom exact d'une
   * méthode publique de ProjectService, rejouée plus tard via
   * `(this as any)[method](...args)` — évite de dupliquer la logique métier
   * (versioning, analyse d'impact, embeddings...) propre à chaque mutation.
   * Retourne un objet "pending" que l'appelant doit renvoyer TEL QUEL sans
   * exécuter sa mutation ; `null` si aucune campagne n'est active (l'appelant
   * continue alors sa mutation normalement, comportement inchangé).
   */
  async queueIfCampaignActive(params: {
    projectId: string | null | undefined;
    method: string;
    args: any[];
    entityType: 'requirement_module' | 'requirement' | 'test_case';
    entityId?: string | null;
    label: string;
    actor?: VersionActor;
  }): Promise<CampaignPendingResult | null> {
    if (!params.projectId) return null;
    const project = await this.prisma.project.findUnique({
      where: { id: params.projectId },
      select: { campaign_status: true },
    });
    if (project?.campaign_status !== 'launched') return null;

    // Mongo/Prisma refuse toute valeur `undefined` dans un champ JSON — seul
    // `null` est accepté (voir PrismaClientValidationError sur args[n]).
    // Plusieurs appelants passent des paramètres optionnels (ex: `expectedUpdatedAt`
    // sur editRequirement, `dto` sur validateTestCase) qui valent `undefined`
    // quand ils ne sont pas fournis — on les normalise ici une bonne fois pour
    // toutes plutôt que dans chaque appel de queueIfCampaignActive.
    const safeArgs = (params.args ?? []).map(a => a === undefined ? null : a);

    const change = await this.prisma.campaignChange.create({
      data: {
        project_id: params.projectId,
        method: params.method,
        args: safeArgs as any,
        entity_type: params.entityType,
        entity_id: params.entityId ?? null,
        label: params.label,
        changed_by_id: params.actor?.id ?? null,
        changed_by_name: params.actor?.name ?? null,
      },
    });

    try {
      this.notificationsGateway.emitToProject(params.projectId, 'campaign:change-queued', {
        changeId: change.id, entityType: change.entity_type, entityId: change.entity_id, label: change.label,
      });
    } catch { /* diffusion temps réel best-effort */ }

    return {
      pending: true,
      changeId: change.id,
      message: 'Une campagne de tests est en cours : cette modification est mise en attente (elle ne s\'applique pas tout de suite) et sera à garder ou annuler à la clôture de la campagne.',
    };
  }

  /** Liste les modifications en attente (non encore résolues) d'un projet — pour l'écran de clôture de campagne.
   *  Chaque modification est enrichie de `current` : l'état ACTUEL en base de l'entité visée (avant application),
   *  pour permettre au front d'afficher une comparaison avant/après plutôt que la seule nouvelle valeur.
   *  `current` est `null` pour une création (l'entité n'existe pas encore) ou si l'entité a été supprimée depuis. */
  async listPendingCampaignChanges(projectId: string, accessCheck: { userId: string; isAdmin: boolean }) {
    await this._assertProjectMember(projectId, accessCheck);
    const changes = await this.prisma.campaignChange.findMany({
      where: { project_id: projectId, status: 'pending' },
      orderBy: { created_at: 'asc' },
    });

    return Promise.all(changes.map(async (change) => {
      let current: any = null;
      if (change.entity_id) {
        try {
          if (change.entity_type === 'requirement_module') {
            current = await this.prisma.requirementModule.findUnique({
              where: { id: change.entity_id },
              select: { name: true, description: true },
            });
          } else if (change.entity_type === 'requirement') {
            current = await this.prisma.requirement.findUnique({
              where: { id: change.entity_id },
              select: { req_id: true, description: true, priority: true },
            });
          } else if (change.entity_type === 'test_case') {
            current = await this.prisma.testCase.findUnique({
              where: { id: change.entity_id },
              select: { title: true, preconditions: true, steps: true, test_data: true, expected_result: true, type: true, priority: true, validated: true, review_status: true },
            });
          }
        } catch { /* entité supprimée entre-temps — current reste null, best-effort */ }
      }
      return { ...change, current };
    }));
  }

  /** Avancement détaillé de la campagne d'un projet (courante ou dernière clôturée) —
   *  alimente la page /campaigns/:projectId côté PO. Combine trois sources :
   *  - Cas de test : execution_status ('passed'/'failed'/'not_tested') saisi via les
   *    3 boutons sur la carte TC (voir analyzer/page.tsx).
   *  - Workflows : last_run_status de chaque workflow VALIDÉ (dénormalisé sur
   *    TestWorkflow, voir WorkflowService) — un workflow non encore exécuté compte
   *    comme "not_run".
   *  - CampaignChange en attente ('pending') : modifications mises en standby
   *    pendant la campagne, à résoudre avant la clôture (voir closeCampaign).
   *  `progressPct` = part des cas de test avec un verdict (passed+failed) sur le
   *  total, seule métrique utilisée pour la barre de progression globale. */
  /**
   * Calcule le détail complet des cas de test et workflows d'un projet
   * (indépendant du statut de campagne) — factorisé pour être appelé à la
   * fois par getCampaignProgress (campagne en cours) et par closeCampaign
   * (snapshot figé dans l'historique, voir CampaignRun).
   */
  private async _computeCampaignStats(projectId: string, sinceDate?: Date | null) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        modules: {
          select: {
            name: true,
            requirements: {
              select: {
                req_id: true,
                test_cases: {
                  select: {
                    id: true, test_id: true, title: true, priority: true,
                    execution_status: true, executed_at: true,
                    executed_by: { select: { name: true, email: true } },
                  },
                },
              },
            },
          },
        },
        // is_validated: seuls les workflows publiés comptent pour la
        // campagne, un brouillon BA n'est pas encore testable.
        workflows: { where: { is_validated: true }, select: { id: true, name: true, last_run_status: true, last_run_at: true } },
      },
    });
    if (!project) throw new BadRequestException(`Projet ${projectId} introuvable`);

    const testCases = (project.modules ?? []).flatMap((m) =>
      (m.requirements ?? []).flatMap((r) => (r.test_cases ?? []).map((tc) => ({ ...tc, moduleName: m.name, reqId: r.req_id }))),
    );
    const tcTotal = testCases.length;
    const tcPassedList = testCases.filter((tc) => tc.execution_status === 'passed');
    const tcPassed = tcPassedList.length;
    const tcFailedList = testCases.filter((tc) => tc.execution_status === 'failed');
    const tcFailed = tcFailedList.length;
    const tcNotTested = tcTotal - tcPassed - tcFailed;

    // Détail par TC — pour les panneaux "Cas de test réussis/échoués" côté PO
    // (retrouver quoi/où sans rouvrir tout l'analyzer, voir /campaigns/:id).
    // Bornée à 200 chacune pour ne pas alourdir la réponse sur un très gros
    // projet ; le PO n'a de toute façon pas vocation à en parcourir des
    // centaines depuis cette page.
    const mapTc = (tc: (typeof testCases)[number]) => ({
      id: tc.id, testId: tc.test_id, title: tc.title, priority: tc.priority,
      moduleName: tc.moduleName, reqId: tc.reqId,
      executedAt: tc.executed_at, executedBy: tc.executed_by ? (tc.executed_by.name || tc.executed_by.email) : null,
    });
    const byRecent = (a: (typeof testCases)[number], b: (typeof testCases)[number]) =>
      (b.executed_at?.getTime() ?? 0) - (a.executed_at?.getTime() ?? 0);
    const passedTestCases = [...tcPassedList].sort(byRecent).slice(0, 200).map(mapTc);
    const failedTestCases = [...tcFailedList].sort(byRecent).slice(0, 200).map(mapTc);

    const workflows = project.workflows ?? [];
    const wfTotal = workflows.length;
    const wfByStatus = { passed: 0, failed: 0, partial: 0, aborted: 0, running: 0, not_run: 0 } as Record<string, number>;
    for (const wf of workflows) {
      const s = wf.last_run_status && wfByStatus[wf.last_run_status] !== undefined ? wf.last_run_status : 'not_run';
      wfByStatus[s]++;
    }

    // Enrichissement PO : dernier run complet de chaque workflow (exécutant,
    // durée, détail par étape) — non dénormalisé sur TestWorkflow, donc une
    // requête dédiée sur WorkflowRun (une par workflow, triée par date desc).
    // Bornée à sinceDate (le lancement de la campagne EN COURS) quand fourni :
    // launchCampaign remet last_run_status/last_run_at à zéro sans supprimer
    // l'historique des runs (WorkflowRun n'est jamais purgé, pour garder la
    // traçabilité) — sans ce filtre, cette requête ressortirait quand même le
    // dernier run de la campagne PRÉCÉDENTE et contredirait le "repart à 0"
    // juste au-dessus.
    const wfIds = workflows.map((w) => w.id);
    const wfRunDetails = new Map<string, { executedBy: string | null; startedAt: Date; finishedAt: Date | null; stepsPassed: number; stepsFailed: number; stepsTotal: number }>();
    if (wfIds.length > 0) {
      const lastRuns = await this.prisma.workflowRun.findMany({
        where: { workflow_id: { in: wfIds }, ...(sinceDate ? { started_at: { gte: sinceDate } } : {}) },
        orderBy: { started_at: 'desc' },
        select: { workflow_id: true, started_at: true, finished_at: true, step_results: true, executed_by: { select: { name: true, email: true } } },
      });
      for (const run of lastRuns) {
        if (wfRunDetails.has(run.workflow_id)) continue; // déjà pris le plus récent pour ce workflow
        let stepsPassed = 0, stepsFailed = 0, stepsTotal = 0;
        try {
          const steps = Array.isArray(run.step_results) ? (run.step_results as any[]) : [];
          stepsTotal = steps.length;
          stepsPassed = steps.filter((s) => s?.status === 'passed').length;
          stepsFailed = steps.filter((s) => s?.status === 'failed').length;
        } catch { /* step_results malformé — on affiche juste 0/0/0 */ }
        wfRunDetails.set(run.workflow_id, {
          executedBy: run.executed_by ? (run.executed_by.name || run.executed_by.email) : null,
          startedAt: run.started_at, finishedAt: run.finished_at,
          stepsPassed, stepsFailed, stepsTotal,
        });
      }
    }

    const progressPct = tcTotal > 0 ? Math.round(((tcPassed + tcFailed) / tcTotal) * 100) : 0;

    return {
      progressPct,
      testCases: { total: tcTotal, passed: tcPassed, failed: tcFailed, notTested: tcNotTested },
      passedTestCases,
      failedTestCases,
      workflows: {
        total: wfTotal, byStatus: wfByStatus,
        items: workflows.map((w) => {
          const detail = wfRunDetails.get(w.id);
          return {
            id: w.id, name: w.name, status: w.last_run_status ?? 'not_run', lastRunAt: w.last_run_at,
            executedBy: detail?.executedBy ?? null,
            startedAt: detail?.startedAt ?? null, finishedAt: detail?.finishedAt ?? null,
            stepsPassed: detail?.stepsPassed ?? 0, stepsFailed: detail?.stepsFailed ?? 0, stepsTotal: detail?.stepsTotal ?? 0,
          };
        }),
      },
    };
  }

  async getCampaignProgress(projectId: string, accessCheck: { userId: string; isAdmin: boolean }) {
    await this._assertProjectMember(projectId, accessCheck);
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true, name: true,
        campaign_status: true, campaign_launched_at: true, campaign_closed_at: true,
        campaign_launched_by_id: true,
      },
    });
    if (!project) throw new BadRequestException(`Projet ${projectId} introuvable`);

    const launchedBy = project.campaign_launched_by_id
      ? await this.prisma.user.findUnique({ where: { id: project.campaign_launched_by_id }, select: { name: true, email: true } })
      : null;

    const stats = await this._computeCampaignStats(projectId, project.campaign_launched_at);
    const pendingChanges = await this.prisma.campaignChange.count({ where: { project_id: projectId, status: 'pending' } });

    return {
      projectId: project.id,
      projectName: project.name,
      campaignStatus: project.campaign_status,
      launchedAt: project.campaign_launched_at,
      closedAt: project.campaign_closed_at,
      launchedBy: launchedBy ? (launchedBy.name || launchedBy.email) : null,
      ...stats,
      pendingChangesCount: pendingChanges,
    };
  }

  /** Lève une ForbiddenException si AUCUNE campagne n'est active — utilisé pour
   *  n'autoriser le démarrage d'une exécution de workflow que pendant une
   *  campagne (voir WorkflowService.startRun). */
  async assertCampaignLaunched(projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { campaign_status: true },
    });
    if (project?.campaign_status !== 'launched') {
      throw new ForbiddenException(
        'Aucune campagne de tests n\'est active pour ce projet : lancez la campagne avant de démarrer une exécution.',
      );
    }
  }

  /** Vérifie que l'utilisateur est membre du projet (owner/assigné) ou Admin — même règle que getProject(). */
  private async _assertProjectMember(projectId: string, accessCheck: { userId: string; isAdmin: boolean }): Promise<{ id: string; owner_id: string | null; assignedUserIds: string[] }> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, owner_id: true, assignedUserIds: true },
    });
    if (!project) throw new BadRequestException(`Projet ${projectId} introuvable`);
    if (!accessCheck.isAdmin) {
      const isOwner = project.owner_id === accessCheck.userId;
      const isAssigned = (project.assignedUserIds || []).includes(accessCheck.userId);
      if (!isOwner && !isAssigned) {
        throw new ForbiddenException("Vous n'avez pas accès à ce projet");
      }
    }
    return project;
  }

  async launchCampaign(projectId: string, actor: VersionActor, accessCheck: { userId: string; isAdmin: boolean }): Promise<Project> {
    await this._assertProjectMember(projectId, accessCheck);
    // Repart de zéro sur les résultats d'exécution QA de la campagne précédente
    // (bouton Réussi/Échoué/Non testé sur chaque TC) pour ne pas laisser
    // d'anciens verdicts périmés visibles pendant la nouvelle campagne.
    const requirementModules = await this.prisma.requirementModule.findMany({
      where: { project_id: projectId },
      select: { requirements: { select: { id: true } } },
    });
    const requirementIds = requirementModules.flatMap(m => m.requirements.map(r => r.id));
    if (requirementIds.length > 0) {
      await this.prisma.testCase.updateMany({
        where: { requirement_id: { in: requirementIds } },
        data: { execution_status: 'not_tested', executed_at: null, executed_by_id: null },
      });
    }
    // Même chose côté workflows : le dernier statut/date de run affiché
    // (TestWorkflow.last_run_status/last_run_at, dénormalisé pour la liste et
    // pour /campaigns) ne doit pas laisser voir le résultat de la campagne
    // précédente. L'historique détaillé des runs (WorkflowRun) n'est PAS
    // supprimé — seul ce pointeur "dernier run" est remis à zéro, comme pour
    // les TC ci-dessus.
    await this.prisma.testWorkflow.updateMany({
      where: { project_id: projectId },
      data: { last_run_status: null, last_run_at: null },
    });
    const launchedProject = await this.prisma.project.update({
      where: { id: projectId },
      data: {
        campaign_status: 'launched',
        campaign_launched_at: new Date(),
        campaign_launched_by_id: actor?.id ?? null,
        campaign_closed_at: null,
      },
    });
    // Amorce l'historique de CE cycle (voir getCampaignHistory) — complété
    // à la clôture par closeCampaign ci-dessous. Enveloppé dans un vrai
    // try/catch (pas juste .catch() sur la promesse) : si le client Prisma
    // n'a pas encore été régénéré après l'ajout du modèle CampaignRun
    // (`npx prisma generate`), l'accès à this.prisma.campaignRun lève une
    // erreur SYNCHRONE que .catch() seul ne rattrape pas — ça ferait
    // planter le lancement de la campagne lui-même, ce qui n'est jamais
    // acceptable pour un simple souci d'historique.
    try {
      await this.prisma.campaignRun.create({
        data: {
          project_id: projectId,
          launched_at: launchedProject.campaign_launched_at ?? new Date(),
          launched_by_id: actor?.id ?? null,
          launched_by_name: actor?.name ?? null,
        },
      });
    } catch (err: any) {
      this.logger.warn(`⚠️ [launchCampaign] échec création CampaignRun (historique) — avez-vous lancé "npx prisma generate" après l'ajout du modèle ? : ${err?.message}`);
    }
    return launchedProject;
  }

  /**
   * Enregistre le résultat d'exécution QA d'un TC (bouton Réussi/Échoué/Non
   * testé sur la carte du TC) — réservé au QA, et uniquement pendant qu'une
   * campagne est active : ce n'est pas une modification "métier" du TC donc
   * elle ne passe PAS par queueIfCampaignActive (aucune raison de la mettre
   * en standby, c'est justement l'action que la campagne est censée capter).
   */
  async recordTestCaseExecution(
    id: string,
    status: 'passed' | 'failed' | 'not_tested',
    actor: VersionActor,
  ): Promise<TestCase> {
    const projectId = await this.getProjectIdForTestCase(id);
    if (!projectId) throw new BadRequestException(`Cas de test ${id} introuvable`);
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { campaign_status: true },
    });
    if (project?.campaign_status !== 'launched') {
      throw new ForbiddenException(
        "Aucune campagne de tests n'est active pour ce projet : le résultat d'exécution ne peut être saisi que pendant une campagne.",
      );
    }
    return this.prisma.testCase.update({
      where: { id },
      data: {
        execution_status: status,
        executed_at: status === 'not_tested' ? null : new Date(),
        executed_by_id: status === 'not_tested' ? null : (actor?.id ?? null),
      },
    });
  }

  /**
   * Clôture la campagne. Si des modifications ont été mises en standby
   * pendant la campagne (voir queueIfCampaignActive), CHACUNE doit avoir été
   * explicitement résolue ('keep' ou 'discard' dans `resolutions`, indexé par
   * `CampaignChange.id`) — la clôture est refusée tant qu'il en reste une
   * non résolue, pour ne jamais perdre silencieusement le travail de
   * quelqu'un. Le projet est débloqué D'ABORD, puis chaque modification
   * gardée est rejouée (les méthodes rejouées s'exécutent alors normalement,
   * campagne déjà refermée) ; un rejeu qui échoue (ex: conflit d'édition
   * détecté entre-temps) est marqué 'failed' sans faire échouer la clôture
   * elle-même.
   */
  async closeCampaign(
    projectId: string,
    actor: VersionActor,
    accessCheck: { userId: string; isAdmin: boolean },
    resolutions: Record<string, 'keep' | 'discard'> = {},
  ): Promise<{ project: Project; applied: string[]; discarded: string[]; failed: { changeId: string; label: string; error: string }[] }> {
    await this._assertProjectMember(projectId, accessCheck);

    const pending = await this.prisma.campaignChange.findMany({
      where: { project_id: projectId, status: 'pending' },
      orderBy: { created_at: 'asc' },
    });

    const unresolved = pending.filter(c => resolutions[c.id] !== 'keep' && resolutions[c.id] !== 'discard');
    if (unresolved.length > 0) {
      throw new BadRequestException(
        `${unresolved.length} modification(s) mise(s) en attente durant la campagne n'ont pas encore été résolues (garder/annuler) — résolvez-les toutes avant de clôturer.`,
      );
    }

    const project = await this.prisma.project.update({
      where: { id: projectId },
      data: { campaign_status: 'draft', campaign_closed_at: new Date() },
    });

    const applied: string[] = [];
    const discarded: string[] = [];
    const failed: { changeId: string; label: string; error: string }[] = [];

    for (const change of pending) {
      if (resolutions[change.id] === 'discard') {
        await this.prisma.campaignChange.update({ where: { id: change.id }, data: { status: 'discarded', resolved_at: new Date() } });
        discarded.push(change.id);
        continue;
      }
      try {
        const args = Array.isArray(change.args) ? (change.args as any[]) : [];
        await (this as any)[change.method](...args);
        await this.prisma.campaignChange.update({ where: { id: change.id }, data: { status: 'applied', resolved_at: new Date() } });
        applied.push(change.id);
      } catch (err: any) {
        await this.prisma.campaignChange.update({
          where: { id: change.id },
          data: { status: 'failed', error_message: err?.message || String(err), resolved_at: new Date() },
        });
        failed.push({ changeId: change.id, label: change.label, error: err?.message || String(err) });
      }
    }

    if (failed.length > 0) {
      this.logger.warn(`⚠️ [closeCampaign] ${failed.length} modification(s) en attente n'ont pas pu être réappliquées : ${failed.map(f => `${f.label} (${f.error})`).join(' | ')}`);
    }

    // Complète l'historique (voir getCampaignHistory) avec le snapshot final
    // des résultats — best-effort, ne doit jamais faire échouer la clôture
    // elle-même si l'écriture d'historique rencontre un souci.
    try {
      const openRun = await this.prisma.campaignRun.findFirst({
        where: { project_id: projectId, closed_at: null },
        orderBy: { launched_at: 'desc' },
      });

      // Même calcul que getCampaignProgress (TC + workflows détaillés) — on
      // le fige ici en JSON pour que l'export d'une entrée d'historique
      // reste aussi complet que celui de la campagne en cours, même après
      // que launchCampaign ait remis les execution_status à zéro pour le
      // cycle suivant.
      const stats = await this._computeCampaignStats(projectId, project.campaign_launched_at);
      const snapshot = {
        closed_at: project.campaign_closed_at ?? new Date(),
        closed_by_id: actor?.id ?? null,
        closed_by_name: actor?.name ?? null,
        total_test_cases: stats.testCases.total,
        passed_test_cases: stats.testCases.passed,
        failed_test_cases: stats.testCases.failed,
        progress_pct: stats.progressPct,
        applied_changes_count: applied.length,
        discarded_changes_count: discarded.length,
        failed_test_cases_detail: stats.failedTestCases,
        workflows_detail: stats.workflows.items,
      };

      if (openRun) {
        await this.prisma.campaignRun.update({ where: { id: openRun.id }, data: snapshot });
      } else {
        // Aucun CampaignRun "ouvert" à compléter — cette campagne a été
        // LANCÉE avant l'introduction de ce modèle (ou sa création avait
        // échoué au lancement, voir le warning correspondant dans
        // launchCampaign). Plutôt que de perdre silencieusement cette
        // clôture, on reconstitue l'entrée directement ici à partir de ce
        // qu'on sait encore du lancement sur Project lui-même.
        this.logger.warn(`ℹ️ [closeCampaign] aucun CampaignRun ouvert trouvé pour le projet ${projectId} — reconstitution de l'entrée d'historique à la clôture (campagne probablement lancée avant l'ajout de cette fonctionnalité).`);
        const launchedByUser = project.campaign_launched_by_id
          ? await this.prisma.user.findUnique({ where: { id: project.campaign_launched_by_id }, select: { name: true, email: true } })
          : null;
        await this.prisma.campaignRun.create({
          data: {
            project_id: projectId,
            launched_at: project.campaign_launched_at ?? snapshot.closed_at,
            launched_by_id: project.campaign_launched_by_id ?? null,
            launched_by_name: launchedByUser ? (launchedByUser.name || launchedByUser.email) : null,
            ...snapshot,
          },
        });
      }
    } catch (err: any) {
      this.logger.warn(`⚠️ [closeCampaign] échec écriture CampaignRun (historique) — avez-vous lancé "npx prisma generate" après l'ajout du modèle ? : ${err?.message}`);
    }

    return { project, applied, discarded, failed };
  }

  /**
   * Historique des campagnes CLÔTURÉES d'un projet (la campagne en cours,
   * s'il y en a une, est déjà couverte par getCampaignProgress — pas
   * dupliquée ici). Ne couvre que les campagnes lancées après l'introduction
   * de CampaignRun ; rien n'est reconstituable pour les clôtures antérieures.
   */
  async getCampaignHistory(projectId: string, accessCheck: { userId: string; isAdmin: boolean }) {
    await this._assertProjectMember(projectId, accessCheck);
    const runs = await this.prisma.campaignRun.findMany({
      where: { project_id: projectId, closed_at: { not: null } },
      orderBy: { launched_at: 'desc' },
    });
    return runs.map(r => ({
      id: r.id,
      launchedAt: r.launched_at,
      launchedBy: r.launched_by_name,
      closedAt: r.closed_at,
      closedBy: r.closed_by_name,
      progressPct: r.progress_pct ?? 0,
      testCases: { total: r.total_test_cases ?? 0, passed: r.passed_test_cases ?? 0, failed: r.failed_test_cases ?? 0 },
      appliedChangesCount: r.applied_changes_count ?? 0,
      discardedChangesCount: r.discarded_changes_count ?? 0,
      // Absents (undefined) pour une entrée clôturée avant l'ajout de ce
      // détail — le frontend retombe alors sur le résumé agrégé ci-dessus.
      failedTestCases: r.failed_test_cases_detail ?? null,
      workflows: r.workflows_detail ?? null,
    }));
  }

  private createLangfuseTrace(name: string, userId: string, metadata: Record<string, any>): any {
    return this.langfuseService.client.trace({
      name,
      userId,
      metadata,
    });
  }

  private createLangfuseGeneration(
    trace: any,
    name: string,
    model: string,
    prompt: string,
    metadata: Record<string, any>,
  ): any {
    const mergedMetadata: Record<string, any> = { ...(trace?.metadata || {}), ...(metadata || {}) };
    if (trace?.userId && mergedMetadata.userId == null) mergedMetadata.userId = trace.userId;
    if (mergedMetadata.sessionId == null && trace?.metadata?.sessionId) mergedMetadata.sessionId = trace.metadata.sessionId;
    if (mergedMetadata.env == null) mergedMetadata.env = process.env.NODE_ENV || 'development';
    return trace?.generation({
      name,
      model,
      input: [{ role: 'user', content: prompt }],
      metadata: mergedMetadata,
    });
  }

  private async acquireHistoryLock(key: string): Promise<() => void> {
    let state = this.historyLocks.get(key);
    if (!state) {
      state = { busy: false, queue: [] };
      this.historyLocks.set(key, state);
    }

    if (!state.busy) {
      state.busy = true;
      return () => this.releaseHistoryLock(key);
    }

    return new Promise<() => void>(resolve => {
      state!.queue.push(resolve);
    });
  }

  private releaseHistoryLock(key: string): void {
    const state = this.historyLocks.get(key);
    if (!state) return;

    const next = state.queue.shift();
    if (next) {
      next(() => this.releaseHistoryLock(key));
      return;
    }

    state.busy = false;
    if (state.queue.length === 0) {
      this.historyLocks.delete(key);
    }
  }

  // ── History ───────────────────────────────────────────────────────────────────

  public async addToHistory(
    projectId: string,
    requirementId: string,
    reqId: string,
    ...titles: string[]
  ): Promise<void> {
    if (!projectId || projectId === 'default' || titles.length === 0) return;
    const normalized = titles.map(t => t.toLowerCase().trim()).filter(t => t.length > 0);
    if (normalized.length === 0) return;
    const lockKey = `${projectId}:${requirementId}`;
    const releaseLock = await this.acquireHistoryLock(lockKey);

    try {
      // Retry sur deadlock Prisma (write conflict / transaction failed)
      const MAX_RETRIES = 5;
      const INITIAL_DELAY_MS = 100;
      const MAX_DELAY_MS = 2000;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          // Fetch existing record to avoid upsert conflicts
          let existing = await this.prisma.generationHistory.findUnique({
            where: { project_id_requirement_id: { project_id: projectId, requirement_id: requirementId } },
          });

          if (existing) {
            // Update: merge new titles avoiding duplicates
            const uniqueTitles = Array.from(new Set([...existing.titles, ...normalized]));
            await this.prisma.generationHistory.update({
              where: { project_id_requirement_id: { project_id: projectId, requirement_id: requirementId } },
              data: { titles: uniqueTitles },
            });
          } else {
            // Create new record
            await this.prisma.generationHistory.create({
              data: { project_id: projectId, requirement_id: requirementId, req_id: reqId, titles: normalized },
            });
          }
          return;
        } catch (err: any) {
          const isDeadlock = err.message?.includes('write conflict') || 
                            err.message?.includes('deadlock') ||
                            err.message?.includes('Transaction failed');
          
          if (isDeadlock && attempt < MAX_RETRIES) {
            // Exponential backoff with jitter
            const delayMs = Math.min(INITIAL_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 100, MAX_DELAY_MS);
            this.logger.debug(`⏳ [HISTORY] Retry attempt ${attempt}/${MAX_RETRIES} after ${Math.round(delayMs)}ms`);
            await new Promise(r => setTimeout(r, delayMs));
            continue;
          }
          
          this.logger.warn(`⚠️ [HISTORY] addToHistory failed (attempt ${attempt}/${MAX_RETRIES}): ${err.message}`);
          return;
        }
      }
    } finally {
      releaseLock();
    }
  }

  public async addTcToHistoryIndex(
    projectId: string,
    requirementId: string,
    reqId: string,
    tc: {
      testId: string; title: string; preconditions: string[];
      steps: string[]; testData: string[]; expectedResult: string;
      type: string; priority: string;
    },
  ): Promise<void> {
    if (!projectId || projectId === 'default') return;
    try {
      await this.mongoVector.addToHistoryIndex({
        testId: tc.testId, title: tc.title,
        preconditions: tc.preconditions ?? [], steps: tc.steps ?? [],
        testData: tc.testData ?? [], expectedResult: tc.expectedResult ?? '',
        type: tc.type, priority: tc.priority,
        requirementId, projectId, reqId,
      });
    } catch (err: any) {
      this.logger.warn(`⚠️ [HISTORY INDEX] failed: ${err.message}`);
    }
  }

  private async _getHistory(projectId: string, requirementId: string): Promise<string[]> {
    if (!projectId || projectId === 'default') return [];
    try {
      const doc = await this.prisma.generationHistory.findUnique({
        where: { project_id_requirement_id: { project_id: projectId, requirement_id: requirementId } },
      });
      return doc?.titles ?? [];
    } catch (err: any) {
      this.logger.warn(`⚠️ [HISTORY] _getHistory failed: ${err.message}`);
      return [];
    }
  }

  // ── CRUD Project / Requirements / TestCases ───────────────────────────────────

  /**
   * Garantit qu'aucun projet n'existe déjà avec ce nom (comparaison insensible
   * à la casse et aux espaces). `excludeProjectId` permet d'exclure le projet
   * courant lors d'un renommage. Lève une BadRequestException sinon.
   */
  async ensureUniqueProjectName(name: string, excludeProjectId?: string): Promise<void> {
    const trimmed = name.trim();
    const existing = await this.prisma.project.findFirst({
      where: {
        name: { equals: trimmed, mode: 'insensitive' },
        ...(excludeProjectId ? { id: { not: excludeProjectId } } : {}),
      },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException(`Un projet nommé « ${trimmed} » existe déjà. Choisissez un autre nom.`);
    }
  }

  async saveProject(name: string, requirements: RequirementsJson, sourceHash?: string) {
    await this.ensureUniqueProjectName(name);
    const project = await this.prisma.project.create({
      data: {
        name, document_type: requirements.document_type, source_hash: sourceHash,
        modules: {
          create: requirements.modules.map(mod => ({
            name: mod.name, description: mod.description,
            requirements: { create: mod.requirements.map(req => ({ req_id: req.id, description: req.description, priority: req.priority })) },
          })),
        },
      },
      include: { modules: { include: { requirements: true } } },
    });
    this.logger.log(`Project saved: ${project.id}`);
    return project;
  }

  async saveTestCases(projectId: string, result: TestCaseGenerationResult): Promise<void> {
    for (const mod of result.modules) {
      const moduleEntity = await this.prisma.requirementModule.findFirst({
        where: { project_id: projectId, name: mod.name },
      });
      if (!moduleEntity) continue;
      for (const req of mod.requirements) {
        const reqEntity = await this.prisma.requirement.findFirst({
          where: { module_id: moduleEntity.id, req_id: req.id },
        });
        if (!reqEntity) continue;
        for (const tc of req.test_cases) {
          await this.prisma.testCase.create({
            data: {
              test_id: tc.testId, title: tc.title, preconditions: tc.preconditions,
              steps: tc.steps,
              test_data: Array.isArray((tc as any).testData) ? (tc as any).testData : [],
              expected_result: tc.expectedResult, type: tc.type, priority: tc.priority,
              requirement_id: reqEntity.id,
            },
          });
        }
      }
    }
  }

  async createAndValidateTestCase(
    requirementUuid: string,
    tc: {
      testId: string; title: string; preconditions: string[];
      steps: string[]; testData: string[]; expectedResult: string;
      type: string; priority: string; validated?: boolean; needsReview?: boolean;
      manuallyEdited?: boolean;
    },
    actor?: VersionActor,
  ): Promise<TestCase | CampaignPendingResult> {
    const parentReq = await this.prisma.requirement.findUniqueOrThrow({ where: { id: requirementUuid } });
    const projectId = await this.getProjectIdForModule(parentReq.module_id);
    const queued = await this.queueIfCampaignActive({
      projectId, method: 'createAndValidateTestCase', args: [requirementUuid, tc, actor],
      entityType: 'test_case', entityId: null,
      label: `Créer le cas de test « ${tc.testId} » sur ${parentReq.req_id}`, actor,
    });
    if (queued) return queued as any;
    const validated = typeof (tc as any).validated === 'boolean' ? (tc as any).validated : true;
    const needsReview = typeof (tc as any).needsReview === 'boolean' ? (tc as any).needsReview : false;
    // true = tapé à la main dans le formulaire "+ Nouveau TC" ; false/absent
    // = candidat généré par le LLM qu'on est en train de valider (persister).
    // Sert uniquement à distinguer les deux messages dans le fil d'activité
    // (voir buildActivityLog côté controller) — comportement métier inchangé.
    const manuallyEdited = typeof (tc as any).manuallyEdited === 'boolean' ? (tc as any).manuallyEdited : false;
    const saved = await this.prisma.testCase.create({
      data: {
        test_id: tc.testId, title: tc.title,
        preconditions: tc.preconditions ?? [], steps: tc.steps ?? [],
        test_data: tc.testData ?? [], expected_result: tc.expectedResult ?? '',
        type: this._normalizeType(tc.type), priority: this._normalizePriority(tc.priority),
        requirement_id: requirementUuid, validated, validated_at: new Date(), manually_edited: manuallyEdited,
        ...(needsReview ? { needs_review: true, needs_review_reason: 'Nouveau TC généré — en attente de relecture QA', needs_review_at: new Date() } : {}),
        review_status: validated ? 'validated' : 'pending',
        version: 1,
      },
    });
    const req = await this.prisma.requirement.findUnique({
      where: { id: requirementUuid },
      include: { module: { include: { project: true } } },
    });
    if (req) {
      const projectId = req.module?.project_id ?? 'default';
      await this.versionsService.recordVersionSafe({
        projectId,
        entityType: VERSIONED_ENTITY.TEST_CASE,
        entityId: saved.id,
        versionNumber: 1,
        snapshot: this._tcSnapshot(saved),
        changeType: 'create',
        changeSummary: manuallyEdited ? 'Création manuelle du cas de test' : 'Cas de test généré et validé',
        changedById: actor?.id ?? null,
        changedByName: actor?.name ?? null,
      });
      try {
        await this.mongoVector.addTestCase({
          testId: saved.test_id, title: saved.title, steps: saved.steps,
          requirementId: requirementUuid, moduleId: req.module?.name ?? '', projectId,
          preconditions: saved.preconditions, testData: saved.test_data,
          expectedResult: saved.expected_result ?? '', type: saved.type, priority: saved.priority,
        });
      } catch (embErr: any) {
        this.logger.warn(`⚠️ Embedding failed for ${saved.test_id}: ${embErr.message}`);
      }
      await this.addToHistory(projectId, requirementUuid, req.req_id, saved.title);
    }
    return saved;
  }

  /**
   * Autosave invisible des TC générés mais pas encore validés (voir commentaire
   * sur Requirement.pending_test_cases). Écrase l'instantané précédent — le
   * front renvoie systématiquement l'état courant complet des TC en attente
   * pour ce requirement, ce qui nettoie naturellement les TC validés/rejetés
   * entre-temps sans logique de synchronisation dédiée.
   */
  async savePendingTestCases(requirementId: string, testCases: any[]): Promise<void> {
    // Le front peut avoir un état périmé (course entre 2 utilisateurs qui
    // travaillent sur le même requirement) : un TC tout juste validé par
    // l'un peut encore apparaître comme "en attente" dans l'autosave de
    // l'autre, encore en train de lire l'ancien state. On ne fait donc pas
    // confiance à ce que le front envoie tel quel — on exclut nous-mêmes
    // tout testId qui correspond déjà à un TC réellement persisté pour ce
    // requirement, ce qui empêche la duplication persisted+pending qui
    // faisait grossir indéfiniment les suffixes de deduplicateTestIds
    // (TC-X → TC-Xb → TC-Xbb ...) à chaque cycle de rafraîchissement.
    const persisted = await this.prisma.testCase.findMany({
      where: { requirement_id: requirementId },
      select: { test_id: true },
    });
    const persistedIds = new Set(persisted.map(tc => tc.test_id));
    const clean = (testCases ?? []).filter(tc => !persistedIds.has(tc.testId));
    await this.prisma.requirement.update({
      where: { id: requirementId },
      data: { pending_test_cases: clean },
    });
  }

  /**
   * Retire IMMÉDIATEMENT un TC "en attente" (jamais persisté en DB) de
   * Requirement.pending_test_cases — utilisé par le rejet d'un TC en attente
   * (voir ProjectController.rejectPendingTestCase).
   *
   * Avant ce correctif, le rejet d'un TC en attente ne faisait QUE le retirer
   * de l'état local côté front, en comptant sur l'autosave débouncée à 900ms
   * (savePendingTestCases ci-dessus) pour répercuter la suppression en base.
   * Ça créait une course : un `activity:new` (déclenché par la journalisation
   * du rejet, diffusé même à son propre auteur) pouvait provoquer un refresh
   * projet côté front AVANT que cette autosave n'ait eu le temps de partir,
   * rechargeant alors un `pending_test_cases` encore périmé qui CONTENAIT
   * TOUJOURS le TC — le faisant réapparaître, et annulant au passage le
   * timer de sauvegarde en attente (le rejet n'était donc jamais persisté du
   * premier coup). En committant le retrait en base de façon synchrone dès
   * le rejet, un refresh concurrent — quelle qu'en soit l'origine — ne peut
   * plus jamais faire réapparaître un TC déjà rejeté.
   */
  async removePendingTestCase(requirementId: string, testId: string): Promise<void> {
    if (!testId) return;
    const req = await this.prisma.requirement.findUnique({
      where: { id: requirementId },
      select: { pending_test_cases: true },
    });
    const current = (req?.pending_test_cases as any[]) ?? [];
    const filtered = current.filter((tc: any) => tc?.testId !== testId);
    if (filtered.length === current.length) return; // rien à retirer
    await this.prisma.requirement.update({
      where: { id: requirementId },
      data: { pending_test_cases: filtered },
    });
  }

  async deleteTestCase(id: string, actor?: VersionActor): Promise<void | CampaignPendingResult> {
    const existing = await this.prisma.testCase.findUnique({ where: { id } });
    if (!existing) return;
    const projectId = await this.getProjectIdForTestCase(id);
    const queued = await this.queueIfCampaignActive({
      projectId, method: 'deleteTestCase', args: [id, actor],
      entityType: 'test_case', entityId: id,
      label: `Supprimer le cas de test « ${existing.test_id} »`, actor,
    });
    if (queued) return queued;
    const deleted = await this.prisma.testCase.delete({ where: { id } });
    this.logger.log(`✅ [deleteTestCase] Deleted TC: ${deleted.test_id}`);
    await this.cacheService.invalidateByPrefix('step2:');
  }

  async editRequirement(
    id: string,
    dto: Partial<{ req_id: string; description: string; priority: string }>,
    expectedUpdatedAt?: string | Date,
    actor?: VersionActor,
  ): Promise<any> {
    const existing = await this.prisma.requirement.findUniqueOrThrow({ where: { id } });
    const guardProjectId = await this.getProjectIdForModule(existing.module_id);
    const queued = await this.queueIfCampaignActive({
      projectId: guardProjectId, method: 'editRequirement', args: [id, dto, expectedUpdatedAt, actor],
      entityType: 'requirement', entityId: id,
      label: `Modifier l'exigence « ${existing.req_id} »`, actor,
    });
    if (queued) return queued;

    // ── Verrou optimiste ────────────────────────────────────────────────────
    // `expectedUpdatedAt` est facultatif (rétrocompatible avec tout appelant
    // qui ne le fournit pas, ex: acknowledgeRequirementReview/revertRequirementEdit
    // qui ne passent pas par cette vérification). Quand il est fourni et ne
    // correspond plus à `updated_at` en base, quelqu'un d'autre a sauvegardé
    // cette exigence depuis que ce client l'a chargée — on refuse d'écraser
    // silencieusement son travail (voir RequirementConflictError).
    if (expectedUpdatedAt) {
      const expected = new Date(expectedUpdatedAt).getTime();
      if (!Number.isNaN(expected) && expected !== existing.updated_at.getTime()) {
        throw new RequirementConflictError(existing);
      }
    }

    // ── Historisation ─────────────────────────────────────────────────────
    // Snapshot de l'état AVANT modification, archivé sous le numéro de
    // version courant de l'entité — la nouvelle version (après update)
    // portera `version + 1`. Best-effort : ne bloque jamais la sauvegarde.
    const currentVersion = existing.version ?? 1;
    const projectId = await this.getProjectIdForModule(existing.module_id);
    const beforeSnapshot = { req_id: existing.req_id, description: existing.description, priority: existing.priority };
    if (projectId) {
      await this.versionsService.recordVersionSafe({
        projectId,
        entityType: VERSIONED_ENTITY.REQUIREMENT,
        entityId: id,
        versionNumber: currentVersion,
        snapshot: beforeSnapshot,
        changeType: 'update',
        changeSummary: summarizeChanges(beforeSnapshot, dto),
        changedById: actor?.id ?? null,
        changedByName: actor?.name ?? null,
      });
    }

    const updated = await this.prisma.requirement.update({ where: { id }, data: { ...dto, manually_edited: true, version: currentVersion + 1 } });

    const oldDesc = existing.description?.trim();
    const newDesc = dto.description?.trim();

    // Pas de changement de description (seule la priorité/l'id a changé) → pas d'analyse d'impact
    if (!newDesc || newDesc === oldDesc) return updated;

    const impact = await this._runImpactAnalysis(updated, oldDesc, newDesc);
    return { ...updated, impact };
  }

  /**
   * Analyse d'impact sémantique déclenchée après l'édition d'une exigence.
   * 1) Compare ancienne/nouvelle description → si le changement est significatif :
   * 2) Marque les TC de l'exigence éditée "à réviser"
   * 3) Détecte les autres exigences du même projet sémantiquement couplées
   *    (ancienne ou nouvelle description) et marque leurs TC "à réviser" aussi.
   * Best-effort : si Ollama est indisponible, l'édition reste appliquée mais
   * sans analyse d'impact (pas d'erreur bloquante pour le BA).
   */
  private async _runImpactAnalysis(requirement: Requirement, oldDesc: string, newDesc: string): Promise<ImpactResult> {
    try {
      const [oldVec, newVec] = await Promise.all([
        this.embeddingService.embed(oldDesc, 'document'),
        this.embeddingService.embed(newDesc, 'document'),
      ]);
      const similarity = cosineSimilarity(oldVec, newVec);

      await this.prisma.requirement.update({
        where: { id: requirement.id },
        data: { last_edit_similarity: similarity, last_edit_at: new Date() },
      });

      if (similarity >= IMPACT_CHANGE_THRESHOLD) {
        // Reformulation mineure — pas d'impact sur les TC existants
        return { changed: false, similarity, testCasesFlagged: 0, impactedRequirements: [] };
      }

      const reason = `Ampleur du changement : ~${Math.round((1 - similarity) * 100)}%`;
      const ownTestCaseIds = (await this.prisma.testCase.findMany({ where: { requirement_id: requirement.id }, select: { id: true } })).map(t => t.id);
      const flaggedTestCaseIds: string[] = [...ownTestCaseIds];
      const [own, impactedRequirements] = await Promise.all([
        this.prisma.testCase.updateMany({
          where: { requirement_id: requirement.id },
          data: { needs_review: true, needs_review_reason: reason, needs_review_at: new Date() },
        }),
        this._flagCoupledRequirements(requirement, oldVec, newVec, flaggedTestCaseIds),
      ]);

      const testCasesFlagged = own.count + impactedRequirements.reduce((s, r) => s + r.testCasesFlagged, 0);
      this.logger.log(`🎯 [IMPACT] ${requirement.req_id} — similarité ${similarity.toFixed(3)} — ${testCasesFlagged} TC marqués à réviser (${impactedRequirements.length} exigence(s) couplée(s))`);
      await this.cacheService.invalidateByPrefix('step2:');

      // Un TC marqué "à réviser" peut être utilisé dans une étape d'un workflow
      // déjà validé — celui-ci repasse alors en brouillon et son créateur (BA)
      // est notifié, plutôt que de le laisser croire que son workflow reste
      // fiable alors qu'une de ses étapes s'appuie désormais sur un cas de
      // test potentiellement obsolète. Best-effort (jamais bloquant).
      this._flagWorkflowsForTestCases(flaggedTestCaseIds, `dont l'exigence associée a été modifiée (${reason})`).catch(() => { /* best-effort */ });

      return { changed: true, similarity, testCasesFlagged, impactedRequirements };
    } catch (err: any) {
      this.logger.warn(`⚠️ [IMPACT] Analyse d'impact impossible pour ${requirement.req_id}: ${err.message}`);
      return { changed: false, similarity: null, testCasesFlagged: 0, impactedRequirements: [] };
    }
  }

  /**
   * Repasse en brouillon (et notifie leur créateur) tous les workflows de
   * test VALIDÉS qui contiennent une étape référençant l'un des cas de test
   * donnés — appelé quand un cas de test est modifié directement (editTestCase)
   * ou marqué "à réviser" suite à une analyse d'impact (exigence modifiée /
   * exigence sémantiquement couplée modifiée). Best-effort total : ne doit
   * jamais faire échouer l'action métier appelante (édition d'exigence/TC).
   */
  private async _flagWorkflowsForTestCases(testCaseIds: string[], reason: string): Promise<void> {
    if (testCaseIds.length === 0) return;
    try {
      const testCases = await this.prisma.testCase.findMany({
        where: { id: { in: testCaseIds } },
        select: { id: true, title: true, requirement: { select: { module: { select: { project_id: true } } } } },
      });
      this.logger.log(`🔎 [IMPACT→workflow] ${testCaseIds.length} TC à vérifier, ${testCases.length} trouvé(s) en base`);
      if (testCases.length === 0) return;

      const tcIdsByProject = new Map<string, Set<string>>();
      const titleById = new Map<string, string>();
      for (const tc of testCases) {
        const projectId = tc.requirement?.module?.project_id;
        if (!projectId) continue;
        if (!tcIdsByProject.has(projectId)) tcIdsByProject.set(projectId, new Set());
        tcIdsByProject.get(projectId)!.add(tc.id);
        titleById.set(tc.id, tc.title);
      }

      for (const [projectId, tcIdSet] of tcIdsByProject) {
        const workflows = await this.prisma.testWorkflow.findMany({
          where: { project_id: projectId, is_validated: true },
        });
        this.logger.log(`🔎 [IMPACT→workflow] Projet ${projectId} : ${workflows.length} workflow(s) validé(s) à vérifier contre ${tcIdSet.size} TC`);

        for (const wf of workflows) {
          const nodes = (wf.nodes as any[]) ?? [];
          const affectedNode = nodes.find(n => n?.data?.testCaseId && tcIdSet.has(n.data.testCaseId as string));
          if (!affectedNode) continue;

          await this.prisma.testWorkflow.update({
            where: { id: wf.id },
            data: { is_validated: false, validated_at: null, validated_by_id: null },
          });

          if (wf.created_by_id) {
            const tcTitle = titleById.get(affectedNode.data.testCaseId as string) || 'un cas de test';
            const stepLabel = affectedNode.data.label || tcTitle;
            // Notifie le créateur ET les BA assignés (assignedUserIds) — tous
            // peuvent désormais modifier/revalider ce workflow, donc tous
            // doivent savoir qu'une revalidation est nécessaire, pas
            // seulement le créateur d'origine.
            const recipientIds = Array.from(new Set([wf.created_by_id, ...((wf as any).assignedUserIds ?? [])]));
            this.logger.log(`🔔 [IMPACT→workflow] Notification à ${recipientIds.join(', ')} pour le workflow ${wf.id} (TC affecté: ${affectedNode.data.testCaseId})`);
            this.notificationsService.notifyMany(recipientIds, {
              type: 'workflow_activity',
              message: `Le workflow « ${wf.name} » repasse en brouillon : son étape « ${stepLabel} » s'appuie sur le cas de test « ${tcTitle} », ${reason}. Une revalidation est nécessaire.`,
              projectId,
              entityType: 'workflow',
              entityId: wf.id,
              link: `/analyzer?projectId=${projectId}&view=workflow&workflowId=${wf.id}`,
            })
              .then(() => this.logger.log(`✅ [IMPACT→workflow] Notification(s) envoyée(s) à ${recipientIds.length} destinataire(s)`))
              .catch((err) => this.logger.error(`❌ [IMPACT→workflow] Échec de la notification: ${err?.message || err}`));
          } else {
            this.logger.warn(`⚠️ [IMPACT→workflow] Workflow ${wf.id} sans created_by_id — impossible de notifier`);
          }

          try {
            this.notificationsGateway.emitToProject(projectId, 'workflow:updated', { workflowId: wf.id });
          } catch { /* diffusion temps réel best-effort, pas critique ici */ }
        }
      }
    } catch (err: any) {
      this.logger.warn(`⚠️ [IMPACT→workflow] Vérification d'impact sur les workflows échouée: ${err.message}`);
    }
  }

  /**
   * Recherche, dans le même projet, les autres exigences sémantiquement couplées
   * à l'exigence éditée (score cosinus ≥ IMPACT_COUPLING_THRESHOLD, comparé à la
   * fois à l'ancienne et à la nouvelle description — le lien peut préexister à
   * l'édition ou être introduit par elle) et marque leurs TC "à réviser".
   */
  private async _flagCoupledRequirements(editedRequirement: Requirement, oldVec: number[], newVec: number[], flaggedTestCaseIds: string[] = []): Promise<ImpactedRequirement[]> {
    const module = await this.prisma.requirementModule.findUnique({ where: { id: editedRequirement.module_id } });
    if (!module) return [];

    const others = await this.prisma.requirement.findMany({
      where: { id: { not: editedRequirement.id }, module: { project_id: module.project_id } },
    });
    if (others.length === 0) return [];

    const results: ImpactedRequirement[] = [];
    const scored: string[] = [];
    for (const other of others) {
      const otherVec = await this.embeddingService.embed(other.description, 'document');
      const similarity = Math.max(cosineSimilarity(newVec, otherVec), cosineSimilarity(oldVec, otherVec));
      scored.push(`${other.req_id}=${similarity.toFixed(3)}`);
      if (similarity < IMPACT_COUPLING_THRESHOLD) continue;

      const reason = `Proximité avec l'exigence modifiée ${editedRequirement.req_id} : ~${Math.round(similarity * 100)}%`;
      const otherTestCaseIds = (await this.prisma.testCase.findMany({ where: { requirement_id: other.id }, select: { id: true } })).map(t => t.id);
      flaggedTestCaseIds.push(...otherTestCaseIds);
      const [, flagged] = await Promise.all([
        this.prisma.requirement.update({
          where: { id: other.id },
          data: { needs_review: true, needs_review_reason: reason, needs_review_at: new Date() },
        }),
        this.prisma.testCase.updateMany({
          where: { requirement_id: other.id },
          data: { needs_review: true, needs_review_reason: reason, needs_review_at: new Date() },
        }),
      ]);
      results.push({ id: other.id, req_id: other.req_id, similarity, testCasesFlagged: flagged.count });
    }
    // Diagnostic : scores de TOUS les candidats (seuil actuel = IMPACT_COUPLING_THRESHOLD),
    // pour calibrer le seuil sur des données réelles plutôt qu'à l'aveugle.
    this.logger.debug(`🧪 [IMPACT/coupling] ${editedRequirement.req_id} vs ${others.length} autres — seuil=${IMPACT_COUPLING_THRESHOLD} — scores: ${scored.join(', ')}`);
    return results;
  }

  /**
   * Lève automatiquement le flag "à réviser" d'une exigence dès qu'aucun de ses
   * TC n'est plus marqué needs_review (ex: le QA vient de traiter le dernier).
   * Appelé après editTestCase / validateTestCase / reviewTestCase.
   */
  private async _maybeAutoClearRequirementReview(requirementId: string): Promise<void> {
    const remaining = await this.prisma.testCase.count({ where: { requirement_id: requirementId, needs_review: true } });
    if (remaining === 0) {
      await this.prisma.requirement.updateMany({
        where: { id: requirementId, needs_review: true },
        data: { needs_review: false, needs_review_reason: null },
      });
    }
  }

  /**
   * Levée manuelle du flag "à réviser" sur une exigence (BA ou QA), sans passer
   * par ses TC individuellement — ex: le BA juge que l'impact ne concerne
   * finalement pas cette exigence couplée.
   */
  async acknowledgeRequirementReview(id: string, actor?: VersionActor): Promise<Requirement | CampaignPendingResult> {
    const existing = await this.prisma.requirement.findUniqueOrThrow({ where: { id } });
    const projectId = await this.getProjectIdForRequirement(id);
    const queued = await this.queueIfCampaignActive({
      projectId, method: 'acknowledgeRequirementReview', args: [id, actor],
      entityType: 'requirement', entityId: id,
      label: `Lever le flag "à réviser" de l'exigence « ${existing.req_id} »`, actor,
    });
    if (queued) return queued;
    return this.prisma.requirement.update({
      where: { id },
      data: { needs_review: false, needs_review_reason: null },
    });
  }

  /**
   * Annule la dernière édition d'une exigence suite à un impact détecté :
   * restaure l'ancienne description et lève les flags "à réviser" qui
   * venaient d'être posés par CETTE édition précise (ses propres TC + les
   * exigences couplées transmises par le front, telles que renvoyées par
   * _runImpactAnalysis juste avant). Alternative à "garder & réviser" dans
   * le modal d'impact — permet au BA de revenir en arrière sans avoir à
   * retaper l'ancienne description à la main.
   */
  async revertRequirementEdit(
    id: string,
    previousDescription: string,
    impactedRequirementIds: string[] = [],
    actor?: VersionActor,
  ): Promise<Requirement | CampaignPendingResult> {
    const existing = await this.prisma.requirement.findUniqueOrThrow({ where: { id } });
    const projectId = await this.getProjectIdForRequirement(id);
    const queued = await this.queueIfCampaignActive({
      projectId, method: 'revertRequirementEdit', args: [id, previousDescription, impactedRequirementIds, actor],
      entityType: 'requirement', entityId: id,
      label: `Annuler la dernière édition de l'exigence « ${existing.req_id} »`, actor,
    });
    if (queued) return queued;
    const reverted = await this.prisma.requirement.update({
      where: { id },
      data: {
        description: previousDescription,
        needs_review: false,
        needs_review_reason: null,
        last_edit_similarity: null,
        last_edit_at: null,
      },
    });

    await this.prisma.testCase.updateMany({
      where: { requirement_id: id, needs_review: true },
      data: { needs_review: false, needs_review_reason: null },
    });

    for (const reqId of impactedRequirementIds) {
      await this.prisma.requirement.updateMany({
        where: { id: reqId, needs_review: true },
        data: { needs_review: false, needs_review_reason: null },
      });
      await this.prisma.testCase.updateMany({
        where: { requirement_id: reqId, needs_review: true },
        data: { needs_review: false, needs_review_reason: null },
      });
    }

    await this.cacheService.invalidateByPrefix('step2:');
    this.logger.log(`↩️ [IMPACT] Édition annulée pour ${reverted.req_id} — retour à la version précédente`);
    return reverted;
  }

  /**
   * Levée manuelle du flag "à réviser" sur un TC (QA), sans changer son
   * review_status — symétrique de acknowledgeRequirementReview côté BA.
   * Lève aussi automatiquement le flag de l'exigence parente si c'était son
   * dernier TC encore marqué.
   */
  async acknowledgeTestCaseReview(id: string, actor?: VersionActor): Promise<TestCase | CampaignPendingResult> {
    const existing = await this.prisma.testCase.findUniqueOrThrow({ where: { id } });
    const projectId = await this.getProjectIdForTestCase(id);
    const queued = await this.queueIfCampaignActive({
      projectId, method: 'acknowledgeTestCaseReview', args: [id, actor],
      entityType: 'test_case', entityId: id,
      label: `Lever le flag "à réviser" du cas de test « ${existing.test_id} »`, actor,
    });
    if (queued) return queued;
    const updated = await this.prisma.testCase.update({
      where: { id },
      data: { needs_review: false, needs_review_reason: null },
    });
    await this._maybeAutoClearRequirementReview(updated.requirement_id);
    return updated;
  }

  // ── Module CRUD ────────────────────────────────────────────────────────────

  async createModule(projectId: string, dto: { name: string; description?: string }, actor?: VersionActor): Promise<any> {
    const queued = await this.queueIfCampaignActive({
      projectId, method: 'createModule', args: [projectId, dto, actor],
      entityType: 'requirement_module', entityId: null,
      label: `Créer le module « ${dto.name} »`, actor,
    });
    if (queued) return queued;
    await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const mod = await this.prisma.requirementModule.create({
      data: { name: dto.name.trim(), description: dto.description?.trim() ?? '', project_id: projectId, version: 1 },
      include: { requirements: true },
    });
    await this.versionsService.recordVersionSafe({
      projectId,
      entityType: VERSIONED_ENTITY.MODULE,
      entityId: mod.id,
      versionNumber: 1,
      snapshot: { name: mod.name, description: mod.description },
      changeType: 'create',
      changeSummary: 'Création du module',
      changedById: actor?.id ?? null,
      changedByName: actor?.name ?? null,
    });
    return mod;
  }

  async editModule(moduleId: string, dto: { name?: string; description?: string }, actor?: VersionActor): Promise<any> {
    const existing = await this.prisma.requirementModule.findUniqueOrThrow({ where: { id: moduleId } });
    const queued = await this.queueIfCampaignActive({
      projectId: existing.project_id, method: 'editModule', args: [moduleId, dto, actor],
      entityType: 'requirement_module', entityId: moduleId,
      label: `Modifier le module « ${existing.name} »`, actor,
    });
    if (queued) return queued;
    const data: any = {};
    if (dto.name !== undefined)        data.name        = dto.name.trim();
    if (dto.description !== undefined) data.description = dto.description.trim();

    const currentVersion = existing.version ?? 1;
    const beforeSnapshot = { name: existing.name, description: existing.description };
    await this.versionsService.recordVersionSafe({
      projectId: existing.project_id,
      entityType: VERSIONED_ENTITY.MODULE,
      entityId: moduleId,
      versionNumber: currentVersion,
      snapshot: beforeSnapshot,
      changeType: 'update',
      changeSummary: summarizeChanges(beforeSnapshot, data),
      changedById: actor?.id ?? null,
      changedByName: actor?.name ?? null,
    });
    data.version = currentVersion + 1;

    return this.prisma.requirementModule.update({ where: { id: moduleId }, data, include: { requirements: true } });
  }

  /**
   * Restaure une ancienne version d'un module (nom/description). Archive
   * l'état courant comme nouvelle entrée d'historique (change_type='restore')
   * avant d'écraser — pour ne jamais perdre de version même en cas de rollback.
   */
  async restoreModuleVersion(moduleId: string, versionId: string, actor?: VersionActor): Promise<any> {
    const existing = await this.prisma.requirementModule.findUniqueOrThrow({ where: { id: moduleId } });
    const queued = await this.queueIfCampaignActive({
      projectId: existing.project_id, method: 'restoreModuleVersion', args: [moduleId, versionId, actor],
      entityType: 'requirement_module', entityId: moduleId,
      label: `Restaurer une version du module « ${existing.name} »`, actor,
    });
    if (queued) return queued;
    const version = await this.versionsService.getVersion(VERSIONED_ENTITY.MODULE, moduleId, versionId);
    if (!version) throw new Error('Version introuvable pour ce module');

    const currentVersion = existing.version ?? 1;
    const snapshot = version.snapshot as { name?: string; description?: string };

    await this.versionsService.recordVersionSafe({
      projectId: existing.project_id,
      entityType: VERSIONED_ENTITY.MODULE,
      entityId: moduleId,
      versionNumber: currentVersion,
      snapshot: { name: existing.name, description: existing.description },
      changeType: 'restore',
      changeSummary: `Restauration de la version #${version.version_number}`,
      changedById: actor?.id ?? null,
      changedByName: actor?.name ?? null,
    });

    return this.prisma.requirementModule.update({
      where: { id: moduleId },
      data: {
        name: snapshot.name ?? existing.name,
        description: snapshot.description ?? existing.description,
        version: currentVersion + 1,
      },
      include: { requirements: true },
    });
  }

  async deleteModule(moduleId: string, actor?: VersionActor): Promise<void | CampaignPendingResult> {
    const existing = await this.prisma.requirementModule.findUniqueOrThrow({ where: { id: moduleId } });
    const queued = await this.queueIfCampaignActive({
      projectId: existing.project_id, method: 'deleteModule', args: [moduleId, actor],
      entityType: 'requirement_module', entityId: moduleId,
      label: `Supprimer le module « ${existing.name} »`, actor,
    });
    if (queued) return queued;
    // Cascade : requirements → test_cases supprimés par Prisma (onDelete: Cascade)
    await this.prisma.requirementModule.delete({ where: { id: moduleId } });
    await this.cacheService.invalidateByPrefix('step2:');
    await this.cacheService.invalidateByPrefix('step1:');
  }

  // ── Requirement CRUD ───────────────────────────────────────────────────────

  async createRequirement(moduleId: string, dto: { req_id: string; description: string; priority: string }, actor?: VersionActor): Promise<Requirement | CampaignPendingResult> {
    const module = await this.prisma.requirementModule.findUniqueOrThrow({ where: { id: moduleId } });
    const queued = await this.queueIfCampaignActive({
      projectId: module.project_id, method: 'createRequirement', args: [moduleId, dto, actor],
      entityType: 'requirement', entityId: null,
      label: `Créer l'exigence « ${dto.req_id} » dans ${module.name}`, actor,
    });
    if (queued) return queued as any;
    const created = await this.prisma.requirement.create({
      data: { req_id: dto.req_id.trim(), description: dto.description.trim(), priority: dto.priority, module_id: moduleId, manually_edited: true, version: 1 },
    });
    await this.versionsService.recordVersionSafe({
      projectId: module.project_id,
      entityType: VERSIONED_ENTITY.REQUIREMENT,
      entityId: created.id,
      versionNumber: 1,
      snapshot: { req_id: created.req_id, description: created.description, priority: created.priority },
      changeType: 'create',
      changeSummary: 'Création de l\'exigence',
      changedById: actor?.id ?? null,
      changedByName: actor?.name ?? null,
    });
    return created;
  }

  /** Restaure une ancienne version d'une exigence (id/description/priorité) — symétrique de restoreModuleVersion. */
  async restoreRequirementVersion(requirementId: string, versionId: string, actor?: VersionActor): Promise<Requirement | CampaignPendingResult> {
    const existing = await this.prisma.requirement.findUniqueOrThrow({ where: { id: requirementId } });
    const version = await this.versionsService.getVersion(VERSIONED_ENTITY.REQUIREMENT, requirementId, versionId);
    if (!version) throw new Error('Version introuvable pour cette exigence');

    const currentVersion = existing.version ?? 1;
    const snapshot = version.snapshot as { req_id?: string; description?: string; priority?: string };
    const projectId = await this.getProjectIdForModule(existing.module_id);
    const queued = await this.queueIfCampaignActive({
      projectId, method: 'restoreRequirementVersion', args: [requirementId, versionId, actor],
      entityType: 'requirement', entityId: requirementId,
      label: `Restaurer une version de l'exigence « ${existing.req_id} »`, actor,
    });
    if (queued) return queued as any;

    if (projectId) {
      await this.versionsService.recordVersionSafe({
        projectId,
        entityType: VERSIONED_ENTITY.REQUIREMENT,
        entityId: requirementId,
        versionNumber: currentVersion,
        snapshot: { req_id: existing.req_id, description: existing.description, priority: existing.priority },
        changeType: 'restore',
        changeSummary: `Restauration de la version #${version.version_number}`,
        changedById: actor?.id ?? null,
        changedByName: actor?.name ?? null,
      });
    }

    return this.prisma.requirement.update({
      where: { id: requirementId },
      data: {
        req_id: snapshot.req_id ?? existing.req_id,
        description: snapshot.description ?? existing.description,
        priority: snapshot.priority ?? existing.priority,
        manually_edited: true,
        version: currentVersion + 1,
      },
    });
  }

  async deleteRequirement(requirementId: string, actor?: VersionActor): Promise<void | CampaignPendingResult> {
    const existing = await this.prisma.requirement.findUniqueOrThrow({ where: { id: requirementId } });
    const projectId = await this.getProjectIdForRequirement(requirementId);
    const queued = await this.queueIfCampaignActive({
      projectId, method: 'deleteRequirement', args: [requirementId, actor],
      entityType: 'requirement', entityId: requirementId,
      label: `Supprimer l'exigence « ${existing.req_id} »`, actor,
    });
    if (queued) return queued;
    // Cascade : test_cases supprimés par Prisma (onDelete: Cascade)
    await this.prisma.requirement.delete({ where: { id: requirementId } });
    await this.cacheService.invalidateByPrefix('step2:');
  }

  /** Champs "de contenu" versionnés d'un TestCase — voir EntityVersion / VersionsService. */
  private _tcSnapshot(tc: { title: string; steps: string[]; preconditions: string[]; test_data: string[]; expected_result: string | null; type: string; priority: string }) {
    return { title: tc.title, steps: tc.steps, preconditions: tc.preconditions, test_data: tc.test_data, expected_result: tc.expected_result, type: tc.type, priority: tc.priority };
  }

  private async _recordTestCaseVersion(existing: TestCase, changeType: 'update' | 'restore', changeSummary: string, actor?: VersionActor): Promise<void> {
    const projectId = await this.getProjectIdForTestCase(existing.id);
    if (!projectId) return;
    await this.versionsService.recordVersionSafe({
      projectId,
      entityType: VERSIONED_ENTITY.TEST_CASE,
      entityId: existing.id,
      versionNumber: existing.version ?? 1,
      snapshot: this._tcSnapshot(existing),
      changeType,
      changeSummary,
      changedById: actor?.id ?? null,
      changedByName: actor?.name ?? null,
    });
  }

  async editTestCase(id: string, dto: Partial<{ title: string; steps: string[]; preconditions: string[]; test_data: string[]; expected_result: string; type: string; priority: string }>, actor?: VersionActor): Promise<TestCase | CampaignPendingResult> {
    const existing = await this.prisma.testCase.findUniqueOrThrow({ where: { id } });
    const projectId = await this.getProjectIdForTestCase(id);
    const queued = await this.queueIfCampaignActive({
      projectId, method: 'editTestCase', args: [id, dto, actor],
      entityType: 'test_case', entityId: id,
      label: `Modifier le cas de test « ${existing.test_id} »`, actor,
    });
    if (queued) return queued;
    const data: any = { ...dto, manually_edited: true, needs_review: false, needs_review_reason: null };
    if (dto.type !== undefined) data.type = this._normalizeType(dto.type);
    if (dto.priority !== undefined) data.priority = this._normalizePriority(dto.priority);

    await this._recordTestCaseVersion(existing, 'update', summarizeChanges(this._tcSnapshot(existing), data), actor);
    data.version = (existing.version ?? 1) + 1;

    const updated = await this.prisma.testCase.update({ where: { id }, data });
    await this._maybeAutoClearRequirementReview(updated.requirement_id);
    await this.cacheService.invalidateByPrefix('step2:');
    // Un workflow validé peut avoir une étape référençant ce cas de test —
    // son contenu (titre, étapes, résultat attendu...) vient de changer, donc
    // le workflow repasse en brouillon et son créateur (BA) est notifié.
    // Best-effort (jamais bloquant pour l'édition du TC elle-même).
    this._flagWorkflowsForTestCases([id], 'a été modifié').catch(() => { /* best-effort */ });
    return updated;
  }

  async validateTestCase(
    id: string, validated: boolean,
    dto?: Partial<{ title: string; steps: string[]; preconditions: string[]; test_data: string[]; expected_result: string; type: string; priority: string }>,
    actor?: VersionActor,
  ): Promise<TestCase | CampaignPendingResult> {
    const existing = await this.prisma.testCase.findUniqueOrThrow({ where: { id } });
    const projectId = await this.getProjectIdForTestCase(id);
    const queued = await this.queueIfCampaignActive({
      projectId, method: 'validateTestCase', args: [id, validated, dto, actor],
      entityType: 'test_case', entityId: id,
      label: `${validated ? 'Valider' : 'Dévalider'} le cas de test « ${existing.test_id} »`, actor,
    });
    if (queued) return queued;
    const data: any = { validated, validated_at: new Date(), review_status: validated ? 'validated' : 'pending', needs_review: false, needs_review_reason: null };
    if (dto && Object.keys(dto).length > 0) {
      Object.assign(data, { ...dto, manually_edited: true });
      if (dto.type !== undefined) data.type = this._normalizeType(dto.type);
      if (dto.priority !== undefined) data.priority = this._normalizePriority(dto.priority);
      // Seule une VRAIE modification de contenu (dto non vide) mérite une entrée
      // d'historique — valider/rejeter sans rien changer au texte du TC n'est
      // pas une "version" au sens du BA/QA qui consulte l'historique.
      await this._recordTestCaseVersion(existing, 'update', summarizeChanges(this._tcSnapshot(existing), data), actor);
      data.version = (existing.version ?? 1) + 1;
    }
    const updated = await this.prisma.testCase.update({ where: { id }, data });
    await this._maybeAutoClearRequirementReview(updated.requirement_id);
    await this.cacheService.invalidateByPrefix('step2:');
    return updated;
  }

  /** Restaure une ancienne version d'un TC (contenu uniquement — ne touche pas au statut de revue). */
  async restoreTestCaseVersion(testCaseId: string, versionId: string, actor?: VersionActor): Promise<TestCase | CampaignPendingResult> {
    const existing = await this.prisma.testCase.findUniqueOrThrow({ where: { id: testCaseId } });
    const projectId = await this.getProjectIdForTestCase(testCaseId);
    const queued = await this.queueIfCampaignActive({
      projectId, method: 'restoreTestCaseVersion', args: [testCaseId, versionId, actor],
      entityType: 'test_case', entityId: testCaseId,
      label: `Restaurer une version du cas de test « ${existing.test_id} »`, actor,
    });
    if (queued) return queued;
    const version = await this.versionsService.getVersion(VERSIONED_ENTITY.TEST_CASE, testCaseId, versionId);
    if (!version) throw new Error('Version introuvable pour ce cas de test');

    await this._recordTestCaseVersion(existing, 'restore', `Restauration de la version #${version.version_number}`, actor);

    const snapshot = version.snapshot as Partial<ReturnType<ProjectService['_tcSnapshot']>>;
    const updated = await this.prisma.testCase.update({
      where: { id: testCaseId },
      data: {
        title: snapshot.title ?? existing.title,
        steps: snapshot.steps ?? existing.steps,
        preconditions: snapshot.preconditions ?? existing.preconditions,
        test_data: snapshot.test_data ?? existing.test_data,
        expected_result: snapshot.expected_result ?? existing.expected_result,
        type: snapshot.type ?? existing.type,
        priority: snapshot.priority ?? existing.priority,
        manually_edited: true,
        version: (existing.version ?? 1) + 1,
      },
    });
    await this.cacheService.invalidateByPrefix('step2:');
    return updated;
  }

  /**
   * Dispatch générique de restauration utilisé par le contrôleur pour les 3
   * types d'entités possédés par ProjectService (le workflow a son propre
   * dispatch dans WorkflowController, car porté par WorkflowService).
   */
  async restoreEntityVersion(entityType: 'requirement_module' | 'requirement' | 'test_case', entityId: string, versionId: string, actor?: VersionActor): Promise<any> {
    switch (entityType) {
      case 'requirement_module': return this.restoreModuleVersion(entityId, versionId, actor);
      case 'requirement':        return this.restoreRequirementVersion(entityId, versionId, actor);
      case 'test_case':          return this.restoreTestCaseVersion(entityId, versionId, actor);
    }
  }

  /**
   * Fait passer un test case par le workflow de revue QA persistant.
   * status: 'validated' | 'rejected' | 'pending'
   * — 'rejected' ne supprime PAS le TC (contrairement à deleteTestCase),
   *   il reste en base pour traçabilité/audit.
   */
  async reviewTestCase(id: string, status: 'validated' | 'rejected' | 'pending', actor?: VersionActor): Promise<TestCase | CampaignPendingResult> {
    const existing = await this.prisma.testCase.findUniqueOrThrow({ where: { id } });
    const projectId = await this.getProjectIdForTestCase(id);
    const queued = await this.queueIfCampaignActive({
      projectId, method: 'reviewTestCase', args: [id, status, actor],
      entityType: 'test_case', entityId: id,
      label: `Faire passer le cas de test « ${existing.test_id} » en "${status}"`, actor,
    });
    if (queued) return queued;
    const data: any = { review_status: status, needs_review: false, needs_review_reason: null };
    if (status === 'validated') {
      data.validated = true;
      data.validated_at = new Date();
      data.rejected_at = null;
    } else if (status === 'rejected') {
      data.validated = false;
      data.rejected_at = new Date();
    } else {
      data.validated = false;
      data.validated_at = null;
      data.rejected_at = null;
    }
    const updated = await this.prisma.testCase.update({ where: { id }, data });
    await this._maybeAutoClearRequirementReview(updated.requirement_id);
    await this.cacheService.invalidateByPrefix('step2:');
    return updated;
  }

  async validateAllTestCasesForRequirement(requirementUuid: string, validated: boolean, actor?: VersionActor): Promise<{ count: number } | CampaignPendingResult> {
    const existing = await this.prisma.requirement.findUniqueOrThrow({ where: { id: requirementUuid } });
    const projectId = await this.getProjectIdForRequirement(requirementUuid);
    const queued = await this.queueIfCampaignActive({
      projectId, method: 'validateAllTestCasesForRequirement', args: [requirementUuid, validated, actor],
      entityType: 'requirement', entityId: requirementUuid,
      label: `${validated ? 'Valider' : 'Dévalider'} tous les cas de test de l'exigence « ${existing.req_id} »`, actor,
    });
    if (queued) return queued;
    const result = await this.prisma.testCase.updateMany({
      where: { requirement_id: requirementUuid },
      data: { validated, validated_at: new Date(), review_status: validated ? 'validated' : 'pending' },
    });
    await this.cacheService.invalidateByPrefix('step2:');
    return { count: result.count };
  }

  async deleteAllTestCasesForRequirement(requirementUuid: string, actor?: VersionActor): Promise<{ count: number } | CampaignPendingResult> {
    const existing = await this.prisma.requirement.findUniqueOrThrow({ where: { id: requirementUuid } });
    const projectId = await this.getProjectIdForRequirement(requirementUuid);
    const queued = await this.queueIfCampaignActive({
      projectId, method: 'deleteAllTestCasesForRequirement', args: [requirementUuid, actor],
      entityType: 'requirement', entityId: requirementUuid,
      label: `Supprimer tous les cas de test de l'exigence « ${existing.req_id} »`, actor,
    });
    if (queued) return queued;
    const result = await this.prisma.testCase.deleteMany({ where: { requirement_id: requirementUuid } });
    await this.prisma.generationHistoryEntry.deleteMany({ where: { requirement_id: requirementUuid } });
    await this.cacheService.invalidateByPrefix('step2:');
    return { count: result.count };
  }

  /**
   * @param accessCheck Si fourni, vérifie que l'utilisateur est propriétaire
   *                    du projet (ou Admin). Omis pour les appels internes
   *                    (ex: cache hit dans LlmController) qui ont déjà
   *                    validé l'accès en amont.
   */
  // Select explicite excluant `embedding` (768 floats/doc sur Requirement ET
  // TestCase, jamais utilisé côté front — uniquement pour la recherche
  // vectorielle interne). Sur un projet avec ~35 exigences + 100+ TC, inclure
  // ces vecteurs revenait à sérialiser/parser ~100 000 nombres à chaque
  // chargement ET chaque refresh — cause principale de lenteur perçue.
  private readonly _projectSelect = {
    modules: {
      include: {
        requirements: {
          select: {
            id: true, req_id: true, description: true, priority: true, module_id: true,
            manually_edited: true,
            last_edit_similarity: true, last_edit_at: true,
            needs_review: true, needs_review_reason: true, needs_review_at: true,
            pending_test_cases: true,
            created_at: true, updated_at: true,
            jira_project_key: true, jira_story_key: true, jira_story_url: true,
            test_cases: {
              select: {
                id: true, test_id: true, title: true, preconditions: true, steps: true,
                test_data: true, expected_result: true, type: true, priority: true, requirement_id: true,
                validated: true, validated_at: true, manually_edited: true,
                review_status: true, rejected_at: true,
                needs_review: true, needs_review_reason: true, needs_review_at: true,
                jira_issue_key: true, jira_issue_url: true, jira_project_key: true, jira_exported_at: true,
                // Résultat d'exécution QA (bouton Réussi/Échoué sur la carte du TC) —
                // manquait ici : GET /projects/:id (donc refreshCurrentProject côté
                // frontend) retombait toujours sur 'not_tested' après un refetch,
                // même juste après avoir marqué un TC, car ce champ n'était jamais
                // remonté par cette requête (seul le PATCH .../execution le renvoyait).
                execution_status: true, executed_at: true, executed_by_id: true,
                created_at: true, updated_at: true,
              },
            },
          },
        },
      },
    },
    owner: { select: { id: true, name: true, email: true, role: true } },
    assignedUsers: { select: { id: true, name: true, email: true, role: true } },
  } as const;

  async getProject(
    id: string,
    accessCheck?: { userId: string; isAdmin: boolean },
  ): Promise<Project> {
    const project = await this.prisma.project.findUniqueOrThrow({
      where:   { id },
      include: this._projectSelect,
    });

    if (accessCheck && !accessCheck.isAdmin && (project as any).owner_id) {
      const isOwner = (project as any).owner_id === accessCheck.userId;
      const isAssigned = ((project as any).assignedUserIds || []).includes(accessCheck.userId);
      if (!isOwner && !isAssigned) {
        throw new ForbiddenException("Vous n'avez pas accès à ce projet");
      }
    }

    return project;
  }

  async listProjects(accessCheck?: { userId: string; isAdmin: boolean }): Promise<Project[]> {
    const where = accessCheck && !accessCheck.isAdmin
      ? { OR: [{ owner_id: accessCheck.userId }, { assignedUserIds: { has: accessCheck.userId } }] }
      : {};
    return this.prisma.project.findMany({
      where,
      orderBy: { created_at: 'desc' },
      include: this._projectSelect,
    });
  }

  /**
   * Remplace la liste des utilisateurs assignés à un projet (collaborateurs).
   * Seul le propriétaire du projet ou un Admin peut gérer cette liste.
   */
  async setAssignedUsers(
    projectId: string,
    userIds: string[],
    accessCheck?: { userId: string; isAdmin: boolean },
  ): Promise<Project> {
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } });

    if (accessCheck && !accessCheck.isAdmin && (project as any).owner_id !== accessCheck.userId) {
      throw new ForbiddenException(
        "Seul le propriétaire du projet ou un Admin peut gérer les utilisateurs assignés",
      );
    }

    // Dédoublonne et retire l'éventuel propriétaire de la liste des "assignés"
    // (il a déjà accès via owner_id, pas besoin de le dupliquer).
    const uniqueIds = Array.from(new Set(userIds)).filter(uid => uid !== (project as any).owner_id);

    return this.prisma.project.update({
      where: { id: projectId },
      data: { assignedUserIds: { set: uniqueIds } },
      include: {
        owner: { select: { id: true, name: true, email: true, role: true } },
        assignedUsers: { select: { id: true, name: true, email: true, role: true } },
      },
    });
  }

  async renameProject(
    id: string,
    name: string,
    accessCheck?: { userId: string; isAdmin: boolean },
  ): Promise<Project> {
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id } });

    if (accessCheck && !accessCheck.isAdmin) {
      const isOwner = (project as any).owner_id === accessCheck.userId;
      const isAssigned = ((project as any).assignedUserIds || []).includes(accessCheck.userId);
      if (!isOwner && !isAssigned) {
        throw new ForbiddenException("Vous n'avez pas accès à ce projet");
      }
    }

    await this.ensureUniqueProjectName(name, id);

    return this.prisma.project.update({
      where: { id },
      data: { name: name.trim() },
      include: {
        owner: { select: { id: true, name: true, email: true, role: true } },
        assignedUsers: { select: { id: true, name: true, email: true, role: true } },
      },
    });
  }

  /**
   * Épingler / désépingler un projet — propre à chaque utilisateur (ADMIN, BA, QA),
   * stocké sur User.pinnedProjectIds. Ne modifie pas le projet lui-même.
   */
  async pinProject(userId: string, projectId: string): Promise<string[]> {
    await this.prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { id: true } });
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { pinnedProjectIds: true },
    });
    if (user.pinnedProjectIds.includes(projectId)) return user.pinnedProjectIds;
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { pinnedProjectIds: { push: projectId } },
      select: { pinnedProjectIds: true },
    });
    return updated.pinnedProjectIds;
  }

  async unpinProject(userId: string, projectId: string): Promise<string[]> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { pinnedProjectIds: true },
    });
    const filtered = user.pinnedProjectIds.filter(id => id !== projectId);
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { pinnedProjectIds: { set: filtered } },
      select: { pinnedProjectIds: true },
    });
    return updated.pinnedProjectIds;
  }

  async createEmptyProject(
    name: string,
    userId: string,
  ): Promise<Project> {
    await this.ensureUniqueProjectName(name);
    return this.prisma.project.create({
      data: {
        name: name.trim(),
        status: 'done',
        owner_id: userId,
      },
      include: {
        owner: { select: { id: true, name: true, email: true, role: true } },
        assignedUsers: { select: { id: true, name: true, email: true, role: true } },
      },
    });
  }

  async deleteProject(
    id: string,
    accessCheck?: { userId: string; isAdmin: boolean },
  ): Promise<void> {
    if (accessCheck) {
      await this.getProject(id, accessCheck); // lève ForbiddenException si pas le propriétaire/Admin
    }
    await this.prisma.project.delete({ where: { id } });
    await this.srsService.clearProjectSrs(id);
    await this.cacheService.invalidateByPrefix('analysis:');
    await this.cacheService.invalidateByPrefix('step1:');
    await this.cacheService.invalidateByPrefix('step2:');
  }

  // ── LLM calls (délèguent au client partagé) ───────────────────────────────────

  private async _callLlm(
    prompt: string,
    model: string,
    ollamaUrl: string,
    options: OllamaOptions = PHASE_B_OPTIONS,
    langfuseGeneration?: any,
  ): Promise<any> {
    return callOllamaAndParse(
      ollamaUrl, model, prompt, undefined,
      'You are a JSON API. Output ONLY raw valid JSON. No prose, no markdown, no <think> tags.',
      options, this.LLM_CALL_TIMEOUT_MS, langfuseGeneration,
    );
  }

  // ── Phase A ───────────────────────────────────────────────────────────────────

  private async _runPhaseA(
    moduleName: string,
    req: { id: string; description: string; priority: string },
    model: string,
    ollamaUrl: string,
    instruction?: string,
    existingTCs: ExistingTC[] = [],
    langfuseTrace?: any,
    options: OllamaOptions = PHASE_A_OPTIONS, // défaut inchangé pour ne rien casser côté génération classique
  ): Promise<RegenAngle[]> {
    try {
      const prompt = await buildPhaseAPrompt(moduleName, req, instruction, existingTCs);
      const generation = this.createLangfuseGeneration(langfuseTrace, 'phase-a-test-case', model, prompt, {
        requirementId: req.id,
        moduleName,
      });
      const parsed = await this._callLlm(prompt, model, ollamaUrl, options, generation);
      if (Array.isArray(parsed?.angles)) {
        const angles: RegenAngle[] = parsed.angles
          .filter((a: any) => typeof a.focus === 'string' && a.focus.trim().length > 10)
          .slice(0, 12)
.map((a: any) => ({ focus: a.focus.trim(), tcType: a.type?.trim() }));
        if (angles.length >= 3) return angles;
      }
    } catch (err: any) {
      this.logger.warn(`⚠️ [Phase A] failed for ${req.id}: ${err.message}`);
    }
    return [];
  }

  // ── Phase B ───────────────────────────────────────────────────────────────────

  private async _runPhaseB(
    moduleName: string,
    req: { id: string; description: string; priority: string },
    angle: RegenAngle,
    forbiddenTitles: string[],
    tcId: string,
    model: string,
    ollamaUrl: string,
    instruction?: string,
    options: OllamaOptions = PHASE_B_OPTIONS,
    existingTCs: ExistingTC[] = [],
    langfuseTrace?: any,
    // Passé uniquement par _runRegenPipeline — ancre le prompt sur le TC
    // actuellement affiché plutôt que de laisser le LLM inventer un scénario
    // à partir de l'instruction seule (voir buildPhaseBPrompt).
    originalTc?: { title: string; steps: string[]; testData: string[]; expectedResult: string },
    // ⚠️ Propagé jusqu'à buildPhaseBPrompt — voir commentaire là-bas. Permet
    // au prompt d'afficher l'instruction comme une consigne littérale plutôt
    // qu'un simple "SCENARIO" librement interprétable.
    isInstructionAngle?: boolean,
  ): Promise<Record<string, any> | null> {
    try {
      const prompt = await buildPhaseBPrompt(moduleName, req, angle, forbiddenTitles, tcId, instruction, existingTCs, undefined, undefined, originalTc, isInstructionAngle);
      const generation = this.createLangfuseGeneration(langfuseTrace, 'phase-b-test-case', model, prompt, {
        requirementId: req.id,
        moduleName,
        tcId,
        angleFocus: angle.focus,
      });
      const parsed = await this._callLlm(prompt, model, ollamaUrl, options, generation);

      if (!parsed?.title || !Array.isArray(parsed.steps) || parsed.steps.length < 2) return null;

      parsed.title = typeof parsed.title === 'string'
        ? parsed.title.replace(/_/g, ' ').replace(/\s{2,}/g, ' ').trim()
        : parsed.title;

      const issues = this._detectTcIssues(parsed, forbiddenTitles);

      if (issues.length > 0) {
        if (issues.some(i => i.startsWith('Title too similar'))) return null;
        if (issues.some(i => i.includes('Real data')))           return null;

        const fixableIssues = issues.filter(i => !i.startsWith('Uncovered placeholders'));
        if (fixableIssues.length === 0) return parsed;

        // Only attempt self-critique if there are multiple issues (not just one minor issue)
        if (fixableIssues.length > 1) {
          try {
            const critiquePrompt = buildSelfCritiquePrompt(parsed, fixableIssues);
            const generation = this.createLangfuseGeneration(langfuseTrace, 'self-critique-fix', model, critiquePrompt, {
              requirementId: req.id,
              moduleName,
              tcId,
            });
            const fixed = await this._callLlm(critiquePrompt, model, ollamaUrl, SELF_CRITIQUE_OPTIONS, generation);
            if (fixed?.title && Array.isArray(fixed.steps)) {
              const remainingIssues = this._detectTcIssues(fixed, []);
              if (remainingIssues.length === 0 || remainingIssues.every(i => i.startsWith('Uncovered'))) return fixed;
              return fixed;
            }
          } catch (err: any) {
            this.logger.warn(`⚠️ [Self-critique] Failed: ${err.message}`);
          }
        }
      }

      return parsed;
    } catch (err: any) {
      this.logger.warn(`⚠️ [Phase B] focus="${angle.focus.slice(0, 50)}": ${err.message}`);
      return null;
    }
  }

  
  // ── Validation (délègue à tc-utils) ──────────────────────────────────────────

  private _detectTcIssues(tc: Record<string, any>, existingTitles: string[] = []): string[] {
    return validateTestCase(tc, existingTitles).issues;
  }

  // ── Similarity check ──────────────────────────────────────────────────────────

  private async _checkSimilarity(
    title: string,
    steps: string[],
    reqObjId: string,
    projectId: string,
    acceptSimilar: boolean,
    excludeTestId?: string,
  ): Promise<{ pass: boolean; warning?: any }> {
    const check      = await this.mongoVector.isSimilarInHistory({ title, steps, requirementId: reqObjId, projectId, excludeTestId });
    const score      = check.score ?? 0;
    if (!check.isDuplicate || score < this.SIMILARITY_WARNING) return { pass: true };
    const scorePercent = Math.round(score * 100);
    if (score >= this.SIMILARITY_STRICT && !acceptSimilar) {
      return {
        pass: false,
        warning: {
          score, scorePercent, similarTitle: check.similarTitle, similarId: check.similarId,
          isStrict: true, source: 'history',
          message: `TC similaire à ${scorePercent}% avec "${check.similarTitle}"`,
          similarTC: check.similarTC || null,
        },
      };
    }
    return {
      pass: true,
      warning: {
        score, scorePercent, similarTitle: check.similarTitle, similarId: check.similarId,
        isStrict: false, source: 'history',
        message: `TC similaire à ${scorePercent}% avec "${check.similarTitle}"`,
        similarTC: check.similarTC || null,
      },
    };
  }

  // ── Persist helpers ───────────────────────────────────────────────────────────

  private async _persistRegen(
    projectId: string, reqObjId: string, reqId: string, moduleName: string,
    originalTc: { testId: string; title: string; preconditions: string[]; steps: string[]; testData: string[]; expectedResult: string; type: string; priority: string },
    regen: Record<string, any>,
  ): Promise<void> {
    try {
      await this.mongoVector.addTestCase({
        testId: regen.testId, title: regen.title, steps: regen.steps,
        requirementId: reqObjId, moduleId: moduleName, projectId,
        preconditions: regen.preconditions, testData: regen.testData,
        expectedResult: regen.expectedResult, type: regen.type, priority: regen.priority,
      });
    } catch (err: any) { this.logger.warn(`⚠️ [VECTOR] FAILED — ${err.message}`); }

    await this.addToHistory(projectId, reqObjId, reqId, originalTc.title, regen.title);
    await this.addTcToHistoryIndex(projectId, reqObjId, reqId, {
      testId:         regen.testId,
      title:          regen.title,
      preconditions:  Array.isArray(regen.preconditions) ? regen.preconditions : originalTc.preconditions,
      steps:          Array.isArray(regen.steps)         ? regen.steps         : originalTc.steps,
      testData:       Array.isArray(regen.testData)      ? regen.testData      : originalTc.testData,
      expectedResult: regen.expectedResult               || originalTc.expectedResult,
      type:           regen.type                         || originalTc.type,
      priority:       regen.priority                     || originalTc.priority,
    });
  }

  private async _persistGenerated(
    projectId: string, reqObjId: string, reqId: string, moduleName: string, tc: Record<string, any>,
  ): Promise<void> {
    try {
      await this.mongoVector.addTestCase({
        testId: tc.testId, title: tc.title, steps: tc.steps,
        requirementId: reqObjId, moduleId: moduleName, projectId,
        preconditions: tc.preconditions ?? [], testData: tc.testData ?? [],
        expectedResult: tc.expectedResult ?? '', type: tc.type, priority: tc.priority,
      });
    } catch (err: any) { this.logger.warn(`⚠️ [VECTOR] FAILED — ${err.message}`); }

    await this.addToHistory(projectId, reqObjId, reqId, tc.title);
    await this.addTcToHistoryIndex(projectId, reqObjId, reqId, {
      testId: tc.testId, title: tc.title,
      preconditions: tc.preconditions ?? [], steps: tc.steps ?? [],
      testData: tc.testData ?? [], expectedResult: tc.expectedResult ?? '',
      type: tc.type, priority: tc.priority,
    });
  }

  // ── Pipeline de régénération ──────────────────────────────────────────────────

  private async _runRegenPipeline(p: {
    moduleName: string;
    req: { id: string; description: string; priority: string };
    tcId: string;
    originalTc: { testId: string; title: string; preconditions: string[]; steps: string[]; testData: string[]; expectedResult: string; type: string; priority: string };
    existingTCs: TcSnapshot[]; historyTitles: string[];
    projectId: string; reqObjId: string; model: string; ollamaUrl: string;
    instruction: string; acceptSimilar: boolean;
  }): Promise<{ tc: Record<string, any>; warning?: any }> {
    const { moduleName, req, tcId, originalTc, existingTCs, historyTitles, projectId, reqObjId, model, ollamaUrl, instruction, acceptSimilar } = p;
    const trace = this.createLangfuseTrace('regenerate-test-case', projectId, {
      model,
      requirementId: req.id,
      tcId,
      projectId,
    });

    // ⚠️ FIX : le titre d'origine du TC qu'on est en train de régénérer peut
    // déjà être dans `historyTitles` — persistTestCase() (llm.service.ts)
    // l'y ajoute dès la génération initiale, avant toute validation. Comme
    // `existingTCs`/`seenTitles` excluent volontairement ce TC (on l'édite,
    // pas question de le comparer à lui-même), `filterHistoryTitles` ne le
    // filtre pas de l'historique. Sans ce retrait, une instruction ciblée
    // qui ne change pas le titre (cas normal) se fait rejeter par
    // `isTitleTooClose` comme "trop similaire" à... sa propre version
    // précédente, et le pipeline retombe silencieusement sur un angle
    // générique sans rapport avec l'instruction.
    const ownTitleNorm   = (originalTc.title ?? '').toLowerCase().trim();
    const forbiddenTitles = buildForbiddenTitles(existingTCs, historyTitles)
      .filter(t => t.toLowerCase().trim() !== ownTitleNorm);

    // ⚠️ Avant : `undefined` passé ici privait Phase A de l'instruction —
    // elle générait 12 angles génériques sans aucune idée de ce que
    // l'utilisateur voulait, et l'instruction n'était ajoutée qu'après coup.
    // On la transmet maintenant à Phase A aussi, pour que les angles de
    // secours (si l'instruction ne mène à rien d'exploitable) soient déjà
    // dans l'esprit de la demande plutôt que complètement génériques.
    // ⚠️ FIX MAJEUR : on n'appelle Phase A (angles génériques) QUE s'il n'y a
    // pas d'instruction. Avant, même avec une instruction, les angles
    // génériques de Phase A étaient ajoutés à la suite de `toTry` — donc si
    // l'angle-instruction échouait pour N'IMPORTE QUELLE raison (parsing LLM
    // raté, titre jugé trop proche, score de similarité), la boucle
    // continuait sur un angle générique SANS RAPPORT avec l'instruction et
    // le renvoyait tel quel dès qu'il passait. Résultat observé : un TC
    // totalement différent (autre sujet, préconditions perdues) au lieu de
    // l'édition ciblée demandée. Avec une instruction, on ne tente plus
    // QUE l'angle-instruction (avec quelques essais), jamais de repli
    // générique — voir demande explicite : "il faut que le LLM suive
    // l'instruction mot à mot".
    const instructionAngle: RegenAngle | null = instruction.trim()
      ? { focus: instruction.trim(), tcType: this._normalizeType(originalTc.type) }
      : null;

    let toTry: RegenAngle[];
    if (instructionAngle) {
      toTry = [instructionAngle];
    } else {
      const angles = await this._runPhaseA(moduleName, req, model, ollamaUrl, undefined, existingTCs, trace, PHASE_A_REGEN_OPTIONS);
      const uncovered = angles.filter(a => !isAngleCovered(a, existingTCs));
      toTry = uncovered.length > 0 ? uncovered : angles;
    }

    let lastWarning: any = undefined, bestScore = Infinity, bestTC: any = null, bestGeneratedTC: any = null;

    // ⚠️ Avec une seule tentative possible (l'angle-instruction, pas de
    // repli générique), on retente jusqu'à 2 fois de plus en cas d'échec de
    // parsing LLM pur (parsed === null) — un aléa du modèle, pas une raison
    // de renvoyer un TC hors-sujet. On ne retente PAS après un rejet de
    // titre/similarité : ça ne changerait pas d'une tentative à l'autre.
    const maxAttempts = instructionAngle ? 3 : 1;

    for (let i = 0; i < toTry.length; i++) {
      const angle  = toTry[i];
      let parsed: Record<string, any> | null = null;
      for (let attempt = 0; attempt < maxAttempts && !parsed; attempt++) {
        parsed = await this._runPhaseB(moduleName, req, angle, forbiddenTitles, tcId, model, ollamaUrl, instruction, PHASE_B_REGEN_OPTIONS, existingTCs, trace, originalTc, angle === instructionAngle);
      }
      if (!parsed) continue;

      const title = parsed.title || '';
      const steps = Array.isArray(parsed.steps) ? parsed.steps : originalTc.steps;

      if (isTitleTooClose(title, forbiddenTitles)) continue;

      // ⚠️ FIX : excludeTestId = tcId — voir isSimilarInHistory() dans
      // mongo-vector.service.ts. On édite ce TC précis, il ne doit pas
      // pouvoir se faire rejeter en se comparant à sa propre entrée déjà
      // indexée depuis sa génération initiale.
      const sim = await this._checkSimilarity(title, steps, reqObjId, projectId, acceptSimilar, tcId);
      if (!sim.pass) {
        lastWarning = { ...sim.warning, generatedTC: { testId: tcId, moduleId: moduleName, requirementId: req.id, title, preconditions: Array.isArray(parsed.preconditions) ? parsed.preconditions : originalTc.preconditions, steps, testData: Array.isArray(parsed.testData) ? parsed.testData : originalTc.testData, expectedResult: parsed.expectedResult || originalTc.expectedResult, type: this._normalizeType(parsed.type || originalTc.type), priority: this._normalizePriority(parsed.priority || originalTc.priority) } };
        if (sim.warning && typeof sim.warning.score === 'number' && sim.warning.score < bestScore) {
          bestScore = sim.warning.score; bestTC = sim.warning.similarTC || null; bestGeneratedTC = lastWarning.generatedTC;
        }
        continue;
      }
      if (sim.warning) lastWarning = sim.warning;

      const tc: Record<string, any> = {
        testId: parsed.testId || tcId, moduleId: parsed.moduleId || moduleName, requirementId: parsed.requirementId || req.id,
        title, preconditions: Array.isArray(parsed.preconditions) ? parsed.preconditions : originalTc.preconditions,
        steps, testData: Array.isArray(parsed.testData) ? parsed.testData : originalTc.testData,
        expectedResult: parsed.expectedResult || originalTc.expectedResult,
        type: this._normalizeType(parsed.type || originalTc.type),
        priority: this._normalizePriority(parsed.priority || originalTc.priority),
        manually_edited: true, ...(lastWarning && { warning: lastWarning }),
      };
      return { tc, warning: lastWarning };
    }

    if (bestGeneratedTC) {
      return { tc: { moduleId: moduleName, requirementId: req.id, ...bestGeneratedTC, testId: bestGeneratedTC.testId || tcId, warning: { message: 'Aucun TC unique possible, le TC généré est très similaire à un existant.', score: bestScore, scorePercent: Math.round(bestScore * 100), similarTC: bestTC } } };
    }

    // ⚠️ FIX : message clair et actionnable quand l'instruction n'a pas pu
    // être appliquée — plutôt que de renvoyer un TC hors-sujet (ancien
    // comportement via le repli sur des angles génériques, retiré ci-dessus).
    if (instructionAngle) {
      throw new Error(`Impossible d'appliquer l'instruction à ${tcId} : le modèle n'a produit aucun résultat exploitable après ${maxAttempts} tentative(s). Reformulez l'instruction ou réessayez.`);
    }
    throw new Error(`Impossible de générer un TC unique pour ${req.id} : les ${toTry.length} scénarios candidats sont tous déjà couverts.`);
  }

  // ── Pipeline de génération simple ─────────────────────────────────────────────

  private async _runGeneratePipeline(p: {
    moduleName: string; req: { id: string; description: string; priority: string };
    tcId: string; existingTCs: TcSnapshot[]; historyTitles: string[];
    projectId: string; reqObjId: string; model: string; ollamaUrl: string;
    instruction: string; acceptSimilar: boolean;
    extraForbiddenTitles?: string[];
  }): Promise<{ tc: Record<string, any>; warning?: any }> {
    const { moduleName, req, tcId, existingTCs, historyTitles, projectId, reqObjId, model, ollamaUrl, instruction, acceptSimilar } = p;
    const trace = this.createLangfuseTrace('generate-test-case', projectId, {
      model,
      requirementId: req.id,
      tcId,
      projectId,
    });

    const forbiddenTitles = [
      ...buildForbiddenTitles(existingTCs, historyTitles),
      ...(p.extraForbiddenTitles ?? []),
    ];

    const existingTypes = extractExistingTypes(existingTCs);
    let angles = await this._runPhaseASingle(moduleName, req, existingTypes, model, ollamaUrl, instruction, existingTCs, trace);

    if (angles.length < 2) {
      this.logger.warn(`[Pipeline-Single] Phase A fast returned ${angles.length} angles for ${req.id} — falling back to full Phase A`);
      angles = await this._runPhaseA(moduleName, req, model, ollamaUrl, undefined, existingTCs, trace);
      if (instruction.trim()) angles = [{ focus: instruction.trim() }, ...angles];
    } else if (instruction.trim()) {
      angles = [{ focus: instruction.trim() }, ...angles];
    }

    const uncovered = angles.filter(a => !isAngleCovered(a, existingTCs));
    const toTry     = uncovered.length > 0 ? uncovered : angles;

    let lastWarning: any = undefined, bestScore = Infinity, bestGeneratedTC: any = null;

    const parallelBatch = toTry.slice(0, 2);
    const restAngles    = toTry.slice(2);

    const parallelResults = await Promise.allSettled(
      parallelBatch.map(angle =>
        this._runPhaseB(moduleName, req, angle, forbiddenTitles, tcId, model, ollamaUrl, undefined, PHASE_B_SINGLE_OPTIONS, existingTCs, trace),
      ),
    );
    const phaseBResults = parallelResults;

    const allToEvaluate: Array<{ parsed: Record<string, any> | null }> = [
      ...phaseBResults.map(r => ({ parsed: r.status === 'fulfilled' ? r.value as any : null })),
      ...restAngles.map(() => ({ parsed: null as any })),
    ];

    for (let i = 0; i < allToEvaluate.length; i++) {
      let parsed: Record<string, any> | null;

      if (i < parallelBatch.length) {
        parsed = allToEvaluate[i].parsed;
      } else {
        const angle = restAngles[i - parallelBatch.length];
        parsed = await this._runPhaseB(moduleName, req, angle, forbiddenTitles, tcId, model, ollamaUrl, undefined, PHASE_B_SINGLE_OPTIONS, existingTCs, trace);
      }

      if (!parsed) continue;

      const title = parsed.title || '';
      const steps = Array.isArray(parsed.steps) ? parsed.steps : [];

      if (isTitleTooClose(title, forbiddenTitles)) continue;

      const sim = await this._checkSimilarity(title, steps, reqObjId, projectId, acceptSimilar);
      if (!sim.pass) {
        const candidate = { testId: tcId, moduleId: moduleName, requirementId: req.id, title, preconditions: Array.isArray(parsed.preconditions) ? parsed.preconditions : [], steps, testData: Array.isArray(parsed.testData) ? parsed.testData : [], expectedResult: parsed.expectedResult ?? '', type: this._normalizeType(parsed.type ?? 'positive'), priority: this._normalizePriority(parsed.priority ?? 'MEDIUM') };
        lastWarning = { ...sim.warning, generatedTC: candidate };
        if (sim.warning && typeof sim.warning.score === 'number' && sim.warning.score < bestScore) { bestScore = sim.warning.score; bestGeneratedTC = candidate; }
        continue;
      }
      if (sim.warning) lastWarning = sim.warning;

      const tc: Record<string, any> = {
        testId: parsed.testId || tcId, moduleId: moduleName, requirementId: req.id, title,
        preconditions: Array.isArray(parsed.preconditions) ? parsed.preconditions : [],
        steps, testData: Array.isArray(parsed.testData) ? parsed.testData : [],
        expectedResult: parsed.expectedResult ?? '',
        type: this._normalizeType(parsed.type ?? 'positive'),
        priority: this._normalizePriority(parsed.priority ?? 'MEDIUM'),
        ...(lastWarning && { warning: lastWarning }),
      };
      return { tc, warning: lastWarning };
    }

    if (bestGeneratedTC) return { tc: { ...bestGeneratedTC, warning: { message: 'Aucun TC unique possible, le TC généré est très similaire à un existant.', score: bestScore, scorePercent: Math.round(bestScore * 100) } } };

    throw new Error(`Impossible de générer un TC unique pour ${req.id} : les ${toTry.length} angles candidats sont tous déjà couverts.`);
  }

  // ── Pipeline de génération rapide (single appel LLM) ───────────────────────

  private async _runGeneratePipelineFast(p: {
    moduleName: string;
    req: { id: string; description: string; priority: string };
    tcId: string;
    existingTCs: TcSnapshot[];
    historyTitles: string[];
    projectId: string;
    reqObjId: string;
    model: string;
    ollamaUrl: string;
    acceptSimilar: boolean;
  }): Promise<{ tc: Record<string, any>; warning?: any }> {
    const { moduleName, req, tcId, existingTCs, historyTitles, projectId, reqObjId, model, ollamaUrl, acceptSimilar } = p;

    const forbiddenTitles = buildForbiddenTitles(existingTCs, historyTitles);
    const existingTypes   = extractExistingTypes(existingTCs);

    // Warm-up nomic lancé ICI, juste avant l'appel qwen (LLM dominant).
    // Ollama garde nomic chaud pendant toute la durée de l'inférence qwen (~25-60s)
    // grâce au keep_alive:10m dans embed(). Sans ça, nomic est déchargé pendant
    // qwen et le rechargement coûte ~30s supplémentaires lors du isSimilarInHistory.
    this.embeddingService.warmUpEmbeddingModel(req.description).catch(() => {});

    // Utiliser PHASE_AB_FAST_OPTIONS (num_ctx 4096, num_predict 700)
    // au lieu de PHASE_B_SINGLE_OPTIONS → gain ~3-5s par appel LLM.
    const t0LLM = Date.now();
    const phaseABPrompt = await buildPhaseABSinglePrompt(moduleName, req, forbiddenTitles, tcId, existingTypes, existingTCs);
    const parsed = await this._callLlm(
      phaseABPrompt,
      model, ollamaUrl, PHASE_AB_FAST_OPTIONS,
    );
    this.logger.log(`⏱️ [Fast pipeline] LLM call: ${Date.now() - t0LLM}ms`);

    if (!parsed?.title || !Array.isArray(parsed.steps) || parsed.steps.length < 2) {
      // Fallback sur le pipeline 2-phases si le TC est invalide
      this.logger.warn(`[Fast pipeline] invalid TC (missing title/steps), falling back to 2-phase pipeline`);
      const t0Fallback = Date.now();
      const result = await this._runGeneratePipeline({ ...p, instruction: '' });
      this.logger.warn(`⏱️ [Fast pipeline] 2-phase fallback took: ${Date.now() - t0Fallback}ms`);
      return result;
    }

    const title = parsed.title;
    const steps = parsed.steps;

    if (isTitleTooClose(title, forbiddenTitles)) {
      this.logger.warn(`[Fast pipeline] title too close to forbidden, falling back to 2-phase pipeline`);
      const t0Fallback = Date.now();
      // Fix 2 : passer le titre rejeté comme contrainte supplémentaire
      const result = await this._runGeneratePipeline({ ...p, instruction: '', extraForbiddenTitles: [title] });
      this.logger.warn(`⏱️ [Fast pipeline] 2-phase fallback took: ${Date.now() - t0Fallback}ms`);
      return result;
    }

    const sim = await this._checkSimilarity(title, steps, reqObjId, projectId, acceptSimilar);
    if (!sim.pass) {
      this.logger.warn(`[Fast pipeline] TC similar to history (score=${sim.warning?.score?.toFixed(3)}), falling back to 2-phase pipeline`);
      const t0Fallback = Date.now();
      // Fix 2 : passer le titre rejeté comme contrainte pour éviter que Phase A/B
      // retombe sur le même territoire sémantique.
      const result = await this._runGeneratePipeline({ ...p, instruction: '', extraForbiddenTitles: [title] });
      this.logger.warn(`⏱️ [Fast pipeline] 2-phase fallback took: ${Date.now() - t0Fallback}ms`);
      return result;
    }

    const tc: Record<string, any> = {
      testId: parsed.testId || tcId,
      moduleId: moduleName,
      requirementId: req.id,
      title,
      preconditions: Array.isArray(parsed.preconditions) ? parsed.preconditions : [],
      steps,
      testData: Array.isArray(parsed.testData) ? parsed.testData : [],
      expectedResult: parsed.expectedResult ?? '',
      type: this._normalizeType(parsed.type ?? 'positive'),
      priority: this._normalizePriority(parsed.priority ?? 'MEDIUM'),
      ...(sim.warning && { warning: sim.warning }),
    };
    return { tc, warning: sim.warning };
  }

  // ── Phase A — version fast (single TC uniquement) ─────────────────────────

  private async _runPhaseASingle(
    moduleName: string,
    req: { id: string; description: string; priority: string },
    existingTypes: string[],
    model: string,
    ollamaUrl: string,
    instruction?: string,
    existingTCs: ExistingTC[] = [],
    langfuseTrace?: any,
  ): Promise<RegenAngle[]> {
    try {
      const prompt = await buildPhaseASinglePrompt(moduleName, req, existingTypes, instruction, existingTCs);
      const generation = this.createLangfuseGeneration(langfuseTrace, 'phase-a-test-case-single', model, prompt, {
        requirementId: req.id,
        moduleName,
      });
      const parsed = await this._callLlm(prompt, model, ollamaUrl, PHASE_A_SINGLE_OPTIONS, generation);
      if (Array.isArray(parsed?.angles)) {
        const angles: RegenAngle[] = parsed.angles
          .filter((a: any) => typeof a.focus === 'string' && a.focus.trim().length > 10)
          .slice(0, 4)
.map((a: any) => ({ focus: a.focus.trim(), tcType: a.type?.trim() }));
        if (angles.length >= 2) return angles;
      }
    } catch (err: any) {
      this.logger.warn(`⚠️ [Phase A Single] failed for ${req.id}: ${err.message}`);
    }
    return [];
  }

  // ── Context loader ────────────────────────────────────────────────────────────

  private _generateNextTestCaseId(allTestCases: any[], reqId: string): string {
    const numbers: number[] = [];
    for (const tc of allTestCases) {
      const testId = tc.test_id ?? tc.testId;
      if (testId) {
        const match = testId.match(/^TC-[A-Z]+-\d+-(\d+)$/i);
        if (match?.[1]) numbers.push(parseInt(match[1], 10));
      }
    }
    const maxNum  = numbers.length > 0 ? Math.max(...numbers) : 0;
    return `TC-${reqId}-${String(maxNum + 1).padStart(2, '0')}`;
  }

  private async _loadGenerationContext(requirementUuid: string): Promise<{
    moduleName: string; reqId: string; reqDesc: string; reqPriority: string;
    projectId: string; reqObjId: string; tcId: string;
    existingTCs: TcSnapshot[]; historyTitles: string[];
  }> {
    const req = await this.prisma.requirement.findUniqueOrThrow({
      where:   { id: requirementUuid },
      include: { module: { include: { project: true } }, test_cases: true },
    });

    const moduleName  = req.module?.name       ?? 'Unknown Module';
    const reqId       = req.req_id;
    const reqDesc     = req.description;
    const reqPriority = req.priority;
    const projectId   = req.module?.project_id ?? 'default';

    const [historyEntries, rawHistory] = await Promise.all([
      this.prisma.generationHistoryEntry.findMany({
        where: { requirement_id: requirementUuid }, orderBy: { created_at: 'desc' },
      }).catch((err: any) => {
        this.logger.warn(`⚠️ [loadCtx] generationHistoryEntry failed: ${err.message}`);
        return [] as any[];
      }),
      this._getHistory(projectId, requirementUuid),
    ]);

    const { existingTCs, seen: seenTitles } = buildExistingTCs([req.test_cases ?? [], historyEntries]);
    const historyTitles = filterHistoryTitles(rawHistory, seenTitles);
    const tcId          = this._generateNextTestCaseId([...(req.test_cases ?? []), ...historyEntries], reqId);

    return { moduleName, reqId, reqDesc, reqPriority, projectId, reqObjId: requirementUuid, tcId, existingTCs, historyTitles };
  }

  // ── Public API de génération ──────────────────────────────────────────────────

  async regenerateSingleTestCase(
    testCaseUuid: string, model: string, ollamaUrl: string,
    instruction: string, memoryTestCases: any[] = [], acceptSimilar: boolean = false,
  ): Promise<Record<string, any>> {
    if (!instruction?.trim()) throw new Error('Une instruction est obligatoire pour régénérer un test case.');

    const tc = await this.prisma.testCase.findUniqueOrThrow({
      where: { id: testCaseUuid },
      include: { requirement: { include: { module: { include: { project: true } } } } },
    });

    const moduleName  = tc.requirement.module?.name ?? 'Unknown Module';
    const reqId       = tc.requirement.req_id;
    const reqDesc     = tc.requirement.description;
    const reqPriority = tc.requirement.priority;
    const projectId   = tc.requirement.module?.project_id ?? 'default';
    let   reqObjId    = tc.requirement_id;

    if (typeof reqObjId !== 'string' || reqObjId.length !== 24) {
      const r = await this.prisma.requirement.findFirst({ where: { req_id: tc.requirement_id, module: { project_id: projectId } }, select: { id: true } });
      reqObjId = r?.id ?? tc.requirement_id;
    }

    // ⚠️ FIX : on exclut le TC en cours d'édition de `siblings`. Avant, son
    // titre d'origine finissait dans `existingTCs` → `forbiddenTitles`, et
    // comme une instruction de régénération ciblée (ex: "change juste la
    // donnée X") produit souvent un titre identique ou très proche de
    // l'original, `isTitleTooClose()` le rejetait comme "trop similaire à
    // lui-même". Résultat : l'angle-instruction était jeté et le pipeline
    // retombait silencieusement sur un angle générique de Phase A, donnant
    // l'impression que toute l'instruction était ignorée.
    const siblings    = await this.prisma.testCase.findMany({ where: { requirement_id: tc.requirement_id, id: { not: testCaseUuid } } });
    const { existingTCs, seen: seenTitles } = buildExistingTCs([siblings, memoryTestCases]);
    const historyTitles = filterHistoryTitles(await this._getHistory(projectId, reqObjId), seenTitles);
    const originalTc    = { testId: tc.test_id, title: tc.title, preconditions: tc.preconditions, steps: tc.steps, testData: (tc as any).test_data ?? [], expectedResult: tc.expected_result ?? '', type: tc.type, priority: tc.priority };

    const { tc: regeneratedTC } = await this._runRegenPipeline({ moduleName, req: { id: reqId, description: reqDesc, priority: reqPriority }, tcId: tc.test_id, originalTc, existingTCs, historyTitles, projectId, reqObjId, model, ollamaUrl, instruction, acceptSimilar });

    let reqObjId2 = tc.requirement_id;
    if (typeof reqObjId2 !== 'string' || reqObjId2.length !== 24) {
      const r = await this.prisma.requirement.findFirst({ where: { req_id: tc.requirement_id, module: { project_id: projectId } }, select: { id: true, req_id: true } });
      reqObjId2 = r?.id ?? tc.requirement_id;
    }

    await this._persistRegen(projectId, reqObjId2, reqId, moduleName, originalTc, regeneratedTC);
    const persisted = await this.editTestCase(testCaseUuid, {
      title: regeneratedTC.title,
      steps: regeneratedTC.steps,
      preconditions: regeneratedTC.preconditions,
      test_data: regeneratedTC.testData,
      expected_result: regeneratedTC.expectedResult,
      type: regeneratedTC.type,
      priority: regeneratedTC.priority,
    });
    if ('pending' in persisted) return persisted;
    return { ...regeneratedTC, id: persisted.id };
  }

  async regenerateMemoryTestCase(
    tc: { testId: string; moduleId: string; requirementId: string; title: string; type: string; priority: string; preconditions: string[]; steps: string[]; testData: string[]; expectedResult: string },
    instruction: string, model: string, ollamaUrl: string, reqDescription: string,
    otherTestCases: any[] = [], projectId: string = 'default', acceptSimilar: boolean = false,
  ): Promise<Record<string, any>> {
    if (!instruction?.trim()) throw new Error('Une instruction est obligatoire pour régénérer un test case.');

    let reqObjId = tc.requirementId;
    if (typeof reqObjId !== 'string' || reqObjId.length !== 24) {
      const r = await this.prisma.requirement.findFirst({ where: { req_id: tc.requirementId, module: { project_id: projectId } }, select: { id: true } });
      reqObjId = r?.id ?? tc.requirementId;
    }

    const siblings    = await this.prisma.testCase.findMany({ where: { requirement_id: reqObjId } });
    const { existingTCs, seen: seenTitles } = buildExistingTCs([siblings, otherTestCases]);
    const historyTitles = filterHistoryTitles(await this._getHistory(projectId, reqObjId), seenTitles);
    const reqEntity     = await this.prisma.requirement.findUnique({ where: { id: reqObjId }, select: { req_id: true, priority: true } });
    const reqId         = reqEntity?.req_id   ?? tc.requirementId;
    const reqPriority   = reqEntity?.priority ?? 'SHALL';
    const originalTc    = { testId: tc.testId, title: tc.title, preconditions: tc.preconditions, steps: tc.steps, testData: tc.testData ?? [], expectedResult: tc.expectedResult ?? '', type: tc.type, priority: tc.priority };

    const { tc: regeneratedTC, warning } = await this._runRegenPipeline({ moduleName: tc.moduleId, req: { id: reqId, description: reqDescription, priority: reqPriority }, tcId: tc.testId, originalTc, existingTCs, historyTitles, projectId, reqObjId, model, ollamaUrl, instruction, acceptSimilar });

    if (regeneratedTC && Object.keys(regeneratedTC).length > 0) {
      await this._persistRegen(projectId, reqObjId, reqId, tc.moduleId, originalTc, regeneratedTC);
    }
    return { ...(regeneratedTC || {}), ...(warning ? { warning } : {}) };
  }

  async generateSingleTestCase(requirementUuid: string, model: string, ollamaUrl: string, acceptSimilar: boolean = false): Promise<Record<string, any>> {
    const ctx = await this._loadGenerationContext(requirementUuid);
    const { tc, warning } = await this._runGeneratePipelineFast({
      moduleName: ctx.moduleName,
      req: { id: ctx.reqId, description: ctx.reqDesc, priority: ctx.reqPriority },
      tcId: ctx.tcId, existingTCs: ctx.existingTCs, historyTitles: ctx.historyTitles,
      projectId: ctx.projectId, reqObjId: ctx.reqObjId,
      model, ollamaUrl, acceptSimilar,
    });

    // Fix 1 : attendre l'indexation dans generationHistoryEntry AVANT de retourner.
    // Sans ça, un appel generateSingleTestCase immédiatement suivant ne voit pas ce TC
    // dans l'historique et génère un doublon → fallback 2-phase inutile de ~130s.
    // Le addTestCase (embedding test_cases) reste fire-and-forget car moins critique.
    await this.addTcToHistoryIndex(ctx.projectId, ctx.reqObjId, ctx.reqId, {
      testId:        tc.testId,
      title:         tc.title,
      preconditions: tc.preconditions ?? [],
      steps:         tc.steps ?? [],
      testData:      tc.testData ?? [],
      expectedResult: tc.expectedResult ?? '',
      type:          tc.type,
      priority:      tc.priority,
    });

    // Fire-and-forget : embedding test_cases + history titles (non bloquants)
    this.mongoVector.addTestCase({
      testId: tc.testId, title: tc.title, steps: tc.steps,
      requirementId: ctx.reqObjId, moduleId: ctx.moduleName, projectId: ctx.projectId,
      preconditions: tc.preconditions ?? [], testData: tc.testData ?? [],
      expectedResult: tc.expectedResult ?? '', type: tc.type, priority: tc.priority,
    }).catch(err => this.logger.warn(`⚠️ [PERSIST] addTestCase failed: ${err.message}`));

    this.addToHistory(ctx.projectId, ctx.reqObjId, ctx.reqId, tc.title)
      .catch(err => this.logger.warn(`⚠️ [PERSIST] addToHistory failed: ${err.message}`));

    return { ...tc, ...(warning ? { warning } : {}) };
  }

  async generateSingleTestCaseWithInstruction(requirementUuid: string, instruction: string, model: string, ollamaUrl: string, acceptSimilar: boolean = false): Promise<Record<string, any>> {
    if (!instruction?.trim()) throw new Error('Une instruction est obligatoire pour generateSingleTestCaseWithInstruction.');
    const ctx         = await this._loadGenerationContext(requirementUuid);
    const { tc, warning } = await this._runGeneratePipeline({ moduleName: ctx.moduleName, req: { id: ctx.reqId, description: ctx.reqDesc, priority: ctx.reqPriority }, tcId: ctx.tcId, existingTCs: ctx.existingTCs, historyTitles: ctx.historyTitles, projectId: ctx.projectId, reqObjId: ctx.reqObjId, model, ollamaUrl, instruction, acceptSimilar });
    await this._persistGenerated(ctx.projectId, ctx.reqObjId, ctx.reqId, ctx.moduleName, tc);
    return { ...tc, ...(warning ? { warning } : {}) };
  }

  // ── Saturation status ─────────────────────────────────────────────────────
  // Calcule si l'espace sémantique du requirement est saturé en combinant :
  //   - le taux de rejet sur les N dernières tentatives (données en mémoire)
  //   - le score moyen des checks de similarité (données en mémoire)
  //   - le nombre de TCs dans l'historique (données en DB)
  async getRequirementSaturationStatus(requirementUuid: string) {
    // On passe requirementUuid comme projectId aussi — getSaturationStatus
    // n'a besoin que du requirementId pour compter les entrées historique.
    return this.mongoVector.getSaturationStatus(requirementUuid, requirementUuid);
  }

  // ── Verify TC (unchanged) ─────────────────────────────────────────────────────

  async verifyTestCase(
    tc: { testId: string; moduleId: string; requirementId: string; title: string; type: string; priority: string; preconditions: string[]; steps: string[]; testData: string[]; expectedResult: string },
    changedFields: string[], model: string, ollamaUrl: string, reqDescription: string,
  ): Promise<Record<string, any>> {
    const trace = this.createLangfuseTrace('verify-test-case', tc.requirementId || 'default', {
      model,
      requirementId: tc.requirementId,
      testId: tc.testId,
    });
    const changed: string[] = [], stable: string[] = [];
    if (changedFields.includes('title'))          changed.push(`- TITLE CHANGED -> "${tc.title}": fix spelling. Adapt other fields for coherence.`);
    else                                           stable.push(`- Title (NOT changed): "${tc.title}"`);
    if (changedFields.includes('preconditions'))  changed.push(`- PRECONDITIONS CHANGED -> ${JSON.stringify(tc.preconditions)}: fix spelling, keep ALL items.`);
    else                                           stable.push(`- Preconditions (NOT changed): ${JSON.stringify(tc.preconditions)}`);
    if (changedFields.includes('steps'))          changed.push(`- STEPS CHANGED -> ${JSON.stringify(tc.steps)}: fix spelling, keep ALL items in order.`);
    else                                           stable.push(`- Steps (NOT changed): ${JSON.stringify(tc.steps)}`);
    if (changedFields.includes('testData')) {
      if (tc.testData?.length > 0)               changed.push(`- TEST DATA CHANGED -> ${JSON.stringify(tc.testData)}: fix spelling, keep ALL fields.`);
      else                                         changed.push(`- TEST DATA IS EMPTY: scan ALL steps and extract data values.`);
    } else                                         stable.push(`- Test data (NOT changed): ${JSON.stringify(tc.testData ?? [])}`);
    if (changedFields.includes('expectedResult')) changed.push(`- EXPECTED RESULT CHANGED -> "${tc.expectedResult}": fix spelling.`);
    else                                           stable.push(`- Expected result (NOT changed): "${tc.expectedResult}"`);

    const prompt = `You are a senior QA engineer reviewing a manually edited test case.\n\nREQUIREMENT: ${reqDescription}\n\n${changed.length > 0 ? `FIELDS CHANGED BY USER:\n${changed.join('\n')}` : ''}\n${stable.length > 0 ? `\nFIELDS NOT CHANGED (return EXACTLY as-is):\n${stable.join('\n')}` : ''}\n\nRULES:\n- Keep ALL items in every list. Never remove items.\n- Fix spelling and grammar only in changed fields.\n- Steps = ACTIONS ONLY. No data values in steps.\n- All data goes exclusively in testData as "FieldName: 'value'" strings.\n- Types: positive, negative, edge_case, boundary, state_transition, security, integration, concurrency.\n\nOUTPUT - RAW JSON ONLY:\n{"testId": "${tc.testId}", "moduleId": "${tc.moduleId}", "requirementId": "${tc.requirementId}", "title": "...", "preconditions": ["..."], "steps": ["..."], "testData": ["Field: 'value'"], "expectedResult": "...", "type": "${tc.type}", "priority": "${tc.priority}"}`;

    const generation = this.createLangfuseGeneration(trace, 'verify-test-case', model, prompt, {
      requirementId: tc.requirementId,
      testId: tc.testId,
    });
    const parsed = await callOllamaAndParse(ollamaUrl, model, prompt, undefined, 'You are a JSON API. Output ONLY raw valid JSON. No prose, no markdown.', VERIFY_OPTIONS, this.LLM_CALL_TIMEOUT_MS, generation);

    return {
      testId: tc.testId,
      moduleId:       parsed.moduleId       || tc.moduleId,
      requirementId:  parsed.requirementId  || tc.requirementId,
      title:          parsed.title          || tc.title,
      preconditions:  Array.isArray(parsed.preconditions) ? parsed.preconditions : tc.preconditions,
      steps:          Array.isArray(parsed.steps)         ? parsed.steps         : tc.steps,
      testData:       Array.isArray(parsed.testData)      ? parsed.testData      : (tc.testData ?? []),
      expectedResult: parsed.expectedResult || tc.expectedResult,
      type:           this._normalizeType(parsed.type     || tc.type),
      priority:       this._normalizePriority(parsed.priority || tc.priority),
      manually_edited: true,
    };
  }

  // ── Normalization (délègue à shared) ─────────────────────────────────────────

  private _normalizeType(value: string): string {
    return normalizeTcType(value);
  }

  private _normalizePriority(value: string): string {
    const v = (value || '').toUpperCase();
    if (v === 'HIGH')   return 'HIGH';
    if (v === 'MEDIUM') return 'MEDIUM';
    if (v === 'LOW')    return 'LOW';
    return 'MEDIUM';
  }
}