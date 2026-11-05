import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Param,
  Logger,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBody,
} from '@nestjs/swagger';
import { startActiveObservation } from '@langfuse/tracing';
import { LlmService, RequirementsJson } from './llm.service';
import { AnalyzerService } from '../analyzer/analyzer.service';
import { ProjectService } from '../project/project.service';
import { CacheService } from '../cache/cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { sanitizeFormData, sanitizeMyersContext, SanitizationError } from '../shared/input-sanitizer';
import { TokenizerService } from '../tokenizer/tokenizer.service';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { JobStoreService } from './job-store.service';

class GenerateTestCasesDto {
  requirements: RequirementsJson;
  model?: string;
  project_id?: string;
  formData?: any;
}

// ─── Controller ───────────────────────────────────────────────────────────────

@ApiTags('llm')
@Controller('llm')
export class LlmController {
  private readonly logger = new Logger(LlmController.name);

  constructor(
    private readonly llmService: LlmService,
    private readonly analyzerService: AnalyzerService,
    private readonly projectService: ProjectService,
    private readonly cacheService: CacheService,
    private readonly prisma: PrismaService,
    private readonly tokenizerService: TokenizerService,
    private readonly jobStore: JobStoreService,
    private readonly realtimeGateway: NotificationsGateway,
    private readonly notificationsService: NotificationsService,
  ) {}

  /**
   * Étape SYNCHRONE et rapide : validation + sanitisation des entrées.
   * Lève une BadRequestException immédiatement si une entrée est invalide
   * ou rejetée par l'InputSanitizer — le front n'a pas besoin d'attendre
   * un job pour ça, l'erreur revient tout de suite (comme avant).
   *
   * Utilisée par l'endpoint synchrone historique ET par l'endpoint
   * asynchrone (/start) — voir plus bas.
   */
  private prepareGenerateRequirementTC(
    requirementId: string,
    body: { model?: string; project_id?: string; myersContext?: string; formData?: any; selectedScope?: string[]; approvedAngles?: { focus: string; tcType?: string }[]; forceAngleFocuses?: string[]; existingTcCount?: number },
  ) {
    if (!requirementId) {
      throw new BadRequestException('Missing "requirementId"');
    }

    this.logger.log(`📨 [FRONTEND DATA] Received: requirementId=${requirementId}, model=${body.model}, project=${body.project_id}, myersContext=${body.myersContext ? 'YES' : 'NO'}, formData=${body.formData ? 'YES' : 'NO'}, approvedAngles=${body.approvedAngles?.length ?? 0}, forceAngleFocuses=${body.forceAngleFocuses?.length ?? 0}, existingTcCount=${body.existingTcCount ?? 'n/a'}`);

    let safeMyersContext: string | undefined;
    let safeFormData: any;
    try {
      safeMyersContext = sanitizeMyersContext(body.myersContext);
      safeFormData     = sanitizeFormData(body.formData);
    } catch (err) {
      if (err instanceof SanitizationError) {
        this.logger.warn(`🚫 [InputSanitizer] Entrée rejetée : ${err.message}`);
        throw new BadRequestException(err.message);
      }
      throw err;
    }

    let safeApprovedAngles: { focus: string; tcType?: string }[] | undefined;
    if (Array.isArray(body.approvedAngles) && body.approvedAngles.length > 0) {
      safeApprovedAngles = body.approvedAngles
        .filter(a => a && typeof a.focus === 'string' && a.focus.trim().length > 0)
        .map(a => ({
          focus: a.focus.trim().slice(0, 500),
          tcType: typeof a.tcType === 'string' ? a.tcType.trim().toLowerCase().slice(0, 50) : undefined,
        }));
      if (safeApprovedAngles.length === 0) safeApprovedAngles = undefined;
    }

    let safeForceAngleFocuses: string[] | undefined;
    if (Array.isArray(body.forceAngleFocuses) && body.forceAngleFocuses.length > 0) {
      safeForceAngleFocuses = body.forceAngleFocuses
        .filter(f => typeof f === 'string' && f.trim().length > 0)
        .map(f => f.trim().slice(0, 500));
      if (safeForceAngleFocuses.length === 0) safeForceAngleFocuses = undefined;
    }

    const model     = this.llmService['defaultModel'];
    const projectId = body.project_id || 'default';

    this.logger.log(`🧪 /llm/generate-requirement/${requirementId} — model: ${model}, project: ${projectId}, myers: ${!!safeMyersContext}, formData: ${!!safeFormData}, selectedScope: ${Array.isArray(body.selectedScope) ? body.selectedScope.join(',') : ''}, approvedAngles: ${safeApprovedAngles?.length ?? 0}, forceAngleFocuses: ${safeForceAngleFocuses?.length ?? 0}`);

    let safeExistingTcCount: number | undefined;
    if (typeof body.existingTcCount === 'number' && Number.isFinite(body.existingTcCount) && body.existingTcCount >= 0) {
      safeExistingTcCount = Math.floor(body.existingTcCount);
    }

    return { model, projectId, safeMyersContext, safeFormData, safeApprovedAngles, safeForceAngleFocuses, safeExistingTcCount };
  }

  /** Étape LONGUE (jusqu'à plusieurs dizaines de minutes) : appel réel au LLM. */
  private async executeGenerateRequirementTC(
    requirementId: string,
    selectedScope: string[] | undefined,
    prepared: ReturnType<LlmController['prepareGenerateRequirementTC']>,
  ) {
    const { model, projectId, safeMyersContext, safeFormData, safeApprovedAngles, safeForceAngleFocuses, safeExistingTcCount } = prepared;

    const { test_cases: testCases, duration_ms, dedupRejections } = await this.llmService.generateRequirementTestCases(
      requirementId,
      model,
      projectId,
      selectedScope,
      safeMyersContext,
      safeFormData,
      safeApprovedAngles,
      safeForceAngleFocuses,
      safeExistingTcCount,
    );

    return {
      success: true,
      timestamp: new Date().toISOString(),
      test_cases: testCases,
      duration_ms,
      ...(dedupRejections?.length ? { dedupRejections } : {}),
    };
  }

  private async observe<T>(
    name: string,
    input: Record<string, unknown>,
    operation: () => Promise<T>,
    outputMapper?: (result: T) => unknown,
  ): Promise<T> {
    return startActiveObservation(name, async (span) => {
      span.update({ input });
      const result = await operation();
      span.update({ output: outputMapper ? outputMapper(result) : result });
      return result;
    });
  }

  // ── GET /llm/health ────────────────────────────────────────────────────────
  @Get('health')
  @ApiOperation({ summary: 'Check Ollama connectivity and list available models' })
  async health() {
    return this.observe(
      'llm.health',
      { endpoint: 'GET /llm/health' },
      async () => {
        const status = await this.llmService.healthCheck();
        return { timestamp: new Date().toISOString(), ollama: status };
      },
    );
  }

  // ── POST /llm/step2-test-cases ─────────────────────────────────────────────
  // ⚠️  Les TC sont retournés en mémoire UNIQUEMENT.
  //     Aucune sauvegarde en DB — la persistance se fait via POST /projects/requirements/:id/test-cases
  //     uniquement quand l'utilisateur valide un TC dans l'UI.
  @Post('step2-test-cases')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Step 2 — Générer les cas de test (mémoire uniquement, pas de DB)',
    description: `Les TC générés ne sont PAS sauvegardés en base.
La persistance se fait uniquement lorsque l'utilisateur clique "Valider" dans l'UI,
ce qui appelle POST /projects/requirements/:id/test-cases.`,
  })
  async step2TestCases(
    @Body() body: GenerateTestCasesDto,
    @Query('model') modelQuery?: string,
    @Query('nocache') nocache?: string,
  ) {
    return this.observe(
      'llm.step2-test-cases',
      {
        endpoint: 'POST /llm/step2-test-cases',
        model: body.model ?? null,
        project_id: body.project_id ?? null,
        nocache: nocache === 'true',
        module_count: body.requirements?.modules?.length ?? 0,
      },
      async () => {
        if (!body.requirements) {
          throw new BadRequestException('Missing "requirements".');
        }
        if (!body.requirements.modules?.length) {
          throw new BadRequestException('"requirements.modules" is empty.');
        }

        // Log the raw body from frontend
        const totalReqs = body.requirements.modules.reduce((acc, m) => acc + m.requirements.length, 0);
        this.logger.log(`📨 [FRONTEND DATA] Received step2: ${body.requirements.modules.length} modules, ${totalReqs} requirements, model=${body.model}, project=${body.project_id}, formData=${body.formData ? 'YES' : 'NO'}`);

        // Always use the default model (qwen2.5-coder:7b), ignore any model sent from frontend
        const model     = this.llmService['defaultModel'];
        this.logger.log(`🧪 /llm/step2-test-cases — ${body.requirements.modules.length} modules, ${totalReqs} reqs — NO DB SAVE${nocache ? ' [NOCACHE]' : ''}${body.formData ? ' [FormData]' : ''}`);

        const result = await this.llmService.generateTestCases(body.requirements, model, nocache === 'true', undefined, body.project_id, undefined, undefined, body.formData);

        // Aucun saveTestCases ici — retour mémoire uniquement
        return {
          success: result.success,
          timestamp: new Date().toISOString(),
          model: result.model,
          duration_ms: result.duration_ms,
          total_modules: result.total_modules,
          total_requirements: result.total_requirements,
          total_test_cases: result.total_test_cases,
          modules: result.modules,
          ...(result.errors?.length ? { errors: result.errors } : {}),
        };
      },
    );
  }

  @Post('generate-requirement/:requirementId')
  @ApiOperation({ summary: 'Générer les TC pour un SEUL requirement (avec contexte Myers optionnel et formData)' })
  async generateRequirementTC(
    @Param('requirementId') requirementId: string,
    @Body() body: { model?: string; project_id?: string; myersContext?: string; formData?: any; selectedScope?: string[]; approvedAngles?: { focus: string; tcType?: string }[]; forceAngleFocuses?: string[]; existingTcCount?: number },
  ) {
    return this.observe(
      'llm.generate-requirement-test-cases',
      {
        endpoint: 'POST /llm/generate-requirement/:requirementId',
        requirementId,
        project_id: body.project_id ?? null,
        model: body.model ?? null,
        has_myers_context: Boolean(body.myersContext),
        has_form_data: Boolean(body.formData),
        approved_angles_count: body.approvedAngles?.length ?? 0,
        force_angle_focuses_count: body.forceAngleFocuses?.length ?? 0,
        existing_tc_count: body.existingTcCount ?? null,
      },
      async () => {
        // ⚠️ Endpoint SYNCHRONE historique — conservé pour compatibilité, mais
        // fragile pour les gros requirements (30+ min observées) : voir les
        // endpoints /start + /job/:jobId ci-dessous, utilisés par le front
        // depuis la correction du 06/07/2026, qui évitent de garder une
        // requête HTTP ouverte pendant toute la durée de la génération.
        const prepared = this.prepareGenerateRequirementTC(requirementId, body);
        return this.executeGenerateRequirementTC(requirementId, body.selectedScope, prepared);
      },
    );
  }

  // ── POST /llm/generate-requirement/:requirementId/start ───────────────────
  // Version ASYNCHRONE : valide/sanitize les entrées puis renvoie un jobId
  // IMMÉDIATEMENT (avant même que le LLM ne soit appelé). La génération
  // tourne en tâche de fond ; le front récupère le résultat via polling sur
  // GET /llm/generate-requirement/job/:jobId. Ainsi aucune requête HTTP ne
  // reste ouverte plus de quelques secondes, ce qui élimine tout risque de
  // timeout (proxy Next.js, reverse-proxy, navigateur...) sur les
  // générations longues.
  @Post('generate-requirement/:requirementId/start')
  @ApiOperation({ summary: 'Démarre en tâche de fond la génération des TC pour un requirement et renvoie un jobId à poller' })
  async generateRequirementTCStart(
    @Param('requirementId') requirementId: string,
    @Body() body: { model?: string; project_id?: string; myersContext?: string; formData?: any; selectedScope?: string[]; approvedAngles?: { focus: string; tcType?: string }[]; forceAngleFocuses?: string[]; existingTcCount?: number; actorName?: string; actorId?: string; genMode?: 'fast' | 'assisted' | 'explicit' },
  ) {
    // Sanitisation synchrone : si l'entrée est invalide, l'erreur revient
    // tout de suite en 400, pas besoin de créer de job ni de poller.
    const prepared = this.prepareGenerateRequirementTC(requirementId, body);

    const job = this.jobStore.create();
    this.logger.log(`🧵 [Job ${job.id}] Génération démarrée en tâche de fond pour requirement=${requirementId}`);

    // Diffusion temps réel (best-effort) : les autres utilisateurs du projet
    // voient tout de suite qu'une génération est en cours sur ce requirement,
    // puis reçoivent les TC dès qu'ils sont prêts (voir jobStore.run ci-dessous).
    const projectId = await this.projectService.getProjectIdForRequirement(requirementId).catch(() => null);
    const actorName = body.actorName || 'Un utilisateur';
    const actorId = body.actorId;
    // Mode de génération choisi par l'utilisateur (Flash/Création/Signature) —
    // transmis par le front, purement informatif pour le badge des autres
    // utilisateurs (voir GenerationModeSelector côté frontend). `step` est
    // toujours 'testcases' ici : cet endpoint ne couvre que la Phase B (le
    // Phase A angles éventuel de Mode Création est déjà passé, voir
    // /preview-angles ci-dessous pour cette étape-là).
    const genMode = body.genMode;

    // Verrou anti-génération concurrente : si quelqu'un d'autre génère déjà
    // sur ce requirement, on refuse tout de suite plutôt que de gaspiller un
    // appel LLM et de risquer des TC en double. Best-effort : sans actorId
    // (route non protégée par JwtAuthGuard, voir plus haut), pas de verrou posé.
    if (actorId) {
      const lockedBy = this.realtimeGateway.tryLockGeneration(requirementId, actorId, actorName);
      if (lockedBy) {
        throw new BadRequestException(`${lockedBy.actorName} est déjà en train de générer des cas de test pour cette exigence — réessayez dans un instant.`);
      }
    }

    if (projectId) {
      this.realtimeGateway.emitToProject(projectId, 'generation:started', {
        projectId, requirementId, actorId, actorName, mode: 'bulk', genMode, step: 'testcases', at: new Date().toISOString(),
      });
      // Pas de JwtAuthGuard sur cet endpoint (voir constructeur) : pas de
      // user.sub disponible ici — on se base sur l'actorId fourni par le
      // front (useCurrentUser().id) pour afficher le point "génération en
      // cours" sur le bon avatar de présence. Best-effort, silencieux si absent.
      if (actorId) this.realtimeGateway.setActivity(projectId, actorId, 'generating', 'des cas de test');
    }

    this.jobStore.run(job.id, () =>
      this.executeGenerateRequirementTC(requirementId, body.selectedScope, prepared),
    ).then((result: any) => {
      if (!projectId) return;
      this.realtimeGateway.emitToProject(projectId, 'testcase:created', {
        projectId, requirementId, actorId, actorName,
        testCases: result?.test_cases ?? [],
        at: new Date().toISOString(),
      });
      this.realtimeGateway.emitToProject(projectId, 'generation:completed', {
        projectId, requirementId, actorId, actorName, mode: 'bulk', genMode, step: 'testcases', at: new Date().toISOString(),
      });
      if (actorId) this.realtimeGateway.setActivity(projectId, actorId, 'idle');
      // Journalisation persistée (voir project.controller.ts pour le même
      // traitement sur generate-single) : un membre absent au moment de la
      // génération la retrouve dans sa cloche de notifications.
      if (actorId) {
        const count = (result?.test_cases ?? []).length;
        // req_id = identifiant métier de l'exigence (ex: "FR-1.1"), à ne pas
        // confondre avec requirementId qui est l'UUID interne. module.name =
        // nom du module parent — les deux affichés dans le fil d'activité
        // pour resituer la génération sans avoir à cliquer dessus.
        this.prisma.requirement.findUnique({
          where: { id: requirementId },
          select: { req_id: true, module: { select: { name: true } } },
        })
          .then((req) => {
            const reqLabel = req?.req_id ? ` — ${req.req_id}` : '';
            const moduleLabel = req?.module?.name ? ` (${req.module.name})` : '';
            this.notificationsService
              .notifyProjectActivity({
                projectId, actorId, actorName, type: 'generation_activity',
                message: count > 1
                  ? `${actorName} a généré ${count} cas de test${reqLabel}${moduleLabel}.`
                  : `${actorName} a généré un cas de test${reqLabel}${moduleLabel}.`,
                entityType: 'requirement', entityId: requirementId,
              })
              .catch(() => {});
          })
          .catch(() => {});
      }
    }).catch(() => {
      if (!projectId) return;
      this.realtimeGateway.emitToProject(projectId, 'generation:completed', {
        projectId, requirementId, actorId, actorName, mode: 'bulk', genMode, step: 'testcases', error: true, at: new Date().toISOString(),
      });
      if (actorId) this.realtimeGateway.setActivity(projectId, actorId, 'idle');
    }).finally(() => {
      if (actorId) this.realtimeGateway.unlockGeneration(requirementId, actorId);
    });

    return { jobId: job.id, status: job.status };
  }

  // ── GET /llm/generate-requirement/job/:jobId ───────────────────────────────
  @Get('generate-requirement/job/:jobId')
  @ApiOperation({ summary: 'Consulte le statut/résultat d\'un job de génération démarré via /start' })
  async generateRequirementTCJobStatus(@Param('jobId') jobId: string) {
    const job = this.jobStore.get(jobId);
    if (!job) {
      throw new BadRequestException(`Job introuvable ou expiré : ${jobId}`);
    }
    if (job.status === 'error') {
      return { jobId: job.id, status: job.status, error: job.error };
    }
    if (job.status === 'done') {
      return { jobId: job.id, status: job.status, ...job.result };
    }
    return { jobId: job.id, status: job.status };
  }

  @Post('preview-angles/:requirementId')
  @ApiOperation({ summary: 'Mode Création — Prévisualiser les angles Phase A avant génération (résumé + liste d\'angles à valider)' })
  async previewAngles(
    @Param('requirementId') requirementId: string,
    @Body() body: { model?: string; project_id?: string; myersContext?: string; formData?: any; selectedScope?: string[]; actorId?: string; actorName?: string },
  ) {
    return this.observe(
      'llm.preview-angles',
      {
        endpoint: 'POST /llm/preview-angles/:requirementId',
        requirementId,
        project_id: body.project_id ?? null,
        model: body.model ?? null,
        has_myers_context: Boolean(body.myersContext),
        has_form_data: Boolean(body.formData),
      },
      async () => {
        if (!requirementId) {
          throw new BadRequestException('Missing "requirementId"');
        }

        this.logger.log(`📨 [FRONTEND DATA] preview-angles: requirementId=${requirementId}, model=${body.model}, project=${body.project_id}, myersContext=${body.myersContext ? 'YES' : 'NO'}, formData=${body.formData ? 'YES' : 'NO'}`);

        let safeMyersContext: string | undefined;
        let safeFormData: any;
        try {
          safeMyersContext = sanitizeMyersContext(body.myersContext);
          safeFormData     = sanitizeFormData(body.formData);
        } catch (err) {
          if (err instanceof SanitizationError) {
            this.logger.warn(`🚫 [InputSanitizer] Entrée rejetée : ${err.message}`);
            throw new BadRequestException(err.message);
          }
          throw err;
        }

        // Always use the default model (qwen2.5-coder:7b), ignore any model sent from frontend
        const model     = this.llmService['defaultModel'];
        const projectId = body.project_id || 'default';

        this.logger.log(`🔎 /llm/preview-angles/${requirementId} — model: ${model}, project: ${projectId}, myers: ${!!safeMyersContext}, formData: ${!!safeFormData}, selectedScope: ${Array.isArray(body.selectedScope) ? body.selectedScope.join(',') : ''}`);

        // Diffusion temps réel (best-effort, PAS de verrou anti-concurrence
        // ici — la Phase A angles n'a pas d'effet de bord partagé, plusieurs
        // utilisateurs peuvent la lancer en parallèle sans risque de doublon).
        // Sert uniquement à ce que le badge/bandeau des autres utilisateurs
        // affiche précisément "génère les angles de test" plutôt qu'un
        // message générique — voir GenerationModeSelector/AnglesPreview.
        const realProjectId = projectId !== 'default'
          ? projectId
          : await this.projectService.getProjectIdForRequirement(requirementId).catch(() => null);
        const actorId = body.actorId;
        const actorName = body.actorName || 'Un utilisateur';
        if (realProjectId) {
          this.realtimeGateway.emitToProject(realProjectId, 'generation:started', {
            projectId: realProjectId, requirementId, actorId, actorName, mode: 'bulk', genMode: 'assisted', step: 'angles', at: new Date().toISOString(),
          });
        }

        try {
          const { summary, angles, duration_ms, requirementQuality } = await this.llmService.previewRequirementAngles(
            requirementId,
            model,
            projectId,
            body.selectedScope,
            safeMyersContext,
            safeFormData,
          );

          return {
            success: true,
            timestamp: new Date().toISOString(),
            summary,
            angles,
            duration_ms,
            requirementQuality,
          };
        } finally {
          if (realProjectId) {
            this.realtimeGateway.emitToProject(realProjectId, 'generation:completed', {
              projectId: realProjectId, requirementId, actorId, actorName, mode: 'bulk', genMode: 'assisted', step: 'angles', at: new Date().toISOString(),
            });
          }
        }
      },
    );
  }

  // ── POST /llm/generation-presence ──────────────────────────────────────────
  // Signal purement informatif (aucun verrou posé) pour couvrir les phases
  // sans appel LLM qui doivent quand même apparaître dans le bandeau "X est
  // en train de..." des autres utilisateurs — aujourd'hui : le remplissage
  // du formulaire assisté de Mode Signature (avant que l'utilisateur clique
  // sur Générer). `active: true` au montage du formulaire, `active: false`
  // à sa fermeture ; si l'utilisateur clique Générer entre-temps, l'étape
  // 'testcases' de /generate-requirement/:id/start prend le relais.
  @Post('generation-presence')
  @ApiOperation({ summary: 'Signal temps réel best-effort pour les étapes de génération sans appel LLM (ex: remplissage du formulaire Mode Signature)' })
  async generationPresence(
    @Body() body: { requirementId: string; projectId?: string; actorId?: string; actorName?: string; genMode?: 'fast' | 'assisted' | 'explicit'; step?: 'form'; active: boolean },
  ) {
    if (!body?.requirementId) throw new BadRequestException('Missing "requirementId"');
    const projectId = body.projectId || await this.projectService.getProjectIdForRequirement(body.requirementId).catch(() => null);
    if (!projectId) return { success: true };
    const actorName = body.actorName || 'Un utilisateur';
    this.realtimeGateway.emitToProject(projectId, body.active ? 'generation:started' : 'generation:completed', {
      projectId, requirementId: body.requirementId, actorId: body.actorId, actorName,
      mode: 'bulk', genMode: body.genMode, step: body.step || 'form', at: new Date().toISOString(),
    });
    return { success: true };
  }

  // ── POST /llm/token-count ──────────────────────────────────────────────────
  @Post('token-count')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Compte les tokens exacts via tokenizer Python Qwen2.5-Coder' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        text: { type: 'string', example: 'Le texte à tokeniser' },
      },
      required: ['text'],
    },
  })
  async tokenCount(@Body() body: { text: string }) {
    if (!body.text) {
      throw new BadRequestException('Champ "text" requis.');
    }

    const result = await this.tokenizerService.countTokens(body.text);
    return result;
  }
}
