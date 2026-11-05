import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { ChatOllama } from '@langchain/ollama';

import { PrismaService } from '../prisma/prisma.service';
import { SrsService } from '../srs/srs.service';
import { CacheService } from '../cache/cache.service';
import { MongoVectorService } from '../vector/mongo-vector.service';
import { ProjectService } from '../project/project.service';
import { SemanticDeduplicator } from '../shared/semantic-dedup.service';
import { LangfuseService } from '../shared/langfuse.service';
import { translateBatch } from '../shared/translation.service';

// ─── Shared utilities (source de vérité unique) ───────────────────────────────
import { normalizeTcType, MIN_TC_PER_REQ, ADAPTIVE_TC_FLOOR, MAX_PHASE_A_ANGLES, VALID_TC_TYPES } from '../shared/tc-types';
import {
  buildPhaseAPrompt,
  buildPhaseAPromptRelaxed,
  buildTcBudgetPrompt,
  buildPhaseBPrompt,
  BASE_SYSTEM_PROMPT,
  TestAngle,
  ExistingTC,
  FormDataInput,
} from '../shared/prompt-builders';
import {
  safeParseJson,
  validateTestCase,
  runWithConcurrency,
  getDedupeThreshold,
} from '../shared/tc-utils';
import {
  callOllama,
  PHASE_A_OPTIONS,
  PHASE_A_RECOVERY_OPTIONS,
  PHASE_B_OPTIONS,
  TC_BUDGET_ESTIMATE_OPTIONS,
  OllamaOptions,
} from '../shared/ollama-client';


// ─── Interfaces publiques ─────────────────────────────────────────────────────

export interface ExtractedRequirement {
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  type: 'functional' | 'non-functional';
  refCode?: string;
  source: 'explicit' | 'inferred';
}

export interface ExtractedModule {
  name: string;
  description: string;
  requirements: ExtractedRequirement[];
}

export interface RequirementsJson {
  document_type: string;
  modules: {
    name: string;
    description: string;
    requirements: {
      id: string;
      description: string;
      priority: 'SHALL' | 'MUST' | 'SHOULD' | 'MAY';
    }[];
  }[];
}

export interface LlmGenerationResult {
  success: boolean;
  model: string;
  data?: RequirementsJson;
  raw?: string;
  error?: string;
  duration_ms: number;
  chunks_processed?: number;
}

export interface TestCase {
  testId: string;
  moduleId: string;
  requirementId: string;
  title: string;
  preconditions: string[];
  steps: string[];
  testData: string[];
  expectedResult: string;
  type: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface RequirementWithTests {
  id: string;
  description: string;
  priority: 'SHALL' | 'MUST' | 'SHOULD' | 'MAY';
  total_test_cases: number;
  test_cases: TestCase[];
}

export interface ModuleWithTests {
  name: string;
  description: string;
  total_requirements: number;
  total_test_cases: number;
  requirements: RequirementWithTests[];
}

export interface TestCaseGenerationResult {
  success: boolean;
  model: string;
  duration_ms: number;
  chunks_processed: number;
  total_modules: number;
  total_requirements: number;
  total_test_cases: number;
  modules: ModuleWithTests[];
  errors?: string[];
  dedupRejections?: { focus: string; tcType?: string; attemptedTitle: string; similarTitle?: string; reason: string }[]; // Mode Création — angles rejetés par dedup, proposés en re-validation
}

interface MyersFormVerificationInput {
  requirement: {
    reqId?: string;
    reqUUID?: string;
    reqDesc?: string;
    module?: string;
    priority?: string;
  };
  selectedScope: string[];
  formData: {
    validInputClasses?: string[];
    invalidInputClasses?: string[];
    businessRules?: string[];
  };
  rawFields?: Record<string, string>;
  myersContext?: string;
  model?: string;
}

export interface MyersFormVerificationResult {
  status: 'ok' | 'warning' | 'error';
  summary: string;
  issues: string[];
  suggestions: string[];
  fieldSuggestions?: Record<string, string>;
}

// ─── Constantes ────────────────────────────────────────────────────────────────

const MAX_SECTION_CHARS   = 15_000;
const PHASE_B_CONCURRENCY = 1; // Ollama 7B mono-thread : la concurrence > 1 crée de la contention sans gain

/**
 * Extraire le champ (field) référencé dans un focus d'angle ou un titre TC.
 * Utilise des regex word-boundaries pour éviter les faux positifs.
 * Priorise les champs plus spécifiques (password, email) avant les génériques (name).
 */
function extractFieldFromFocus(text: string): string {
  if (!text) return 'unknown';
  
  const t = text.toLowerCase();
  
  // Patterns ordonnés par spécificité (du plus au moins spécifique)
  // Utilise \b ou _ pour les word boundaries
  const patterns = [
    /\b(password|pwd|mot\s*de\s*passe)\b/,   // password field
    /\b(email|e-mail|mail)\b/,                // email field
    /\b(username|user_name|user\s+name)\b/,  // username field
    /\b(phone|telephone|tel|mobile|numero|num[eé]ro)\b/,  // phone field
    /\b(gender|sex)\b/,                       // gender field
    /\b(prenom|pr[eé]nom|first_?name|firstname)\b/, // first name (FR+EN)
    /\b(nom|last_?name|lastname|surname)\b/,  // last name (FR+EN)
    /\b(full_?name|fullname)\b/,              // full name
    /\b(address|addr|adresse)\b/,             // address field
    /\b(city|town|ville)\b/,                  // city field
    /\b(date|dob|birth)\b/,                   // date field
    /\b(zipcode|zip|postal|code)\b/,          // zipcode field
  ];
  
  // Chercher la première correspondance (patterns déjà ordonnés)
  for (const pattern of patterns) {
    if (pattern.test(t)) {
      // Extraire juste le nom du champ (premier group) en minuscules
      const match = t.match(pattern);
      if (match?.[1]) {
        // Normaliser : "first_name" -> "first_name", "firstname" -> "first_name"
        return match[1].replace(/\s+/g, '_').toLowerCase();
      }
    }
  }
  
  return 'unknown';
}

/**
 * Extraire la direction et valeur pour un TC boundary.
 * Retourne un object { direction: 'min' | 'max' | 'min-1' | 'max+1', value?: number }
 * 
 * Exemples :
 *   "Password: minimum 8 characters" → { direction: 'min', value: 8 }
 *   "Email: 254 characters maximum" → { direction: 'max', value: 254 }
 *   "Username: exactly 3 characters" → { direction: 'exact', value: 3 }
 */
function extractBoundaryDirection(title: string): { direction: string; value?: number } {
  if (!title) return { direction: 'unknown' };

  const t = title.toLowerCase();

  // PRIORITÉ 1 : labels explicites (min)/(max) — vérifiés AVANT "exactly N"
  // pour éviter que "exactly 2 (min)" et "exactly 50 (max)" aient tous deux direction='exact'
  if (/\(\s*min\s*\)/.test(t) || /\bmin(?:imum)?\b/.test(t)) {
    const numMatch = t.match(/(\d+)/);
    return { direction: 'min', value: numMatch ? parseInt(numMatch[1], 10) : undefined };
  }
  if (/\(\s*max\s*\)/.test(t) || /\bmax(?:imum)?\b/.test(t)) {
    const numMatch = t.match(/(\d+)/);
    return { direction: 'max', value: numMatch ? parseInt(numMatch[1], 10) : undefined };
  }

  // PRIORITÉ 2 : "exactly N"
  const exactMatch = t.match(/(?:exactly|exact)\s+(\d+)|(\d+)\s+(?:exactly|exact)/);
  if (exactMatch) {
    const value = parseInt(exactMatch[1] ?? exactMatch[2], 10);
    return { direction: 'exact', value };
  }

  // PRIORITÉ 3 : min-1 / max+1
  if (/min\s*-\s*1|one\s+(?:less|fewer)\s+than\s+min/i.test(t)) {
    const valueMatch = t.match(/(\d+)\s*(?:char|digit)/);
    return { direction: 'min-1', value: valueMatch ? parseInt(valueMatch[1], 10) - 1 : undefined };
  }
  if (/max\s*\+\s*1|one\s+more\s+than\s+max/i.test(t)) {
    const valueMatch = t.match(/(\d+)\s*(?:char|digit)/);
    return { direction: 'max+1', value: valueMatch ? parseInt(valueMatch[1], 10) + 1 : undefined };
  }

  return { direction: 'unknown' };
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly ollamaUrl: string;
  private readonly defaultModel: string;

  private _busy = false;
  private _busyQueue: Array<() => void> = [];

  private readonly PHASE_A_TIMEOUT_MS = 150_000;  // Increased: formData+myersContext prompts need more time
  private readonly PHASE_B_TIMEOUT_MS = 90_000;   // 90 s suffisent — une réponse LLM > 90s sera tronquée/inutilisable

  private llm: ChatOllama;
  private availableModels: string[] | null = null;
  private lastModelRefreshMs = 0;
  private readonly MODEL_CACHE_TTL_MS = 60000; // Refresh model list every minute

  constructor(
    private config: ConfigService,
    private readonly cacheService: CacheService,
    private readonly mongoVector: MongoVectorService,
    private readonly prisma: PrismaService,
    private readonly srsService: SrsService,
    @Inject(forwardRef(() => ProjectService))
    private readonly projectService: ProjectService,
    private readonly semanticDedup: SemanticDeduplicator,
    private readonly langfuseService: LangfuseService,
  ) {
    this.ollamaUrl    = this.config.get('OLLAMA_BASE_URL', 'http://localhost:11434');
    this.defaultModel = this.config.get('OLLAMA_MODEL', 'qwen2.5-coder:7b');
    this.llm = new ChatOllama({
      baseUrl: this.ollamaUrl, model: this.defaultModel,
      temperature: 0, format: 'json', numCtx: 16384,
    });
  }

  // ── Lock ──────────────────────────────────────────────────────────────────────

  private async acquireLock(): Promise<void> {
    if (!this._busy) { this._busy = true; return; }
    return new Promise<void>(resolve => this._busyQueue.push(resolve));
  }

  private releaseLock(): void {
    const next = this._busyQueue.shift();
    if (next) next(); else this._busy = false;
  }

  // ── callOllama (délègue au client partagé) ────────────────────────────────────

  private async _callOllama(
    model: string,
    userMessage: string,
    signal?: AbortSignal,
    systemPrompt?: string,
    options: OllamaOptions = PHASE_B_OPTIONS,
    langfuseGeneration?: any,
  ): Promise<any> {
    const validatedModel = await this.ensureModelAvailable(model);
    return callOllama(this.ollamaUrl, validatedModel, userMessage, signal, systemPrompt, options, langfuseGeneration);
  }

 private createLangfuseTrace(name: string, userId: string, metadata: Record<string, any>, sessionId?: string): any {
  return this.langfuseService.client.trace({
    name,
    userId,
    sessionId: sessionId ?? userId, // ← par défaut = projectId si pas de sessionId
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
    return trace?.generation({
      name,
      model,
      input: [{ role: 'user', content: prompt }],
      metadata,
    });
  }

  /**
   * Exécute un chain LangChain (PromptTemplate → this.llm → StringOutputParser)
   * en traçant l'appel dans Langfuse (une "generation" par appel, rattachée à
   * `langfuseTrace`). Utilisé par le pipeline d'extraction des modules/exigences
   * pour avoir la même visibilité Langfuse que la génération de test cases.
   */
  private async invokeLlmChain(
    promptTemplate: PromptTemplate,
    invokeArgs: Record<string, any>,
    langfuseTrace: any,
    generationName: string,
    metadata: Record<string, any> = {},
  ): Promise<string> {
    let promptText = '';
    try { promptText = await promptTemplate.format(invokeArgs); } catch { /* préview non bloquante */ }

    const generation = this.createLangfuseGeneration(langfuseTrace, generationName, this.defaultModel, promptText, metadata);
    const chain = promptTemplate.pipe(this.llm).pipe(new StringOutputParser());
    try {
      const raw = await chain.invoke(invokeArgs);
      generation?.end({
        output: raw,
        level: 'DEFAULT',
        statusMessage: `✓ ${generationName} — ${raw?.length ?? 0} chars`,
        metadata: { ...metadata, 'response.content_chars': raw?.length ?? 0 },
      });
      return raw;
    } catch (err: any) {
      generation?.end({
        level: 'ERROR',
        statusMessage: `✗ ${generationName} failed: ${err.message}`,
        metadata,
      });
      throw err;
    }
  }

  /**
   * Evalue un TC genere via Ollama local et envoie les scores a Langfuse.
   * Fire-and-forget : n'attend pas le resultat pour ne pas ralentir la generation.
   *
   * Scores envoyes :
   *   tc-clarity         - les steps sont clairs et executables (0-1)
   *   tc-coverage        - le TC couvre bien l'angle teste (0-1)
   *   tc-expected-result - l'expected result est precis et verifiable (0-1)
   */
  private async evaluateTcWithOllama(
    tc: TestCase,
    requirementDesc: string,
    model: string,
    traceId: string,
    observationId: string,
  ): Promise<void> {
    const evalPrompt = `You are a QA evaluator. Rate this test case strictly.

REQUIREMENT: ${requirementDesc}

TEST CASE:
Title: ${tc.title}
Type: ${tc.type}
Steps: ${(tc.steps || []).join(' | ')}
Expected Result: ${tc.expectedResult}

Return ONLY this JSON (no preamble, no markdown):
{
  "tc_clarity": <0.0-1.0>,
  "tc_coverage": <0.0-1.0>,
  "tc_expected_result": <0.0-1.0>
}

SCORING RULES:
- tc_clarity: Are steps precise, numbered and executable by a human tester?
  0.0=vague  0.5=partially clear  1.0=perfectly actionable
- tc_coverage: Does the TC fully cover its stated type (${tc.type})?
  0.0=unrelated  0.5=partial  1.0=fully covers the angle
- tc_expected_result: Is the expected result specific and verifiable?
  0.0=generic ("should work")  0.5=partially  1.0=precise and measurable`;

    try {
      const response = await callOllama(
        this.ollamaUrl,
        'llama3.1:8b',
        evalPrompt,
        undefined,
        'You are a JSON API. Output ONLY raw valid JSON starting with {.',
        {
          temperature: 0,
          num_predict: 120,
          num_ctx: 2048,
          top_k: 1,
          top_p: 1,
          repeat_penalty: 1.0,
          repeat_last_n: 64,
        },
      );

      const raw = (response?.message?.content || '').trim();
      const parsed = safeParseJson(raw);

      if (
        parsed &&
        typeof parsed.tc_clarity === 'number' &&
        typeof parsed.tc_coverage === 'number' &&
        typeof parsed.tc_expected_result === 'number'
      ) {
        await this.langfuseService.scoreGeneration(traceId, observationId, {
          'tc-clarity': Math.min(1, Math.max(0, parsed.tc_clarity)),
          'tc-coverage': Math.min(1, Math.max(0, parsed.tc_coverage)),
          'tc-expected-result': Math.min(1, Math.max(0, parsed.tc_expected_result)),
        });
        this.logger.debug(
          `📊 [Eval TC] "${tc.title}" → clarity=${parsed.tc_clarity} coverage=${parsed.tc_coverage} expected=${parsed.tc_expected_result}`,
        );
      } else {
        this.logger.warn(`⚠️ [Eval TC] Invalid scores format for "${tc.title}": ${raw.slice(0, 100)}`);
      }
    } catch (err: any) {
      this.logger.warn(`⚠️ [Eval TC] Failed for "${tc.title}": ${err.message}`);
    }
  }

  /**
   * Evalue les angles generes en Phase A via Ollama local.
   *
   * Scores envoyes :
   *   angle-relevance - les angles sont pertinents pour le requirement (0-1)
   *   angle-diversity - les angles couvrent des scenarios distincts (0-1)
   */
  private async evaluateAnglesWithOllama(
    angles: TestAngle[],
    requirementDesc: string,
    traceId: string,
    observationId: string,
  ): Promise<void> {
    const angleList = angles
      .map((a, i) => `${i + 1}. [${a.tcType ?? 'unknown'}] ${a.focus}`)
      .join('\n');

    const evalPrompt = `You are a QA evaluator. Rate these test angles.

REQUIREMENT: ${requirementDesc}

GENERATED ANGLES:
${angleList}

Return ONLY this JSON (no preamble, no markdown):
{
  "angle_relevance": <0.0-1.0>,
  "angle_diversity": <0.0-1.0>
}

SCORING RULES:
- angle_relevance: Are all angles relevant and useful for testing this requirement?
  0.0=off-topic  0.5=partially relevant  1.0=all angles directly test the requirement
- angle_diversity: Do the angles cover distinct scenarios (positive, negative, boundary, etc.)?
  0.0=all similar  0.5=some overlap  1.0=fully diverse coverage`;

    try {
      const response = await callOllama(
        this.ollamaUrl,
        'llama3.1:8b',
        evalPrompt,
        undefined,
        'You are a JSON API. Output ONLY raw valid JSON starting with {.',
        {
          temperature: 0,
          num_predict: 80,
          num_ctx: 2048,
          top_k: 1,
          top_p: 1,
          repeat_penalty: 1.0,
          repeat_last_n: 64,
        },
      );

      const raw = (response?.message?.content || '').trim();
      const parsed = safeParseJson(raw);

      if (
        parsed &&
        typeof parsed.angle_relevance === 'number' &&
        typeof parsed.angle_diversity === 'number'
      ) {
        await this.langfuseService.scoreGeneration(traceId, observationId, {
          'angle-relevance': Math.min(1, Math.max(0, parsed.angle_relevance)),
          'angle-diversity': Math.min(1, Math.max(0, parsed.angle_diversity)),
        });
        this.logger.debug(
          `📊 [Eval Angles] relevance=${parsed.angle_relevance} diversity=${parsed.angle_diversity}`,
        );
      } else {
        this.logger.warn(`⚠️ [Eval Angles] Invalid scores format: ${raw.slice(0, 100)}`);
      }
    } catch (err: any) {
      this.logger.warn(`⚠️ [Eval Angles] Failed: ${err.message}`);
    }
  }

  private hasModelListChanged(previous: string[] | null, next: string[]): boolean {
    if (!previous) return true;
    if (previous.length !== next.length) return true;

    const prevSorted = [...previous].sort();
    const nextSorted = [...next].sort();
    for (let i = 0; i < prevSorted.length; i++) {
      if (prevSorted[i] !== nextSorted[i]) return true;
    }
    return false;
  }

  // ── Model validation ──────────────────────────────────────────────────────────

  private async ensureModelAvailable(requestedModel: string): Promise<string> {
    // Always use defaultModel if requested is not provided or is empty
    if (!requestedModel || requestedModel.trim().length === 0) {
      return this.defaultModel;
    }

    // Refresh model cache if needed
    const now = Date.now();
    if (!this.availableModels || (now - this.lastModelRefreshMs > this.MODEL_CACHE_TTL_MS)) {
      try {
        const health = await this.healthCheck();
        const newModels = health.models || [];
        const changed = this.hasModelListChanged(this.availableModels, newModels);
        this.availableModels = newModels;
        this.lastModelRefreshMs = now;
        if (changed) {
          this.logger.debug(`✅ Model cache refreshed: ${this.availableModels.length} models available`);
        }
      } catch (err) {
        this.logger.warn(`⚠️ Failed to refresh model cache: ${err}`);
        // Use last known cache, or default if cache is empty
        if (!this.availableModels || this.availableModels.length === 0) {
          return this.defaultModel;
        }
      }
    }

    // Check if requested model is available
    if (this.availableModels && this.availableModels.includes(requestedModel)) {
      return requestedModel;
    }

    // Model not found — log warning and fallback to default
    this.logger.warn(
      `⚠️ Model '${requestedModel}' not found. Falling back to '${this.defaultModel}'. Available: ${this.availableModels?.join(', ') || 'unknown'}`
    );
    return this.defaultModel;
  }

  // ── Validation + self-critique ────────────────────────────────────────────────

  private validateTestCaseStructure(
    tc: Partial<TestCase>,
    existingTitles: string[] = [],
    businessRules: string[] = [],
  ): { valid: boolean; issues: string[] } {
    return validateTestCase(tc, existingTitles, businessRules);
  }

  // ── Phase A ───────────────────────────────────────────────────────────────────

  // ── Estimation adaptative du budget de TC ──────────────────────────────────
  //
  // Appelée UNE FOIS par exigence, avant Phase A. Remplace le quota fixe
  // MIN_TC_PER_REQ=20 / 8 types imposés à toutes les exigences par une
  // estimation propre à CETTE exigence : combien de TC distincts ont
  // réellement un sens, et lesquels des types "avancés" (state_transition,
  // security, integration, concurrency) ont un scénario plausible.
  //
  // Coût : ~10-20s (num_predict=200, prompt court). En échange, on évite :
  //  - de réclamer en Phase A des types qui n'existent pas pour l'exigence
  //    (le LLM hallucine ou sous-livre) ;
  //  - un round de rattrapage complet (~70-100s) systématiquement voué à
  //    l'échec pour ces exigences (voir logs du 06/07/2026 : 0 angle retenu).
  //
  // Fail-safe : toute erreur (timeout, JSON invalide, réponse absente) fait
  // retomber sur le comportement historique (MIN_TC_PER_REQ, tous les types)
  // — cette estimation ne peut donc jamais dégrader la couverture existante,
  // seulement l'améliorer ou la laisser inchangée.
  private async estimateTcBudget(
    moduleName: string,
    req: { id: string; description: string; priority: string },
    model: string,
    formData?: FormDataInput,
    scopeIds?: string[],
    langfuseTrace?: any,
  ): Promise<{ targetCount: number; allowedAdvancedTypes: string[] }> {
    const fallback = { targetCount: MIN_TC_PER_REQ, allowedAdvancedTypes: ['state_transition', 'security', 'integration', 'concurrency'] };

    try {
      const prompt = await buildTcBudgetPrompt(moduleName, req, formData, scopeIds);
      const generation = this.createLangfuseGeneration(langfuseTrace, 'tc-budget-estimate', model, prompt, {
        requirementId: req.id,
        moduleName,
      });
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 30_000); // court — c'est une estimation, pas une génération
      let response;
      try {
        response = await this._callOllama(model, prompt, ctrl.signal, BASE_SYSTEM_PROMPT, TC_BUDGET_ESTIMATE_OPTIONS, generation);
      } finally {
        clearTimeout(timeout);
      }

      const parsed = safeParseJson(response?.message?.content || '');
      if (!parsed) return fallback;

      const rawTotal = Number(parsed.recommended_total);
      const targetCount = Number.isFinite(rawTotal)
        ? Math.max(ADAPTIVE_TC_FLOOR, Math.min(MIN_TC_PER_REQ, Math.round(rawTotal)))
        : fallback.targetCount;

      const advancedSet = new Set(['state_transition', 'security', 'integration', 'concurrency']);
      const allowedAdvancedTypes = Array.isArray(parsed.applicable_types)
        ? parsed.applicable_types
            .filter((t: any) => typeof t === 'string')
            .map((t: string) => t.trim().toLowerCase())
            .filter((t: string) => advancedSet.has(t) && (VALID_TC_TYPES as readonly string[]).includes(t))
        : fallback.allowedAdvancedTypes;

      this.logger.log(`🎯 [Budget adaptatif] ${req.id} — target=${targetCount}/${MIN_TC_PER_REQ}, types avancés retenus: ${allowedAdvancedTypes.join(', ') || 'aucun'}`);
      return { targetCount, allowedAdvancedTypes };
    } catch (err: any) {
      this.logger.warn(`⚠️ [Budget adaptatif] Estimation échouée pour ${req.id}, fallback sur défaut (${MIN_TC_PER_REQ}/tous types): ${err.message}`);
      return fallback;
    }
  }

  private async runPhaseA(
    moduleName: string,
    req: { id: string; description: string; priority: string },
    model: string,
    signal?: AbortSignal,
    existingTCs: ExistingTC[] = [],
    instruction?: string,
    formData?: FormDataInput,
    scopeIds?: string[],
    langfuseTrace?: any,
    prebuiltPrompt?: string,  // Problème C — prompt pré-construit (rattrapage relaxed)
    targetCount?: number,             // ← budget adaptatif (voir estimateTcBudget)
    allowedAdvancedTypes?: string[],  // ← idem — types "avancés" pertinents pour cette exigence
  ): Promise<TestAngle[]> {
    this.logger.log(`📤 [Phase A - SENDING TO LLM]`);
    this.logger.log(`   ├─ Module: "${moduleName}"`);
    this.logger.log(`   ├─ Requirement ID: "${req.id}"`);
    this.logger.log(`   ├─ Priority: "${req.priority}"`);
    this.logger.log(`   ├─ Description: "${req.description}"`);
    this.logger.log(`   ├─ Existing TCs: ${existingTCs.length} items`);
    this.logger.log(`   ├─ User Instruction: ${instruction ? 'YES' : 'NO'}`);
    this.logger.log(`   ├─ FormData: ${formData ? 'YES' : 'NO'}`);
    this.logger.log(`   ├─ ScopeIds: ${scopeIds?.length ?? 0}`);
    this.logger.log(`   └─ Model: "${model}"`);

    // Si un prompt pré-construit est fourni (ex: rattrapage relaxé), on l'utilise directement
    const prompt = prebuiltPrompt ?? await buildPhaseAPrompt(moduleName, req, instruction, existingTCs, formData, scopeIds, targetCount, allowedAdvancedTypes);
    
    try {
      const generation = this.createLangfuseGeneration(langfuseTrace, 'phase-a-test-case', model, prompt, {
        requirementId: req.id,
        moduleName,
      });
      // rattrapage = prompt pré-construit court → preset allégé (num_predict 600, num_ctx 3072)
      const phaseAOpts = prebuiltPrompt ? PHASE_A_RECOVERY_OPTIONS : PHASE_A_OPTIONS;
      const response = await this._callOllama(model, prompt, signal, BASE_SYSTEM_PROMPT, phaseAOpts, generation);
      const parsed   = safeParseJson(response?.message?.content || '');
      if (parsed?.angles && Array.isArray(parsed.angles) && parsed.angles.length > 0) {
        const angles: TestAngle[] = parsed.angles
          .slice(0, MAX_PHASE_A_ANGLES)
          .filter((a: any) => typeof a.focus === 'string' && a.focus.trim().length > 10)
          .map((a: any) => ({
            focus:  a.focus.trim(),
            tcType: typeof a.type === 'string' ? a.type.trim().toLowerCase() : undefined,
          }));
        if (angles.length >= 3) {
          this.logger.log(`✅ [Phase A - LLM RECEIVED] Generated ${angles.length} angles with requirement info`);

          // ── Evaluation des angles — différée après fin du pipeline ──────────
          // Fire-and-forget : ne bloque jamais la réponse au client. Partage le
          // même Ollama que qwen/mistral (mono-thread 7B) → peut ralentir des
          // générations concurrentes si le trafic est élevé. À surveiller ;
          // si contention avérée, déplacer l'éval sur un port Ollama séparé.
          if (langfuseTrace?.id && generation?.id) {
            this.evaluateAnglesWithOllama(angles, req.description, langfuseTrace.id, generation.id).catch(() => {});
          }

          return angles;
        }
      }
    } catch (err: any) {
      this.logger.warn(`⚠️ [Phase A] Failed for ${req.id}: ${err.message}`);
    }

    // Retry avec le même prompt et température légèrement augmentée.
    // Un petit modèle produit parfois un JSON valide au 2ème essai sans
    // avoir besoin d'un prompt différent — évite la surface de code du fallback relaxed.
    //
    // Budget DÉDIÉ (60s) plutôt que le `signal` de la 1ère tentative : ce
    // signal est lié à un setTimeout absolu démarré au début de l'appelant
    // (ex: PHASE_A_TIMEOUT_MS=150s). Si la 1ère tentative a déjà consommé
    // l'essentiel de ce budget (LLM local lent), le retry héritait d'un
    // signal quasi expiré et échouait systématiquement et immédiatement
    // → angles=[] alors qu'un retry frais aurait pu réussir. On respecte
    // toujours une annulation externe explicite (ex: fermeture de la
    // requête) en la propageant vers le nouveau contrôleur.
    const ctrlRetry = new AbortController();
    const timeoutRetry = setTimeout(() => ctrlRetry.abort(), 60_000);
    const onExternalAbort = () => ctrlRetry.abort();
    signal?.addEventListener('abort', onExternalAbort);
    try {
      this.logger.warn(`⚠️ [Phase A] Retry attempt for ${req.id}`);
      const generation2 = this.createLangfuseGeneration(langfuseTrace, 'phase-a-retry', model, prompt, {
        requirementId: req.id,
        moduleName,
      });
      const response2 = await this._callOllama(
        model, prompt,
        ctrlRetry.signal, BASE_SYSTEM_PROMPT,
        { ...PHASE_A_OPTIONS, temperature: 0.1 },
        generation2,
      );
      const parsed2 = safeParseJson(response2?.message?.content || '');
      if (parsed2?.angles && Array.isArray(parsed2.angles) && parsed2.angles.length >= 3) {
        return parsed2.angles
          .slice(0, MAX_PHASE_A_ANGLES)
          .map((a: any) => ({
            focus:  (a.focus || '').trim(),
            tcType: typeof a.type === 'string' ? a.type.trim().toLowerCase() : undefined,
          }))
          .filter((a: TestAngle) => a.focus.length > 5);
      }
    } catch { /* fallthrough */ }
    finally {
      clearTimeout(timeoutRetry);
      signal?.removeEventListener('abort', onExternalAbort);
    }

    return [];
  }

  // ── Phase B ───────────────────────────────────────────────────────────────────

  private async runPhaseB(
    moduleName: string,
    req: { id: string; description: string; priority: string },
    angle: TestAngle,
    forbiddenTitles: string[],
    model: string,
    tcId: string,
    signal?: AbortSignal,
    existingTCs: ExistingTC[] = [],
    instruction?: string,
    scopeIds?: string[],
    langfuseTrace?: any,
    formData?: FormDataInput,
    temperatureOverride?: number,  // ← voir boucle de retry : PHASE_B_OPTIONS.temperature=0 rend
                                    // un retry identique inutile après un rejet SemanticDedup —
                                    // ce paramètre permet de réellement varier la sortie au retry.
  ): Promise<TestCase | null> {
    this.logger.log(`📤 [Phase B - SENDING TO LLM] tcId="${tcId}"`);
    this.logger.log(`   ├─ Requirement: "${req.id}" - "${req.description}"`);
    this.logger.log(`   ├─ Test angle: "${angle.focus}"`);
    this.logger.log(`   ├─ Angle type: "${angle.tcType}"`);
    this.logger.log(`   ├─ ScopeIds: ${scopeIds?.length ?? 0}`);
    this.logger.log(`   └─ Model: "${model}"`);
    
    // focus déjà traduit en batch avant processBatch() — pas de traduction ici
    const prompt = await buildPhaseBPrompt(moduleName, req, angle, forbiddenTitles, tcId, instruction, existingTCs, scopeIds, formData);
    const phaseBOpts = typeof temperatureOverride === 'number'
      ? { ...PHASE_B_OPTIONS, temperature: temperatureOverride }
      : PHASE_B_OPTIONS;

    try {
      const generation = this.createLangfuseGeneration(langfuseTrace, 'phase-b-test-case', model, prompt, {
        requirementId: req.id,
        moduleName,
        tcId,
        angleFocus: angle.focus,
        angleType: angle.tcType,
      });
      const response = await this._callOllama(model, prompt, signal, BASE_SYSTEM_PROMPT, phaseBOpts, generation);
      const parsed   = safeParseJson(response?.message?.content || '');
      if (parsed && parsed.title && parsed.steps) {
        if (angle.tcType) parsed.type = angle.tcType;

        let tc = this.sanitizeOneTc(parsed, moduleName);
        const structCheck = this.validateTestCaseStructure(tc, forbiddenTitles);
        
        this.logger.log(`✅ [Phase B - LLM RECEIVED] Generated TC with title: "${tc.title}"`);


        if (!structCheck.valid) {
          if (structCheck.issues.some(i => i.startsWith('Title too similar'))) return null;
          if (structCheck.issues.some(i => i.includes('Real data')))           return null;
          // Remaining issues (step count, placeholders) : log and return tc as-is.
          // Last-step fix is now handled deterministically in sanitizeOneTc().
          const remainingIssues = structCheck.issues.filter(i => !i.startsWith('Uncovered placeholders'));
          if (remainingIssues.length > 0) {
            this.logger.debug(`⚠️ [Phase B] Minor issues in "${tc.title}": ${remainingIssues.join(' | ')}`);
          }
          return tc;
        }

        // ── Evaluation du TC — différée après fin du pipeline ───────────────
        // Fire-and-forget : ne bloque jamais la réponse au client. Même remarque
        // que Phase A — surveiller la contention Ollama si le trafic augmente.
        if (langfuseTrace?.id && generation?.id) {
          this.evaluateTcWithOllama(tc, req.description, model, langfuseTrace.id, generation.id).catch(() => {});
        }

        return tc;
      }
    } catch (err: any) {
      this.logger.warn(`⚠️ [Phase B] focus="${angle.focus.slice(0, 50)}" for ${req.id}: ${err.message}`);
    }
    return null;
  }

  // ── Persist ───────────────────────────────────────────────────────────────────

  private async persistTestCase(
    tc: TestCase,
    effectivePid: string,
    slot: RequirementWithTests,
  ): Promise<void> {
    try {
      let reqObjId = tc.requirementId;
      let reqId    = (slot as any).req_id || 'UNKNOWN';
      if (typeof reqObjId !== 'string' || reqObjId.length !== 24) {
        const reqDb = await this.prisma.requirement.findFirst({
          where:  { req_id: tc.requirementId, module: { project_id: effectivePid } },
          select: { id: true, req_id: true },
        });
        reqObjId = reqDb?.id ?? tc.requirementId;
        reqId    = reqDb?.req_id ?? reqId;
      }
      await Promise.all([
        this.projectService.addToHistory(effectivePid, reqObjId, reqId, tc.title).catch((err: any) => {
          this.logger.warn(`⚠️ [HISTORY] addToHistory failed: ${err?.message}`);
        }),
        this.mongoVector.addToHistoryIndex({
          testId: tc.testId, title: tc.title,
          preconditions: Array.isArray(tc.preconditions) ? tc.preconditions : [],
          steps:         Array.isArray(tc.steps)         ? tc.steps         : [],
          testData:      Array.isArray(tc.testData)      ? tc.testData      : [],
          expectedResult: tc.expectedResult || '',
          type: tc.type, priority: tc.priority,
          requirementId: reqObjId, projectId: effectivePid, reqId,
        }).catch((err: any) => { this.logger.warn(`⚠️ [HISTORY INDEX] Failed: ${err.message}`); }),
      ]);
    } catch (err: any) {
      this.logger.warn(`⚠️ [PERSIST] Unexpected error: ${err?.message}`);
    }
  }

  // ── generateTestCases ─────────────────────────────────────────────────────────

  async generateTestCases(
    requirements: RequirementsJson,
    model?: string,
    skipCache: boolean = false,
    testCaseRepo?: any,
    projectId?: string,
    myersContext?: string,
    formData?: any,
    scopeIds?: string[],
    langfuseTrace?: any,
    approvedAngles?: TestAngle[], // ← Mode Création : angles validés par l'utilisateur après preview-angles, Phase A est skippée si présent
    forceAngleFocuses?: string[], // ← Mode Création : focus (normalisés) que l'utilisateur a choisi de "générer quand même" malgré un rejet dedup précédent
    startingTcIndices?: Map<string, number>, // ← req.id → nombre de TCs déjà persistés en base, pour que les nouveaux testId ne réécrasent pas les existants lors d'un second appel (ex. "générer quand même" après un rejet dedup)
  ): Promise<TestCaseGenerationResult> {
    await this.acquireLock();
    this.logger.log('🔒 Lock acquired (test cases)');

    const targetModel  = model || this.defaultModel;
    const _reqHash     = this.cacheService.hashRequirements(requirements);
    const effectivePid = projectId || 'default';

    // ─────────────────────────────────────────────────────────────────────────
    // Build instructions for Phase A and Phase B
    //
    // myersContext contient des données complémentaires à formData :
    // fichiers, flows conditionnels, steps, payment, CRUD, auth — non présents
    // dans FormDataInput. On injecte donc toujours myersContext comme instruction
    // dans Phase A (buildPhaseAPrompt le fusionne avec formDataBlock dans <user_input>).
    // Phase B reçoit désormais formData directement via le paramètre dédié —
    // phaseBInstruction n'est plus nécessaire (formData couvre tout le contexte).
    // ─────────────────────────────────────────────────────────────────────────
    const phaseAInstruction = myersContext || undefined;
    const phaseBInstruction = formData ? undefined : (myersContext || undefined);

    if (!skipCache && !approvedAngles) {
      const _cached2 = await this.cacheService.getStep2(_reqHash, targetModel);
      if (_cached2) { this.logger.log('🎯 Cache HIT step2'); this.releaseLock(); return _cached2 as TestCaseGenerationResult; }
    }

    const trace = langfuseTrace ?? this.createLangfuseTrace(
  'generate-test-cases',
  effectivePid,
  {
    model: targetModel,
    projectId: effectivePid,
    requirements: requirements.modules.length,
  },
  `session-${effectivePid}`,  // ← même session pour tout le projet
);

    const start = Date.now();
    const errors: string[] = [];
    let chunksProcessed = 0, consecutiveConnErrors = 0;
    // Mode Création — TCs rejetés par SemanticDedup malgré 3 tentatives, pour re-proposition
    // explicite à l'utilisateur ("générer quand même ?") plutôt qu'une perte silencieuse.
    const dedupRejections: { focus: string; tcType?: string; attemptedTitle: string; similarTitle?: string; reason: string }[] = [];
    // Mode Création — focus que l'utilisateur a explicitement choisi de forcer après un rejet dedup
    const forcedFocusSet = new Set((forceAngleFocuses || []).map(f => f.toLowerCase().trim()));

    const modulesWithTests: ModuleWithTests[] = requirements.modules.map(mod => ({
      name: mod.name, description: mod.description,
      total_requirements: mod.requirements.length, total_test_cases: 0,
      requirements: mod.requirements.map(req => ({
        id: req.id, description: req.description, priority: req.priority,
        total_test_cases: 0, test_cases: [],
      })),
    }));

    // Seedé depuis startingTcIndices quand des TCs existent déjà en base pour ce requirement
    // (ex. second appel "générer quand même" après un premier batch déjà persisté) — sans ça,
    // la numérotation testId redémarre à 01 et écrase les TCs précédents au merge frontend.
    const tcIndexCounter = new Map<string, number>(startingTcIndices ? Array.from(startingTcIndices.entries()) : []);

    try {
      for (let mIdx = 0; mIdx < requirements.modules.length; mIdx++) {
        const mod = requirements.modules[mIdx];
        if (!mod.requirements?.length) continue;
        const batchSeenTitles = new Set<string>();
        // Problème A — Follows angle focuses that were tried but rejected by SemanticDedup
        // so the recovery Phase A can exclude them explicitly via EXHAUSTED ANGLES block
        const exhaustedFocuses    = new Set<string>(); // TC titles rejected by dedup
        const exhaustedAngleFocuses = new Set<string>(); // angle.focus values that led to rejected TCs

        for (let rIdx = 0; rIdx < mod.requirements.length; rIdx++) {
          const req   = mod.requirements[rIdx];
          const slot  = modulesWithTests[mIdx].requirements[rIdx];
          const label = `"${mod.name}" / ${req.id}`;
          this.logger.log(`🧪 [${label}] Starting pipeline`);
          if (rIdx > 0) await new Promise(r => setTimeout(r, 800));

          // Phase A generates ALL angles — the LLM handles equivalence classes directly
          // Mode Création : si approvedAngles est fourni, Phase A est totalement skippée —
          // l'utilisateur a déjà validé (et potentiellement édité/filtré) les angles via
          // l'endpoint preview-angles. On ne réinterroge pas le LLM pour les régénérer.
          let angles: TestAngle[] = [];
          // Budget adaptatif — défaut historique (20 TC, tous types) tant que l'estimation
          // n'a pas tourné ; réutilisé plus bas par le rattrapage quota.
          let reqTargetCount = MIN_TC_PER_REQ;
          let reqAllowedAdvancedTypes = ['state_transition', 'security', 'integration', 'concurrency'];
          if (approvedAngles && approvedAngles.length > 0) {
            this.logger.log(`✅ [${label}] Mode Création — ${approvedAngles.length} angle(s) pré-validés, Phase A skippée`);
            angles = approvedAngles;
          } else {
            const budgetEstimate = await this.estimateTcBudget(mod.name, req, targetModel, formData, scopeIds, trace);
            reqTargetCount = budgetEstimate.targetCount;
            reqAllowedAdvancedTypes = budgetEstimate.allowedAdvancedTypes;

            const ctrlA   = new AbortController();
            const timeoutA = setTimeout(() => ctrlA.abort(), this.PHASE_A_TIMEOUT_MS);
            try {
              angles = await this.runPhaseA(mod.name, req, targetModel, ctrlA.signal, slot.test_cases, phaseAInstruction, formData, scopeIds, trace, undefined, reqTargetCount, reqAllowedAdvancedTypes);
            } finally { clearTimeout(timeoutA); }
          }

          // Fix: dédupliquer les angles du batch Phase A initial par focus exact
          // (le LLM peut renvoyer le même focus avec des formulations légèrement différentes)
          const seenFocuses = new Set<string>();
          const allAngles = angles.filter(a => {
            const norm = a.focus.toLowerCase().trim();
            if (seenFocuses.has(norm)) return false;
            seenFocuses.add(norm);
            return true;
          });

          // Pré-traduire tous les focuses en un seul appel batch HTTP
          // au lieu de N appels séquentiels dans runPhaseB (1 round-trip au lieu de N×retries)
          const translatedFocuses = await translateBatch(allAngles.map(a => a.focus));
          const allAnglesTranslated: TestAngle[] = allAngles.map((a, i) => ({ ...a, focus: translatedFocuses[i] }));

          // Mode Création — l'utilisateur a validé sa liste d'angles ; le dedup reste actif
          // (cohérence en base) mais chaque rejet est collecté pour lui être proposé en
          // re-validation explicite, plutôt que silencieusement perdu.
          const trackDedupRejections = Boolean(approvedAngles && approvedAngles.length > 0);

          const processBatch = async (batchAngles: TestAngle[]): Promise<void> => {
            const phaseBTasks = batchAngles.map(angle => async (): Promise<TestCase | null> => {
              const forbiddenTitles = [...slot.test_cases.map(tc => tc.title), ...Array.from(batchSeenTitles)];
              const nextIndex   = (tcIndexCounter.get(req.id) || 0) + slot.test_cases.length + 1;
              const dynamicTcId = `TC-${req.id}-${String(nextIndex).padStart(2, '0')}`;

              let tc: TestCase | null = null, succeeded = false;
              const isForced = forcedFocusSet.has(angle.focus.toLowerCase().trim());
              let lastRejectionWasDedup = false;
              for (let attempt = 0; attempt < 3 && !succeeded; attempt++) {
                const ctrl2    = new AbortController();
                const timeout2 = setTimeout(() => ctrl2.abort(), this.PHASE_B_TIMEOUT_MS);
                // PHASE_B_OPTIONS.temperature=0 (déterministe) : re-appeler avec les mêmes
                // paramètres après un rejet SemanticDedup reproduirait EXACTEMENT la même
                // sortie déjà rejetée → 2e/3e tentative garanties inutiles (voir log du
                // 06/07/2026 13:04 : 3 tentatives identiques, ~60-90s perdues par angle).
                // On n'augmente la température que dans CE cas précis (rejet dedup), pas
                // pour un timeout/parse-error où le problème est probablement ailleurs.
                const temperatureOverride = (attempt > 0 && lastRejectionWasDedup) ? 0.3 + attempt * 0.25 : undefined;
                try {
                  tc = await this.runPhaseB(mod.name, req, angle, forbiddenTitles, targetModel, dynamicTcId, ctrl2.signal, slot.test_cases, phaseBInstruction, scopeIds, trace, formData, temperatureOverride);
                  if (tc) {
                    const threshold = getDedupeThreshold(angle.tcType);
                    const isTooClose = !isForced && await this.semanticDedup.isTooClose(tc.title, forbiddenTitles, threshold);
                    if (isTooClose) {
                      lastRejectionWasDedup = true;
                      if (trackDedupRejections && attempt === 2) {
                        // Dernière tentative épuisée et toujours trop proche : on note le rejet
                        // pour le Mode Création plutôt que de le jeter silencieusement.
                        dedupRejections.push({ focus: angle.focus, tcType: angle.tcType, attemptedTitle: tc.title, reason: 'too_close_to_existing' });
                      }
                      tc = null;
                      if (attempt < 2) await new Promise(r => setTimeout(r, 1500));
                    } else { succeeded = true; }
                  } else if (attempt < 2) {
                    lastRejectionWasDedup = false;
                    await new Promise(r => setTimeout(r, 2000));
                  }
                } catch (err: any) {
                  clearTimeout(timeout2);
                  if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
                  else {
                    errors.push(`${label} focus="${angle.focus.slice(0, 40)}": ${err.message}`);
                    // Timeout définitif → marquer le focus épuisé pour éviter un re-retry en rattrapage
                    if (err.message === 'LLM call timeout') {
                      exhaustedAngleFocuses.add(angle.focus.toLowerCase().trim());
                    }
                    if (err.message?.startsWith('connection_error') && ++consecutiveConnErrors >= 2)
                      throw new Error('OLLAMA_DOWN');
                    else consecutiveConnErrors = 0;
                  }
                } finally { clearTimeout(timeout2); }
              }
              if (tc) { chunksProcessed++; return tc; }
              // Si toutes les tentatives ont échoué pour cet angle (SemanticDedup, timeout ou autre),
              // on marque le focus comme épuisé pour que le rattrapage ne le retente pas.
              // En Mode Création, on propose aussi sa re-génération via le même écran que les
              // rejets dedup, plutôt que de le perdre silencieusement dans errors[] uniquement.
              if (trackDedupRejections) {
                const alreadyTracked = dedupRejections.some(r => r.focus.toLowerCase().trim() === angle.focus.toLowerCase().trim());
                if (!alreadyTracked) {
                  dedupRejections.push({ focus: angle.focus, tcType: angle.tcType, attemptedTitle: angle.focus, reason: 'generation_failed' });
                }
              }
              exhaustedFocuses.add(angle.focus.toLowerCase().trim());
              exhaustedAngleFocuses.add(angle.focus.toLowerCase().trim()); // fix : était manquant ici
              errors.push(`${label} focus="${angle.focus.slice(0, 40)}": 3 attempts failed`);
              return null;
            });

            const rawResults      = await runWithConcurrency(phaseBTasks, PHASE_B_CONCURRENCY);
            const rawGeneratedTCs = rawResults.filter((tc): tc is TestCase => tc !== null);
            const persistTasks: Promise<void>[] = [];

            for (const tc of rawGeneratedTCs) {
              const normalizedTitle = tc.title.toLowerCase().trim();
              if (batchSeenTitles.has(normalizedTitle)) {
                exhaustedFocuses.add(normalizedTitle);
                continue;
              }

              const isForcedTc = forcedFocusSet.has(normalizedTitle);

              // Special handling for boundary angles: only compare with boundary
              // titles on the SAME field. Use a very strict threshold (0.95)
              if (!isForcedTc && tc.type === 'boundary') {
                const field = extractFieldFromFocus(tc.title);
                const samefieldBoundaries = Array.from(batchSeenTitles).filter(title => extractFieldFromFocus(title) === field);
                if (samefieldBoundaries.length > 0) {
                  const closestTitle = samefieldBoundaries[0];
                  if (await this.semanticDedup.isTooClose(tc.title, samefieldBoundaries, 0.97)) {
                    exhaustedFocuses.add(normalizedTitle);
                    exhaustedAngleFocuses.add(normalizedTitle);
                    if (trackDedupRejections) dedupRejections.push({ focus: tc.title, tcType: tc.type, attemptedTitle: tc.title, similarTitle: closestTitle, reason: 'too_close_same_field' });
                    continue;
                  }
                }
                // If no same-field boundaries exist, accept even if close to other-field boundaries
              } else if (!isForcedTc && tc.type === 'negative') {
                // Special handling for negative TCs: accept different fields automatically,
                // only compare within the SAME field
                const field = extractFieldFromFocus(tc.title);
                const samefieldNegatives = Array.from(batchSeenTitles).filter(title => 
                  extractFieldFromFocus(title) === field
                );
                
                if (samefieldNegatives.length > 0) {
                  // Same field: compare with raised threshold (0.93)
                  const threshold = getDedupeThreshold(tc.type);
                  const closestTitle = samefieldNegatives[0];
                  if (await this.semanticDedup.isTooClose(tc.title, samefieldNegatives, threshold)) {
                    exhaustedFocuses.add(normalizedTitle);
                    exhaustedAngleFocuses.add(normalizedTitle);
                    if (trackDedupRejections) dedupRejections.push({ focus: tc.title, tcType: tc.type, attemptedTitle: tc.title, similarTitle: closestTitle, reason: 'too_close_same_field' });
                    continue;
                  }
                }
                // Different fields or no negatives on this field: accept automatically
              } else if (!isForcedTc) {
                const threshold = getDedupeThreshold(tc.type);
                const candidatePool = Array.from(batchSeenTitles);
                if (await this.semanticDedup.isTooClose(tc.title, candidatePool, threshold)) {
                  exhaustedFocuses.add(normalizedTitle);
                  exhaustedAngleFocuses.add(normalizedTitle);
                  if (trackDedupRejections) dedupRejections.push({ focus: tc.title, tcType: tc.type, attemptedTitle: tc.title, reason: 'too_close_to_existing' });
                  continue;
                }
              }

              const currentIndex = (tcIndexCounter.get(tc.requirementId) || 0) + 1;
              tcIndexCounter.set(tc.requirementId, currentIndex);
              tc.testId = `TC-${tc.requirementId}-${String(currentIndex).padStart(2, '0')}`;

              slot.test_cases.push(tc);
              slot.total_test_cases = slot.test_cases.length;
              batchSeenTitles.add(normalizedTitle);
              persistTasks.push(this.persistTestCase(tc, effectivePid, slot));
            }
            await Promise.all(persistTasks);
          };

          await processBatch(allAnglesTranslated);

          // Consolidation des boundary TCs : éliminer uniquement les vrais doublons
          // = même field reconnu (pas 'unknown') + même direction + titre identique normalisé
          if (slot.test_cases.length > 0) {
            const boundaryTCs = slot.test_cases.filter(tc => tc.type === 'boundary');
            if (boundaryTCs.length > 1) {
              const toRemove = new Set<string>();
              const seenTitleNorm = new Map<string, TestCase>(); // normalizedTitle → first TC

              for (const tc of boundaryTCs) {
                const field = extractFieldFromFocus(tc.title);
                const dir   = extractBoundaryDirection(tc.title);
                // Ne consolider QUE si le field est reconnu (pas 'unknown') ET la direction est connue
                // Cela évite de supprimer "min email" vs "max email" sous la même clé 'unknown'
                if (field === 'unknown' || dir.direction === 'unknown') continue;

                const key = `${field}:${dir.direction}`;

                if (seenTitleNorm.has(key)) {
                  // Doublon exact sur même field+direction → supprimer le second
                  toRemove.add(tc.testId || tc.title);
                  const kept = seenTitleNorm.get(key)!;
                  this.logger.log(`🔄 [Consolidate Boundary] ${label} — kept "${kept.title}", removed: "${tc.title}"`);
                } else {
                  seenTitleNorm.set(key, tc);
                }
              }

              if (toRemove.size > 0) {
                slot.test_cases = slot.test_cases.filter(tc => !toRemove.has(tc.testId || tc.title));
                slot.total_test_cases = slot.test_cases.length;
              }
            }
          }

          // Quota rattrapage — désactivé en Mode Création : l'utilisateur a validé un plan
          // précis (approvedAngles), on génère exactement ces angles-là, pas un quota global.
          // Utilise le budget adaptatif estimé plus haut (reqTargetCount/reqAllowedAdvancedTypes)
          // au lieu du quota fixe MIN_TC_PER_REQ=20 / 8 types — évite de chasser des types
          // (security/concurrency/integration/state_transition) qui n'ont aucun scénario
          // plausible pour cette exigence et qui font systématiquement échouer ce round
          // à 0 résultat (voir logs du 06/07/2026).
          //
          // BOUCLE (et non plus un simple `if`) : avec le budget adaptatif, la Phase A
          // initiale peut sous-livrer fortement (ex: 5 angles générés sur 15 demandés —
          // voir log du 06/07/2026 12:18), et un seul round de rattrapage ne suffit alors
          // plus à combler l'écart (arrivée à 6/15 puis abandon). On boucle jusqu'à
          // atteindre reqTargetCount, avec un plafond de rounds ET un arrêt anticipé dès
          // qu'un round ne rapporte aucun TC supplémentaire (évite de boucler pour rien
          // sur une exigence qui a structurellement épuisé ses scénarios distincts).
          const MAX_RATTRAPAGE_ROUNDS = 3;
          let rattrapageRound = 0;
          while (
            !approvedAngles &&
            slot.test_cases.length < reqTargetCount &&
            rattrapageRound < MAX_RATTRAPAGE_ROUNDS
          ) {
            rattrapageRound++;
            const countBeforeRound = slot.test_cases.length;

            const missing = reqTargetCount - slot.test_cases.length;
            const coveredTypes = new Set(slot.test_cases.map(tc => tc.type));
            const missingTypes = ['positive','negative','boundary','edge_case', ...reqAllowedAdvancedTypes]
              .filter(t => !coveredTypes.has(t));

            this.logger.log(`♻️  [Quota rattrapage round ${rattrapageRound}/${MAX_RATTRAPAGE_ROUNDS}] ${label} — ${slot.test_cases.length}/${reqTargetCount} TCs, manquants: ${missing}, types non couverts: ${missingTypes.join(', ') || 'aucun'}`);

            const recoveryExistingTCs: ExistingTC[] = slot.test_cases.map(tc => ({
              title: tc.title,
              type: tc.type,
              steps: tc.steps,
            }));

            // Rattrapage quota : on utilise buildPhaseAPromptRelaxed avec missingTypes
            // et exhaustedFocuses pour guider le LLM vers les types non couverts.
            // formData et scopeIds sont passés pour garder le contexte complet.
            // targetCount = missingTypes.length + 2 (marge pour répétitions inévitables)
            // On ne demande pas missingTypes*2 car avec 6 types manquants → 12 angles
            // que le LLM ne peut pas tous générer → produit 0 résultat valide.
            const recoveryTargetCount = missingTypes.length > 0
              ? Math.min(missingTypes.length + 2, 8)
              : 6;
            const recoveryPrompt = await buildPhaseAPromptRelaxed(
              mod.name,
              req,
              recoveryExistingTCs,
              missingTypes.length > 0 ? missingTypes : undefined,
              exhaustedFocuses.size > 0 ? Array.from(exhaustedFocuses) : undefined,
              formData,
              scopeIds,
              recoveryTargetCount,
            );

            const ctrlB2 = new AbortController();
            const timeoutB2 = setTimeout(() => ctrlB2.abort(), this.PHASE_A_TIMEOUT_MS);
            let extraAngles: TestAngle[] = [];
            try {
              const rawExtraAngles = await this.runPhaseA(mod.name, req, targetModel, ctrlB2.signal, slot.test_cases, undefined, formData, scopeIds, trace, recoveryPrompt);

              // Exclure les focuses déjà épuisés (tentés + rejetés par SemanticDedup)
              // et les focuses déjà persistés (comparaison exacte)
              const alreadyProcessedFocuses = new Set([
                ...slot.test_cases.map(tc => tc.title.toLowerCase().trim()),
                ...exhaustedFocuses,
                ...exhaustedAngleFocuses,
              ]);

              // Filtre rattrapage :
              // - Toujours exclure les focuses EXACTEMENT épuisés
              // - MAIS accepter les angles dont le TYPE est manquant même si le focus
              //   est proche (le LLM 7B ne peut pas inventer des scénarios radicalement
              //   nouveaux pour security/concurrency — il faut juste qu'ils aient le bon type)
              const missingTypesSet = new Set(missingTypes);

              // Log pour diagnostic — voir ce que le LLM rattrapage produit réellement
              this.logger.debug(`🔍 [Rattrapage raw] ${rawExtraAngles.length} angles: ${rawExtraAngles.map(a => `${a.tcType}:"${a.focus.slice(0,40)}"`).join(' | ')}`);

              extraAngles = rawExtraAngles
                // 1) Exclure les focuses EXACTEMENT épuisés,
                //    SAUF si le type est manquant (un angle security avec le même titre qu'un
                //    boundary existant est quand même nouveau — types différents = scénarios différents)
                .filter(a => {
                  const norm = a.focus.toLowerCase().trim();
                  const isExhausted = alreadyProcessedFocuses.has(norm);
                  const isMissingType = missingTypesSet.has(a.tcType ?? '');
                  // Pour les types avancés (security/concurrency/integration), ne pas filtrer
                  // sur le focus — leur scénario est nécessairement différent des boundary/negative
                  return !isExhausted || isMissingType;
                })
                // 1b) Dédupliquer les focuses au sein du batch
                .filter((a, idx, arr) => {
                  const norm = a.focus.toLowerCase().trim();
                  return arr.findIndex(b => b.focus.toLowerCase().trim() === norm) === idx;
                })
                // 1c) Si missingTypes définis, ne garder que les angles du bon type
                .filter(a => {
                  if (missingTypesSet.size === 0) return true;
                  return missingTypesSet.has(a.tcType ?? '');
                })
                // 2) Prioriser les types manquants en tête de liste
                .sort((a, b) => {
                  const priorityOrder = missingTypes.length > 0 ? missingTypes : ['state_transition', 'boundary', 'integration', 'concurrency'];
                  const ai = priorityOrder.indexOf(a.tcType ?? '');
                  const bi = priorityOrder.indexOf(b.tcType ?? '');
                  const aRank = ai === -1 ? 99 : ai;
                  const bRank = bi === -1 ? 99 : bi;
                  return aRank - bRank;
                })
                // 3) Limiter — prendre assez d'angles pour couvrir toutes les répétitions du LLM
                // Le LLM rattrapage répète souvent le même angle 2-3 fois → après dédup on
                // risque de manquer des slots. On prend le max entre missing+1 et types*3.
                .slice(0, Math.max(missing + 1, missingTypes.length * 3));

              // Bannir les focuses dont le titre générique revient en boucle
              const GENERIC_TITLE_PATTERNS = [
                /registers?\s+with\s+valid\s+email$/i,
                /registers?\s+successfully$/i,
                /registers?\s+with\s+valid\s+data$/i,
              ];
              extraAngles = extraAngles.filter(a => {
                const norm = a.focus.toLowerCase();
                return !GENERIC_TITLE_PATTERNS.some(p => p.test(norm));
              });
              this.logger.log(`♻️  [Quota rattrapage] ${extraAngles.length} angle(s) de rattrapage retenus`);
              if (extraAngles.length > 0) await processBatch(extraAngles);
            } finally { clearTimeout(timeoutB2); }

            // Arrêt anticipé : ce round n'a rapporté aucun TC de plus (angles tous
            // rejetés par dedup, ou aucun angle du bon type renvoyé par le LLM) →
            // les rounds suivants échoueraient probablement pour la même raison
            // structurelle. Inutile de payer 2 rounds de plus pour rien.
            if (slot.test_cases.length === countBeforeRound) {
              this.logger.log(`♻️  [Quota rattrapage] round ${rattrapageRound} improductif (0 TC gagné) — arrêt anticipé, reste à ${slot.test_cases.length}/${reqTargetCount}`);
              break;
            }
          }
        }

        modulesWithTests[mIdx].total_test_cases =
          modulesWithTests[mIdx].requirements.reduce((acc, r) => acc + r.test_cases.length, 0);
      }

      const totalTC  = modulesWithTests.reduce((acc, m) => acc + m.total_test_cases, 0);
      const totalReq = requirements.modules.reduce((acc, m) => acc + m.requirements.length, 0);

      const result: TestCaseGenerationResult = {
        success: totalTC > 0, model: targetModel,
        duration_ms: Date.now() - start, chunks_processed: chunksProcessed,
        total_modules: requirements.modules.length, total_requirements: totalReq,
        total_test_cases: totalTC, modules: modulesWithTests,
        ...(errors.length > 0 ? { errors } : {}),
        ...(dedupRejections.length > 0 ? { dedupRejections } : {}),
      };
      if (result.success && !approvedAngles) await this.cacheService.setStep2(_reqHash, targetModel, result);
      return result;

    } catch (err: any) {
      if (err.message === 'OLLAMA_DOWN') {
        return {
          success: false, model: targetModel, duration_ms: Date.now() - start,
          chunks_processed: chunksProcessed,
          total_modules: requirements.modules.length,
          total_requirements: requirements.modules.reduce((acc, m) => acc + m.requirements.length, 0),
          total_test_cases: modulesWithTests.reduce((acc, m) => acc + m.total_test_cases, 0),
          modules: modulesWithTests, errors: [...errors, 'Ollama server offline'],
        };
      }
      throw err;
    } finally {
      this.releaseLock();
      this.logger.log(`🔓 Lock released — ${Date.now() - start}ms`);
    }
  }

  // ── generateRequirementTestCases ──────────────────────────────────────────────

  async generateRequirementTestCases(
    requirementId: string,
    model: string,
    projectId: string = 'default',
    selectedScope?: string[], // ← features scope sélectionnées dans le wizard
    myersContext?: string,    // ← contexte Myers injecté comme instruction dans Phase A
    formData?: any,           // ← données du formulaire (validInputClasses, invalidInputClasses, businessRules)
    approvedAngles?: TestAngle[], // ← Mode Création : angles validés/édités par l'utilisateur, Phase A skippée si présent
    forceAngleFocuses?: string[], // ← Mode Création : titres de TC que l'utilisateur force malgré un rejet dedup précédent
    existingTcCount?: number, // ← Mode Création : nombre de TCs déjà affichés EN MÉMOIRE côté frontend (pas encore persistés en DB) pour ce requirement — prioritaire sur le compte DB, qui peut être à 0 si l'utilisateur n'a pas encore cliqué "Valider"
  ): Promise<{ test_cases: any[]; duration_ms: number; dedupRejections?: TestCaseGenerationResult['dedupRejections'] }> {
    const startedAt = Date.now();
    this.logger.log(`🚀 [generateRequirementTestCases] START: requirementId=${requirementId}, model=${model}, project=${projectId}, scope=${selectedScope?.length ?? 0}, myers=${!!myersContext}, formData=${!!formData}, approvedAngles=${approvedAngles?.length ?? 0}, existingTcCount=${existingTcCount ?? 'n/a'}`);
    
    const prisma = this.prisma as any;
    const requirement = await prisma.requirement.findUnique({
      where: { id: requirementId },
      include: { module: { include: { project: { select: { id: true } } } }, test_cases: true },
    });
    if (!requirement) throw new Error(`Requirement not found: ${requirementId}`);

    // Log ALL data received from frontend form - COMPLETE VERSION
    this.logger.log(`\n📋 [FORM DATA FROM FRONTEND - COMPLETE]\n`);
    this.logger.log(`   ├─ Requirement ID (req_id): "${requirement.req_id}"`);
    this.logger.log(`   ├─ Module: "${requirement.module?.name}"`);
    this.logger.log(`   ├─ Description (COMPLETE):\n${requirement.description}`);
    this.logger.log(`   ├─ Priority: "${requirement.priority}"`);
    this.logger.log(`   ├─ Fields provided: ${requirement.test_cases?.length || 0} existing TCs`);
    
    // Log formData if provided
    if (formData) {
      this.logger.log(`\n📋 [FORM DATA SUBMITTED - VALIDATION RULES]\n`);
      if (formData.validInputClasses && Array.isArray(formData.validInputClasses)) {
        this.logger.log(`   ├─ Valid Input Classes: ${formData.validInputClasses.length} items`);
        formData.validInputClasses.forEach((item, idx) => {
          this.logger.log(`   │  ${idx + 1}. ${item}`);
        });
      }
      if (formData.invalidInputClasses && Array.isArray(formData.invalidInputClasses)) {
        this.logger.log(`   ├─ Invalid Input Classes: ${formData.invalidInputClasses.length} items`);
        formData.invalidInputClasses.forEach((item, idx) => {
          this.logger.log(`   │  ${idx + 1}. ${item}`);
        });
      }
      if (formData.businessRules && Array.isArray(formData.businessRules)) {
        this.logger.log(`   └─ Business Rules: ${formData.businessRules.length} items`);
        formData.businessRules.forEach((rule, idx) => {
          this.logger.log(`      ${idx + 1}. ${rule}`);
        });
      }
      this.logger.log(`\n`);
    }

    const moduleName   = requirement.module?.name || 'Unknown';
    const projectObjId = requirement.module?.project?.id || projectId;
   const trace = this.createLangfuseTrace(
  'generate-test-cases',
  projectObjId,
  {
    model,
    requirementId,
    requirementCode: requirement.req_id,
    moduleName,
    projectId: projectObjId,
  },
  `session-${projectObjId}`,  // ← toutes les générations du même projet = même session
);
    const pseudoRequirements: RequirementsJson = {
      document_type: 'generated',
      modules: [{ name: moduleName, description: requirement.module?.description || 'Module',
        requirements: [{ id: requirement.req_id, description: requirement.description, priority: requirement.priority as any }] }],
    };

    // Le testId doit continuer la numérotation existante plutôt que repartir à 01 —
    // sinon un second appel (ex. "générer quand même" après rejet dedup) régénère des
    // testId déjà utilisés et écrase les TCs précédents lors du merge côté frontend.
    // En Mode Création, les TCs vivent en mémoire côté frontend jusqu'à validation manuelle
    // (clic "Valider" par TC) — le compte DB (requirement.test_cases) peut donc être à 0
    // alors que le frontend en affiche déjà plusieurs. existingTcCount, quand fourni par
    // le frontend, est donc prioritaire sur le compte DB.
    const baseTcCount = existingTcCount ?? (requirement.test_cases?.length || 0);
    const startingTcIndices = new Map<string, number>([[requirement.req_id, baseTcCount]]);

    const result    = await this.generateTestCases(pseudoRequirements, model, true, undefined, projectObjId, myersContext, formData, selectedScope, trace, approvedAngles, forceAngleFocuses, startingTcIndices);
    const testCases = result.modules?.[0]?.requirements?.[0]?.test_cases || [];
    const duration_ms = Date.now() - startedAt;
    this.logger.log(`✅ [generateRequirementTestCases] Generated ${testCases.length} TC(s) in ${duration_ms}ms${myersContext ? ' [Myers enriched]' : ''}${formData ? ' [FormData enriched]' : ''}${approvedAngles?.length ? ' [Mode Création - angles validés]' : ''}${result.dedupRejections?.length ? ` [${result.dedupRejections.length} rejeté(s) par dedup]` : ''}`);
    return { test_cases: testCases, duration_ms, ...(result.dedupRejections?.length ? { dedupRejections: result.dedupRejections } : {}) };
  }

  // ── Mode Création — Preview des angles Phase A avant génération ────────────────
  //
  // Expose Phase A seule (déjà existante, jamais montrée à l'utilisateur jusqu'ici)
  // comme une étape de validation : l'IA propose son "plan de test" (résumé +
  // liste d'angles), l'utilisateur coche/édite/ajoute, puis relance generate-requirement
  // avec approvedAngles pour sauter Phase A et aller direct en Phase B.

  async previewRequirementAngles(
    requirementId: string,
    model: string,
    projectId: string = 'default',
    selectedScope?: string[],
    myersContext?: string,
    formData?: any,
  ): Promise<{ summary: string; angles: TestAngle[]; duration_ms: number; requirementQuality?: { level: 'ok' | 'warn' | 'poor'; message?: string; suggestedMode?: string } }> {
    const startedAt = Date.now();
    this.logger.log(`🔎 [previewRequirementAngles] START: requirementId=${requirementId}, model=${model}, project=${projectId}, scope=${selectedScope?.length ?? 0}, myers=${!!myersContext}, formData=${!!formData}`);

    const prisma = this.prisma as any;
    const requirement = await prisma.requirement.findUnique({
      where: { id: requirementId },
      include: { module: { include: { project: { select: { id: true } } } }, test_cases: true },
    });
    if (!requirement) throw new Error(`Requirement not found: ${requirementId}`);

    const moduleName   = requirement.module?.name || 'Unknown';
    const projectObjId = requirement.module?.project?.id || projectId;

    const trace = this.createLangfuseTrace(
      'preview-angles',
      projectObjId,
      {
        model,
        requirementId,
        requirementCode: requirement.req_id,
        moduleName,
        projectId: projectObjId,
      },
      `session-${projectObjId}`,
    );

    const req = { id: requirement.req_id, description: requirement.description, priority: requirement.priority as string };
    const existingTCs: ExistingTC[] = (requirement.test_cases || []).map((tc: any) => ({
      title: tc.title, type: tc.type, steps: tc.steps,
    }));

    // Phase A seule — pas de lock global, pas de Phase B, pas de sauvegarde DB.
    // On accepte une légère concurrence avec une génération en cours : la preview
    // est une lecture/réflexion, pas une écriture de TCs.
    const ctrlA    = new AbortController();
    const timeoutA = setTimeout(() => ctrlA.abort(), this.PHASE_A_TIMEOUT_MS);
    let angles: TestAngle[] = [];
    try {
      angles = await this.runPhaseA(moduleName, req, model, ctrlA.signal, existingTCs, myersContext, formData, selectedScope, trace);
    } finally { clearTimeout(timeoutA); }

    // Dédup par focus exact, même logique que dans generateTestCases
    const seenFocuses = new Set<string>();
    const dedupedAngles = angles.filter(a => {
      const norm = a.focus.toLowerCase().trim();
      if (seenFocuses.has(norm)) return false;
      seenFocuses.add(norm);
      return true;
    });

    // ── Évaluation de la richesse du requirement ──────────────────────────────
    // Détecte si le requirement est trop vague pour produire un plan de test
    // complet en Mode Création. On combine deux signaux :
    //   1. La longueur/densité de la description (proxy de richesse sémantique)
    //   2. Le nombre d'angles effectivement générés par Phase A
    // Résultat : { level: 'ok' | 'warn' | 'poor', message?, suggestedMode? }
    const reqQuality = this.assessRequirementQuality(req.description, dedupedAngles.length);
    if (reqQuality.level !== 'ok') {
      this.logger.warn(`⚠️ [previewRequirementAngles] Requirement quality=${reqQuality.level} for ${requirementId}: ${reqQuality.message}`);
    }

    if (dedupedAngles.length === 0) {
      this.logger.warn(`⚠️ [previewRequirementAngles] Phase A returned no angles for ${requirementId}`);
      return {
        summary: "Je n'ai pas réussi à identifier d'angles de test clairs pour ce requirement. Tu peux réessayer ou passer en Mode Signature pour définir le plan toi-même.",
        angles: [],
        duration_ms: Date.now() - startedAt,
        requirementQuality: { level: 'poor' as const, message: reqQuality.message, suggestedMode: 'explicit' },
      };
    }

    const summary = await this.summarizeAnglesForPreview(req, dedupedAngles, model, trace);

    const duration_ms = Date.now() - startedAt;
    this.logger.log(`✅ [previewRequirementAngles] ${dedupedAngles.length} angle(s) in ${duration_ms}ms — summary: "${summary.slice(0, 80)}..."`);
    return { summary, angles: dedupedAngles, duration_ms, requirementQuality: reqQuality };
  }

  /**
   * Évalue la richesse d'un requirement pour le Mode Création.
   * Combine la densité de la description et le nombre d'angles produits par Phase A.
   *
   * Niveaux :
   *   ok   — req suffisamment riche, Mode Création adapté
   *   warn — req un peu court/vague, Mode Création possible mais résultat partiel
   *   poor — req trop vague, Mode Création non recommandé → suggérer Myers ou Explicite
   */
  private assessRequirementQuality(
    description: string,
    anglesCount: number,
  ): { level: 'ok' | 'warn' | 'poor'; message?: string; suggestedMode?: string } {
    const words        = description.trim().split(/\s+/).filter(Boolean).length;
    const hasCondition = /\b(if|when|unless|given|provided|in case|lorsque|si |quand|dans le cas)\b/i.test(description);
    const hasMeasure   = /\b(\d+|max|min|minimum|maximum|within|between|entre|moins de|plus de)\b/i.test(description);

    // Score de richesse 0-4
    let score = 0;
    if (words >= 20)      score += 1;
    if (words >= 40)      score += 1;
    if (hasCondition)     score += 1;
    if (hasMeasure)       score += 1;

    // Ajustement selon les angles générés : signal empirique le plus fiable
    if      (anglesCount >= 8)  return { level: 'ok' };
    else if (anglesCount >= 4)  return score >= 1
      ? { level: 'ok' }
      : { level: 'warn', message: 'Le requirement est court. Certains angles ont peut-être été manqués.', suggestedMode: 'explicit' };
    else if (anglesCount >= 2)  return {
      level: 'warn',
      message: `Seulement ${anglesCount} angle(s) identifié(s) — le requirement manque de détails (conditions, règles métier, contraintes). Le plan de test sera incomplet.`,
      suggestedMode: 'explicit',
    };
    else return {
      level: 'poor',
      message: `Le requirement est trop vague pour que le Mode Création génère un plan complet. Utilisez le formulaire assisté du Mode Signature pour structurer les données de test.`,
      suggestedMode: 'explicit',
    };
  }

  /**
   * Génère une courte phrase de synthèse (1-2 phrases, FR) décrivant ce que l'IA
   * a compris du requirement et ce qu'elle compte tester, à partir des angles
   * Phase A déjà générés. Best-effort : si le LLM échoue, on retombe sur un
   * résumé déterministe assemblé depuis les angles (groupés par tcType).
   */
  private async summarizeAnglesForPreview(
    req: { id: string; description: string; priority: string },
    angles: TestAngle[],
    model: string,
    langfuseTrace?: any,
  ): Promise<string> {
    const angleLines = angles
      .map((a, i) => `${i + 1}. [${a.tcType || 'non classé'}] ${a.focus}`)
      .join('\n');

    const prompt = [
      'Tu es un QA lead senior. Voici un requirement et les angles de test déjà identifiés pour lui.',
      `REQUIREMENT (${req.id}): ${req.description}`,
      '',
      'ANGLES IDENTIFIÉS:',
      angleLines,
      '',
      'Rédige UNE seule synthèse courte en français (1 à 2 phrases, style "je vois... je vais générer...") qui résume ',
      'ce que tu as compris du requirement et ce que ce plan de test va couvrir. Pas de liste, pas de markdown, ',
      'juste la phrase de synthèse en texte brut.',
    ].join('\n');

    // Budget court et BORNÉ (20s) : sans `signal`, ce call n'avait comme
    // filet que le timeout axios de 15 minutes (voir ollama-client.ts).
    // Les angles Phase A sont déjà en main à ce stade — un résumé lent ne
    // doit jamais faire "tourner" le mode Création plusieurs minutes de
    // plus avant de renvoyer la réponse au front, d'autant qu'un fallback
    // déterministe existe déjà juste en dessous en cas d'échec/abandon.
    const ctrlSummary = new AbortController();
    const timeoutSummary = setTimeout(() => ctrlSummary.abort(), 20_000);
    try {
      const generation = this.createLangfuseGeneration(langfuseTrace, 'preview-angles-summary', model, prompt, {
        requirementId: req.id,
        angleCount: angles.length,
      });
      const plainTextSystemPrompt = 'You are a senior QA lead. Respond with plain natural language text only — no JSON, no markdown, no code fences, no lists.';
      const response = await this._callOllama(model, prompt, ctrlSummary.signal, plainTextSystemPrompt, PHASE_A_RECOVERY_OPTIONS, generation);
      const text = (response?.message?.content || '').trim();
      if (text && text.length > 10 && text.length < 600) return text;
    } catch (err: any) {
      this.logger.warn(`⚠️ [summarizeAnglesForPreview] LLM summary failed for ${req.id}: ${err.message}`);
    } finally {
      clearTimeout(timeoutSummary);
    }

    // Fallback déterministe — groupé par tcType
    const byType = new Map<string, number>();
    for (const a of angles) {
      const t = a.tcType || 'autre';
      byType.set(t, (byType.get(t) || 0) + 1);
    }
    const parts = Array.from(byType.entries()).map(([t, n]) => `${n} ${t}`);
    return `Je vais générer ${angles.length} cas de test couvrant : ${parts.join(', ')}.`;
  }

  async verifyMyersFormInput(input: MyersFormVerificationInput): Promise<MyersFormVerificationResult> {
    const requirementDesc = String(input?.requirement?.reqDesc || '').trim();
    const reqId = String(input?.requirement?.reqId || '').trim();
    const moduleName = String(input?.requirement?.module || '').trim();
    const scope = Array.isArray(input?.selectedScope) ? input.selectedScope : [];

    const cleanList = (values?: string[]): string[] =>
      (Array.isArray(values) ? values : [])
        .map(v => String(v || '').trim())
        .filter(Boolean);

    const formData = {
      validInputClasses: cleanList(input?.formData?.validInputClasses),
      invalidInputClasses: cleanList(input?.formData?.invalidInputClasses),
      businessRules: cleanList(input?.formData?.businessRules),
    };

    const rawFieldsSource =
      input?.rawFields && typeof input.rawFields === 'object'
        ? input.rawFields
        : {};
    const rawFields: Record<string, string> = {
      validInputClasses: String(rawFieldsSource.validInputClasses || '').trim(),
      invalidInputClasses: String(rawFieldsSource.invalidInputClasses || '').trim(),
      businessRules: String(rawFieldsSource.businessRules || '').trim(),
      minValue: String(rawFieldsSource.minValue || '').trim(),
      maxValue: String(rawFieldsSource.maxValue || '').trim(),
      edgeCases: String(rawFieldsSource.edgeCases || '').trim(),
    };

    if (!requirementDesc) {
      return {
        status: 'error',
        summary: 'Description du requirement manquante.',
        issues: ['Le requirement est vide.'],
        suggestions: ['Renseigner la description du requirement avant vérification.'],
        fieldSuggestions: {},
      };
    }

    const hasAnyRawInput = Object.values(rawFields).some(v => v.length > 0);

    const normalizeSuggestionValue = (value: any): string => {
      if (Array.isArray(value)) {
        const lines = value.map(v => String(v || '').trim()).filter(Boolean);
        return lines.join('\n').trim();
      }
      if (typeof value === 'string') {
        return value.trim();
      }
      if (value && typeof value === 'object') {
        const lines = Object.values(value)
          .map(v => String(v || '').trim())
          .filter(Boolean);
        return lines.join('\n').trim();
      }
      return '';
    };

    const cleanSuggestionText = (text: string): string => {
      const t = String(text || '').trim();
      if (!t) return '';
      const lowered = t.toLowerCase();
      if (lowered === '[]' || lowered === '{}' || lowered === 'null' || lowered === 'undefined' || lowered === 'n/a') return '';
      return t;
    };

    // NOTE: No local fallback corrections — all corrections must come from the LLM.
    // The code intentionally avoids any server-side heuristic corrections so that
    // spelling/grammar/formatting is 100% LLM-driven as requested.

    const prompt = [
      "Vous êtes un expert QA senior spécialisé en conception Myers pour la génération de cas de test.",
      "Votre tâche : analyser le formulaire soumis et proposer en FRANÇAIS des corrections et des ajouts pertinents.",
      "",
      "EXIGENCE:",
      `- id: ${reqId || 'unknown'}`,
      `- module: ${moduleName || 'unknown'}`,
      `- description: ${requirementDesc}`,
      `- selected_scope_ids: ${scope.length ? scope.join(', ') : 'aucun'}`,
      "",
      "DONNÉES DE FORMULAIRE:",
      `- valid_input_classes: ${JSON.stringify(formData.validInputClasses)}`,
      `- invalid_input_classes: ${JSON.stringify(formData.invalidInputClasses)}`,
      `- business_rules: ${JSON.stringify(formData.businessRules)}`,
      "",
      "CHAMPS BRUTS (texte exact saisi par l'utilisateur):",
      `- validInputClasses: ${rawFields.validInputClasses || '[VIDE]'}`,
      `- invalidInputClasses: ${rawFields.invalidInputClasses || '[VIDE]'}`,
      `- businessRules: ${rawFields.businessRules || '[VIDE]'}`,
      `- minValue: ${rawFields.minValue || '[VIDE]'}`,
      `- maxValue: ${rawFields.maxValue || '[VIDE]'}`,
      `- edgeCases: ${rawFields.edgeCases || '[VIDE]'}`,
      "",
      "CONTEXTE MYERS (optionnel):",
      input?.myersContext?.trim() || 'aucun',
      "",
      "Répondez UNIQUEMENT avec du JSON valide respectant ce schéma exact :",
      "{",
      "  \"status\": \"ok|warning|error\",",
      "  \"summary\": \"résumé court en une ligne\",",
      "  \"issues\": [\"string\"],",
      "  \"suggestions\": [\"string\"],",
      "  \"fieldSuggestions\": {",
      "    \"validInputClasses\": \"chaîne (1 cas par ligne)\",",
      "    \"invalidInputClasses\": \"chaîne (1 cas par ligne)\",",
      "    \"businessRules\": \"chaîne (1 règle par ligne)\",",
      "    \"minValue\": \"optionnel\",",
      "    \"maxValue\": \"optionnel\",",
      "    \"edgeCases\": \"optionnel\"",
      "  }",
      "}",
      "",
      "RÈGLES (OBLIGATOIRES) :",
      "- Répondez UNIQUEMENT en FRANÇAIS.",
      "- status='error' uniquement pour contradiction bloquante ou information critique manquante.",
      "- status='warning' pour améliorations non bloquantes.",
      "- status='ok' si le formulaire est cohérent et exploitable.",
      "- Conserver les 'issues' et 'suggestions' concises et actionnables.",
      "- Pour CHAQUE champ VIDE, PROPOSEZ un contenu concret prêt à coller dans 'fieldSuggestions'.",
      "- Pour CHAQUE champ NON VIDE, FOURNISSEZ une VERSION CORRIGÉE en FRANÇAIS (orthographe, grammaire, ponctuation, mise en forme) dans 'fieldSuggestions'.",
      "- Si pertinent, PROPOSEZ des ajouts/contenus complémentaires et placez-les APRES le texte corrigé, séparés par deux sauts de ligne et la ligne littérale '--- SUGGESTED ADDITIONS ---', puis une suggestion par ligne.",
      "- Une idée par ligne quand c'est pertinent.",
      "- NE JAMAIS retourner '[]', 'null' ou des placeholders pour une valeur de 'fieldSuggestions'.",
      "- RENVOYEZ obligatoirement 'fieldSuggestions' pour TOUS les champs non vides.",
      "- 'fieldSuggestions' doit être du texte prêt-à-coller pour chaque champ.",
      "- N'inventez pas de champs hors du schéma fourni.",
    ].join('\n');

    try {
      const modelToUse = input?.model || this.defaultModel;
      const response = await this._callOllama(
        modelToUse,
        prompt,
        undefined,
        'You are a strict JSON API. Output ONLY raw valid JSON.',
        {
          temperature: 0,
          num_predict: 350,
          num_ctx: 8192,
          top_k: 1,
          top_p: 1,
          repeat_penalty: 1,
          repeat_last_n: 64,
        },
      );

      const parsed = safeParseJson((response?.message?.content || '').trim()) || {};
      const parsedStatus = String(parsed.status || '').toLowerCase();
      const status: MyersFormVerificationResult['status'] =
        parsedStatus === 'error' ? 'error' : parsedStatus === 'warning' ? 'warning' : 'ok';

      const issues = cleanList(parsed.issues);
      const suggestions = cleanList(parsed.suggestions);
      const fieldSuggestionsRaw =
        parsed.fieldSuggestions && typeof parsed.fieldSuggestions === 'object'
          ? parsed.fieldSuggestions
          : {};
      const allowedFields = new Set([
        'validInputClasses',
        'invalidInputClasses',
        'businessRules',
        'minValue',
        'maxValue',
        'edgeCases',
      ]);
      const fieldSuggestions: Record<string, string> = {};
      Object.entries(fieldSuggestionsRaw).forEach(([key, value]) => {
        if (!allowedFields.has(key)) return;
        const v = cleanSuggestionText(normalizeSuggestionValue(value));
        if (v) fieldSuggestions[key] = v;
      });
      const summary = String(parsed.summary || '').trim() ||
        (status === 'ok'
          ? 'Le formulaire semble cohérent pour générer le prompt.'
          : status === 'warning'
            ? 'Le formulaire est exploitable avec quelques ajustements.'
            : 'Des erreurs bloquantes ont été détectées.');

      // Do NOT apply any local fallback. If the LLM did not return suggestions for
      // a field, we keep the fieldSuggestions empty so the frontend can surface
      // that the LLM didn't provide a correction (LLM-only requirement).

      // Passe orthographique dédiée : corrige explicitement le texte déjà saisi.
      // Objectif: éviter les réponses vides/[] et forcer une version corrigée prête à coller.
      const nonEmptyRawFields = Array.from(allowedFields)
        .filter((fieldId) => Boolean((rawFields as any)[fieldId] || ''.trim()))
        .filter((fieldId) => Boolean(String((rawFields as any)[fieldId] || '').trim()))
        .reduce<Record<string, string>>((acc, fieldId) => {
          acc[fieldId] = String((rawFields as any)[fieldId] || '');
          return acc;
        }, {});

      if (Object.keys(nonEmptyRawFields).length > 0) {
        const orthographyPrompt = [
          "Vous êtes un correcteur orthographique et de clarté FRANÇAIS strict pour les champs du formulaire QA.",
          "Corrigez UNIQUEMENT le texte fourni. Préservez l'intention originale et le vocabulaire métier.",
          "Répondez UNIQUEMENT en FRANÇAIS et renvoyez STRICTEMENT du JSON valide avec ce schéma :",
          "{",
          "  \"fieldSuggestions\": {",
          "    \"validInputClasses\": \"optionnel - chaîne corrigée\",",
          "    \"invalidInputClasses\": \"optionnel - chaîne corrigée\",",
          "    \"businessRules\": \"optionnel - chaîne corrigée\",",
          "    \"minValue\": \"optionnel - chaîne corrigée\",",
          "    \"maxValue\": \"optionnel - chaîne corrigée\",",
          "    \"edgeCases\": \"optionnel - chaîne corrigée\"",
          "  }",
          "}",
          "",
          "Champs fournis (non vides) :",
          JSON.stringify(nonEmptyRawFields),
          "",
          "Règles :",
          "- Corrigez l'orthographe, la grammaire, la ponctuation et la mise en forme.",
          "- Utilisez le français standard (fr-FR).",
          "- Une idée par ligne quand pertinent.",
          "- POUR CHAQUE champ, si pertinent, proposez des ajouts; placez-les APRES le texte corrigé séparés par deux sauts de ligne et la ligne littérale '--- SUGGESTED ADDITIONS ---', une suggestion par ligne.",
          "- NE JAMAIS retourner '[]' ou des placeholders.",
          "- Si le texte est déjà correct et aucun ajout n'est pertinent, renvoyez le texte inchangé (sans header d'ajouts).",
        ].join('\n');

        try {
          const orthographyResponse = await this._callOllama(
            modelToUse,
            orthographyPrompt,
            undefined,
            'You are a strict JSON API. Output ONLY raw valid JSON.',
            {
              temperature: 0,
              num_predict: 320,
              num_ctx: 4096,
              top_k: 1,
              top_p: 1,
              repeat_penalty: 1,
              repeat_last_n: 64,
            },
          );

          const orthographyParsed = safeParseJson((orthographyResponse?.message?.content || '').trim()) || {};
          const orthographyFieldSuggestions =
            orthographyParsed.fieldSuggestions && typeof orthographyParsed.fieldSuggestions === 'object'
              ? orthographyParsed.fieldSuggestions
              : {};

          Object.entries(orthographyFieldSuggestions).forEach(([key, value]) => {
            if (!allowedFields.has(key)) return;
            const corrected = cleanSuggestionText(normalizeSuggestionValue(value));
            if (corrected) {
              fieldSuggestions[key] = corrected;
            }
          });
        } catch (orthErr: any) {
          this.logger.warn(`⚠️ [verifyMyersFormInput] Orthography pass failed: ${orthErr.message}`);
        }
      }

      // Si tout est vide, ne garder que les champs les plus pertinents pour démarrer.
      if (!hasAnyRawInput) {
        Object.keys(fieldSuggestions).forEach((k) => {
          if (!['validInputClasses', 'invalidInputClasses', 'businessRules'].includes(k)) {
            delete fieldSuggestions[k];
          }
        });
      }

      return { status, summary, issues, suggestions, fieldSuggestions };
    } catch (err: any) {
      this.logger.warn(`⚠️ [verifyMyersFormInput] LLM verify failed: ${err.message}`);
      return {
        status: 'warning',
        summary: 'Vérification LLM indisponible, validation minimale appliquée.',
        issues: [],
        suggestions: [
          'Relancer la vérification dans quelques secondes.',
          'Vérifier manuellement la cohérence entre classes valides, invalides et règles métier.',
        ],
        fieldSuggestions: {},
      };
    }
  }

  // ── Health check ──────────────────────────────────────────────────────────────

  async healthCheck(): Promise<{ online: boolean; models?: string[]; error?: string; chatReady?: boolean }> {
    try {
      const response = await fetch(this.ollamaUrl + '/api/tags', { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      let chatReady = true;
      try {
        const ct = await fetch(this.ollamaUrl + '/api/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(3000),
          body: JSON.stringify({ model: this.defaultModel, stream: false, messages: [{ role: 'user', content: 'hi' }] }),
        });
        chatReady = ct.ok || ct.status < 500;
      } catch { chatReady = false; }
      return { online: true, models: data?.models?.map((m: any) => m.name) || [], chatReady };
    } catch (error: any) {
      return { online: false, error: error.message, chatReady: false };
    }
  }

  // ── Sanitize ──────────────────────────────────────────────────────────────────

  private normalizeStringArray(items: any): string[] {
    if (!Array.isArray(items)) return [];
    return items
      .map(item => {
        // If already a string, return as-is
        if (typeof item === 'string') return item;
        // If object with action field (e.g., { stepNumber, action, data }), extract action
        if (typeof item === 'object' && item !== null) {
          if (item.action) return String(item.action).trim();
          if (item.value) return String(item.value).trim();
          if (item.content) return String(item.content).trim();
          // Try to extract first non-empty string property
          const val = Object.values(item).find((v: any) => typeof v === 'string');
          if (val) return String(val).trim();
        }
        // Fallback: stringify the item
        return String(item).trim();
      })
      .filter(s => s.length > 0);
  }

  private sanitizeOneTc(raw: any, moduleName: string): TestCase {
    // Strip verbose suffixes hallucinated by the LLM (optional-type angles)
    const VERBOSE_TITLE_SUFFIX = /\s*[—–-]\s*(happy path.*|all inputs valid.*|expected outcome.*|system accepts.*)$/i;
    const title = typeof raw.title === 'string'
      ? raw.title.replace(/_/g, ' ').replace(/\s{2,}/g, ' ').replace(VERBOSE_TITLE_SUFFIX, '').trim()
      : '';
    const steps    = this.normalizeStringArray(raw.steps);
    const testData = this.normalizeStringArray(raw.testData);

    // ── Auto-fix: last step must be a verification ────────────────────────────
    // If the LLM forgot, append "Verify that [OUTCOME_MSG]" — avoids self-critique round-trip.
    const VERIFY_RE = /^verify\b/i;
    if (steps.length > 0 && !VERIFY_RE.test(steps[steps.length - 1])) {
      const hasOutcomeMsg = testData.some(d => /^OUTCOME_MSG\s*:/i.test(d));
      if (!hasOutcomeMsg) testData.push(`OUTCOME_MSG: Operation completed as expected`);
      steps.push(`Verify that [OUTCOME_MSG]`);
    }

    return {
      testId:         raw.testId         || 'TC-UNKNOWN-01',
      moduleId:       raw.moduleId       || moduleName,
      requirementId:  raw.requirementId  || '',
      title,
      preconditions:  this.normalizeStringArray(raw.preconditions),
      steps,
      testData,
      expectedResult: raw.expectedResult || '',
      type:           normalizeTcType(raw.type),
      priority:       this.normalizeTestPriority(raw.priority),
    };
  }

  private normalizeTestPriority(value: string): TestCase['priority'] {
    const v = (value || '').toUpperCase();
    if (v === 'HIGH') return 'HIGH';
    if (v === 'LOW')  return 'LOW';
    return 'MEDIUM';
  }

  // ── SRS extraction ────────────────────────────────────────────────────────────
  // (code inchangé — méthodes d'extraction SRS non affectées par le refactoring)

  async extractRequirements(documentContent: string, projectId?: string): Promise<ExtractedModule[]> {
    this.logger.log(`Document: ${documentContent.length} chars`);

    const traceUserId = projectId || 'unknown-project';
    const langfuseTrace = this.createLangfuseTrace(
      'extract-requirements',
      traceUserId,
      { model: this.defaultModel, documentLength: documentContent.length, projectId },
      `session-${traceUserId}`,
    );

    const allSections = this.extractStructuralPlan(documentContent);
    let functionalSections: Array<{ name: string; content: string }>;

    if (allSections.length >= 3) {
      functionalSections = await this.classifySections(allSections, documentContent, langfuseTrace);
    } else {
      functionalSections = await this.discoverFunctionalModules(documentContent, langfuseTrace);
    }

    if (functionalSections.length === 0) return this.extractAllAtOnce(documentContent, langfuseTrace);

    const allModules: ExtractedModule[] = [];
    const idToModuleNameGlobal = this.buildIdToModuleNameIndex(documentContent);

    for (const section of functionalSections) {
      const detectedIds = this.detectRequirementIds(section.content);
      if (section.content.length > MAX_SECTION_CHARS) {
        const subSections = this.extractStructuralPlan(section.content);
        if (subSections.length >= 2) {
          for (const sub of subSections) {
            const subIds = this.detectRequirementIds(sub.content);
            const mod    = await this.extractWithIdAwareness(sub.content, sub.name, subIds, langfuseTrace);
            if (mod && mod.requirements.length > 0) allModules.push(mod);
          }
        } else {
          const idGroups = this.splitByIdGroups(section.content);
          for (const group of idGroups) {
            const groupIds   = this.detectRequirementIds(group.content);
            const moduleName = this.resolveModuleName(groupIds, idToModuleNameGlobal, section.name);
            const mod        = await this.extractWithIdAwareness(group.content, moduleName, groupIds, langfuseTrace);
            if (mod && mod.requirements.length > 0) allModules.push(mod);
          }
        }
      } else {
        const mod = await this.extractWithIdAwareness(section.content, section.name, detectedIds, langfuseTrace);
        if (mod && mod.requirements.length > 0) {
          allModules.push(mod);
          if (detectedIds.length > 0 && mod.requirements.length < detectedIds.length * 0.7) {
            const retry = await this.extractByIds(section.content, section.name, detectedIds, langfuseTrace);
            if (retry && retry.requirements.length > mod.requirements.length)
              allModules[allModules.length - 1] = retry;
          }
        }
      }
    }

    const seenTitles = new Set<string>();
    for (const mod of allModules) {
      mod.requirements = mod.requirements.filter(req => {
        const key = (req.title ?? '').toLowerCase().trim();
        if (seenTitles.has(key)) return false;
        seenTitles.add(key);
        return true;
      });
    }

    const result = allModules.filter(m => m.requirements.length > 0);

    langfuseTrace?.update({
      output: { modulesCount: result.length, requirementsCount: result.reduce((sum, m) => sum + m.requirements.length, 0) },
    });

    return result;
  }

  // ── Extraction ciblée sur un seul chunk (revue manuelle de couverture) ──────
  // Réutilise le même pipeline d'extraction que le SRS complet (extractWithIdAwareness),
  // mais scopé au texte d'un unique chunk — utilisé quand un chunk "ignoré" ou
  // "orphelin" est validé par un utilisateur comme du vrai contenu à extraire.
  async extractRequirementFromChunk(chunkText: string, moduleNameHint?: string): Promise<ExtractedModule | null> {
    const titleMatch = chunkText.match(/^##\s*([^\n]+)\n/);
    const moduleName = moduleNameHint || titleMatch?.[1]?.trim() || 'Extraction manuelle';
    const detectedIds = this.detectRequirementIds(chunkText);
    const langfuseTrace = this.createLangfuseTrace(
      'extract-from-chunk',
      'manual-coverage-review',
      { moduleName, chunkLength: chunkText.length },
    );
    return this.extractWithIdAwareness(chunkText, moduleName, detectedIds, langfuseTrace);
  }

  async runExtractionPipeline(projectId: string, content: string): Promise<void> {
    try {
      const projectExists = await this.prisma.project.findUnique({ where: { id: projectId } });
      if (!projectExists) return;

      const extractedModules = await this.extractRequirements(content, projectId);
      const projectStillExists = await this.prisma.project.findUnique({ where: { id: projectId } });
      if (!projectStillExists) return;

      let reqCounter = 1;
      for (const modData of extractedModules) {
        // Ne jamais recréer un module déjà existant pour ce projet (ex. si le
        // pipeline est relancé sur le même document) — on réutilise l'existant.
        let module = await this.prisma.requirementModule.findFirst({
          where: { project_id: projectId, name: modData.name },
        });
        if (!module) {
          module = await this.prisma.requirementModule.create({
            data: { name: modData.name, description: modData.description, project_id: projectId },
          });
        }
        for (const reqData of modData.requirements || []) {
          const normalizedDescription = reqData.description.trim();
          // Idem pour les exigences : pas de doublon texte-pour-texte dans le module.
          const duplicate = await this.prisma.requirement.findFirst({
            where: { module_id: module.id, description: { equals: normalizedDescription, mode: 'insensitive' } },
          });
          if (!duplicate) {
            await this.prisma.requirement.create({
              data: {
                req_id: reqData.refCode || `REQ-${String(reqCounter).padStart(3, '0')}`,
                description: normalizedDescription, priority: reqData.priority || 'SHALL',
                manually_edited: false, module_id: module.id,
              },
            });
          }
          reqCounter++;
        }
      }
    } catch (err) { this.logger.error('Extraction pipeline error', err); }
  }

  // ─── Méthodes d'extraction SRS (inchangées) ──────────────────────────────────

  private extractStructuralPlan(documentContent: string): Array<{ name: string; content: string }> {
    const lines = documentContent.split('\n');
    const headings: Array<{ name: string; lineIndex: number; level: number }> = [];
    const patterns: Array<{ re: RegExp; level: number; nameGroup: number }> = [
      { re: /^(#{1,4})\s+(.+)$/,                          level: 1, nameGroup: 2 },
      { re: /^(\d+\.\d+\.\d+\.\d+)\s*([A-Z].{2,70})$/,   level: 4, nameGroup: 2 },
      { re: /^(\d+\.\d+\.\d+)\s*([A-Z].{2,70})$/,         level: 3, nameGroup: 2 },
      { re: /^(\d+\.\d+)\s*([A-Z].{2,70})$/,               level: 2, nameGroup: 2 },
      { re: /^(\d+\.)\s*([A-Z].{2,70})$/,                  level: 1, nameGroup: 2 },
      { re: /^(\d+)\s{1,3}([A-Z][^a-z]{0,3}[^\n]{2,70})$/, level: 1, nameGroup: 2 },
    ];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.length < 4 || line.length > 100) continue;
      for (const { re, level, nameGroup } of patterns) {
        const m = line.match(re);
        if (m) {
          const name = m[nameGroup].trim();
          if (name.length >= 3 && !name.match(/^[\d\s.]+$/) &&
              !name.match(/^(Number|Priority|Actors|Description|Trigger|Pre|Post|Normal|Alternative|Exception)/i))
            headings.push({ name, lineIndex: i, level });
          break;
        }
      }
    }
    if (headings.length < 2) return [];
    const sections: Array<{ name: string; content: string }> = [];
    for (let i = 0; i < headings.length; i++) {
      const h = headings[i]; let end = lines.length;
      for (let j = i + 1; j < headings.length; j++) {
        if (headings[j].level <= h.level) { end = headings[j].lineIndex; break; }
        if (h.level >= 3)                 { end = headings[j].lineIndex; break; }
      }
      const sectionContent = lines.slice(h.lineIndex, end).join('\n').trim();
      if (sectionContent.length >= 80) sections.push({ name: h.name, content: sectionContent });
    }
    return sections;
  }

  private async classifySections(
    allSections: Array<{ name: string; content: string }>,
    _documentContent: string,
    langfuseTrace?: any,
  ): Promise<Array<{ name: string; content: string }>> {
    const sectionList = allSections.map((s, i) => `${i + 1}. ${s.name} (${s.content.length} chars)`).join('\n');
    const prompt = PromptTemplate.fromTemplate(
      `You are an expert in software requirements engineering.\nHere is the list of ALL sections of an SRS/PRD document.\nSECTION LIST:\n{sections}\nRespond ONLY with this JSON:\n{{"functional": [1, 3, 5]}}\nThe "functional" list contains the NUMBERS of functional sections.\nINCLUDE if the section describes system features or requirements.\nEXCLUDE if introduction, references, glossary, history, conventions, summary, NFR.\nONLY the JSON.`,
    );
    try {
      const raw    = await this.invokeLlmChain(prompt, { sections: sectionList }, langfuseTrace, 'classify-sections', { sectionsCount: allSections.length });
      const match  = raw.match(/\{[\s\S]*\}/);
      if (!match) return allSections;
      const parsed = JSON.parse(match[0]);
      const functionalIndices: number[] = parsed.functional || [];
      return functionalIndices.filter(i => i >= 1 && i <= allSections.length).map(i => allSections[i - 1]);
    } catch { return allSections; }
  }

  private async discoverFunctionalModules(documentContent: string, langfuseTrace?: any): Promise<Array<{ name: string; content: string }>> {
    const prompt = PromptTemplate.fromTemplate(
      `You are an expert in software requirements engineering.\nRead this document and identify ALL functional modules.\nDOCUMENT:\n{document}\nRespond ONLY with this JSON:\n{{"modules": [{{"name": "Module name", "anchor": "first 8 exact words of the title in the doc"}}]}}`,
    );
    try {
      const raw   = await this.invokeLlmChain(prompt, { document: documentContent }, langfuseTrace, 'discover-functional-modules', { documentLength: documentContent.length });
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return [];
      const parsed = JSON.parse(match[0]);
      return this.sliceByAnchors(documentContent, parsed.modules || []);
    } catch { return []; }
  }

  private sliceByAnchors(text: string, infos: Array<{ name: string; anchor: string }>): Array<{ name: string; content: string }> {
    const located: Array<{ name: string; pos: number }> = [];
    for (const info of infos) {
      const anchor = info.anchor.trim();
      let pos = text.indexOf(anchor);
      if (pos === -1) pos = text.toLowerCase().indexOf(anchor.toLowerCase());
      if (pos !== -1) located.push({ name: info.name, pos });
    }
    located.sort((a, b) => a.pos - b.pos);
    return located.map((item, i) => ({
      name:    item.name,
      content: text.slice(item.pos, i + 1 < located.length ? located[i + 1].pos : text.length).trim(),
    }));
  }

  private buildIdToModuleNameIndex(documentContent: string): Map<string, string> {
    const index = new Map<string, string>();
    const lines = documentContent.split('\n');
    const headingPatterns = [
      /^#{1,4}\s+(.+)$/, /^\d+\.\d+\.\d+\.?\d*\s{1,5}([A-Z].{2,70})$/,
      /^\d+\.\d+\s{1,5}([A-Z].{2,70})$/, /^\d+\.\s{1,5}([A-Z].{2,70})$/,
    ];
    const idPattern = /\b([A-Z]{1,4}-\d{1,4})\b/g;
    let currentSection = '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      for (const pattern of headingPatterns) {
        const m = trimmed.match(pattern);
        if (m) {
          const name = (m[2] || m[1]).trim();
          if (name.length >= 4 && name.length <= 80 && !name.match(/^[\d\s.]+$/)) currentSection = name;
          break;
        }
      }
      if (currentSection) {
        let match; idPattern.lastIndex = 0;
        while ((match = idPattern.exec(trimmed)) !== null) if (!index.has(match[1])) index.set(match[1], currentSection);
      }
    }
    return index;
  }

  private resolveModuleName(groupIds: string[], index: Map<string, string>, fallbackName: string): string {
    if (groupIds.length === 0) return fallbackName;
    const votes = new Map<string, number>();
    for (const id of groupIds) { const s = index.get(id); if (s) votes.set(s, (votes.get(s) || 0) + 1); }
    if (votes.size === 0) return fallbackName;
    let bestName = fallbackName, bestCount = 0;
    for (const [name, count] of votes) if (count > bestCount) { bestCount = count; bestName = name; }
    return bestName;
  }

  private splitByIdGroups(content: string): Array<{ label: string; content: string }> {
    const lines = content.split('\n');
    const idLinePattern = /\b([A-Z]{1,4})-(\d+)\.?/;
    const idLines: Array<{ lineIndex: number; prefix: string; num: number }> = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(idLinePattern);
      if (m) idLines.push({ lineIndex: i, prefix: m[1], num: parseInt(m[2]) });
    }
    if (idLines.length < 4) return [{ label: 'full', content }];
    const groups: Array<{ label: string; content: string }> = [];
    const GROUP_SIZE = 10;
    for (let i = 0; i < idLines.length; i += GROUP_SIZE) {
      const batch = idLines.slice(i, i + GROUP_SIZE);
      const startLine = batch[0].lineIndex;
      const endLine   = i + GROUP_SIZE < idLines.length ? idLines[i + GROUP_SIZE].lineIndex : lines.length;
      const groupContent = lines.slice(startLine, endLine).join('\n').trim();
      const firstId = `${batch[0].prefix}-${batch[0].num}`;
      const lastId  = `${batch[batch.length - 1].prefix}-${batch[batch.length - 1].num}`;
      if (groupContent.length >= 50)
        groups.push({ label: firstId === lastId ? firstId : `${firstId} to ${lastId}`, content: groupContent });
    }
    return groups.length > 0 ? groups : [{ label: 'full', content }];
  }

  private detectRequirementIds(content: string): string[] {
    const idPattern = /\b([A-Z]{1,4}-\d{1,4})\b/g;
    const matches = new Set<string>();
    let match;
    while ((match = idPattern.exec(content)) !== null) matches.add(match[1]);
    return Array.from(matches).sort();
  }

  private extractHierarchicalItems(content: string): string[] {
    const lines = content.split('\n');
    const items: string[] = [];
    const skipWords = /^(Input|Output|Description|Steps|Note|TBD|Assumption)/i;
    for (const line of lines) {
      const bulletMatch = line.match(/^[●○▪▸►•]([A-Z][^\n]{2,60})$/);
      if (bulletMatch) {
        const title = bulletMatch[1].replace(/^[A-Z][0-9]+(?:\.[0-9]+)*\s*:\s*/, '').replace(/\s{2,}/g, ' ').trim();
        if (!skipWords.test(title) && title.length >= 3 && !items.includes(title)) items.push(title);
        continue;
      }
      const indentMatch = line.match(/^\s{2,}[-*•●○]\s+([A-Z][^\n]{2,60})$/);
      if (indentMatch) {
        const title = indentMatch[1].replace(/\s{2,}/g, ' ').trim();
        if (!skipWords.test(title) && title.length >= 3 && !items.includes(title)) items.push(title);
      }
    }
    return items;
  }

  private async extractWithIdAwareness(sectionContent: string, moduleName: string, detectedIds: string[], langfuseTrace?: any): Promise<ExtractedModule | null> {
    if (detectedIds.length === 0) {
      const hierarchicalItems = this.extractHierarchicalItems(sectionContent);
      if (hierarchicalItems.length >= 2) return this.extractByHierarchicalItems(sectionContent, moduleName, hierarchicalItems, langfuseTrace);
      return this.extractModuleRequirements(sectionContent, moduleName, langfuseTrace);
    }
    return this.extractByIds(sectionContent, moduleName, detectedIds, langfuseTrace);
  }

  private async extractByIds(sectionContent: string, moduleName: string, detectedIds: string[], langfuseTrace?: any): Promise<ExtractedModule | null> {
    const idList = detectedIds.join(', ');
    const prompt = PromptTemplate.fromTemplate(
      `You are an expert in software requirements engineering.\nThis section contains requirements identified by unique codes: {idList}\nABSOLUTE RULE: each code = one separate requirement in the JSON. You MUST produce EXACTLY {idCount} objects in "requirements".\nDOCUMENT SECTION:\n{section}\nRespond ONLY with this valid and COMPLETE JSON:\n{{"name": "{moduleName}", "description": "One-sentence module description", "requirements": [{{"title": "Short title", "description": "Full text", "priority": "high", "type": "functional", "refCode": "FR-01", "source": "explicit"}}]}}`,
    );
    try {
      const raw      = await this.invokeLlmChain(prompt, { section: sectionContent, moduleName, idList, idCount: String(detectedIds.length) }, langfuseTrace, 'extract-by-ids', { moduleName, idCount: detectedIds.length });
      const repaired = this.repairJson(raw);
      if (!repaired) return null;
      const parsed   = JSON.parse(repaired);
      return { name: parsed.name || moduleName, description: parsed.description || '', requirements: this.normalizeRequirements(parsed.requirements) };
    } catch { return this.extractModuleRequirements(sectionContent, moduleName, langfuseTrace); }
  }

  private async extractByHierarchicalItems(sectionContent: string, moduleName: string, items: string[], langfuseTrace?: any): Promise<ExtractedModule | null> {
    const itemList = items.map((it, i) => `${i + 1}. ${it}`).join('\n');
    const prompt   = PromptTemplate.fromTemplate(
      `You are an expert in software requirements engineering.\nThis section contains the following features: {itemList}\nABSOLUTE RULE: each item = one separate requirement. Produce AT LEAST {itemCount} objects.\nDOCUMENT SECTION:\n{section}\nRespond ONLY with this valid and COMPLETE JSON:\n{{"name": "{moduleName}", "description": "One-sentence description", "requirements": [{{"title": "Short title", "description": "Full description", "priority": "high", "type": "functional", "refCode": "MOD-001", "source": "explicit"}}]}}`,
    );
    try {
      const raw      = await this.invokeLlmChain(prompt, { section: sectionContent, moduleName, itemList, itemCount: String(items.length) }, langfuseTrace, 'extract-by-hierarchical-items', { moduleName, itemCount: items.length });
      const repaired = this.repairJson(raw);
      if (!repaired) return null;
      const parsed   = JSON.parse(repaired);
      const result   = { name: parsed.name || moduleName, description: parsed.description || '', requirements: this.normalizeRequirements(parsed.requirements) };
      if (result.requirements.length < items.length * 0.6) return this.extractModuleRequirements(sectionContent, moduleName, langfuseTrace);
      return result;
    } catch { return this.extractModuleRequirements(sectionContent, moduleName, langfuseTrace); }
  }

  private async extractModuleRequirements(sectionContent: string, moduleName: string, langfuseTrace?: any): Promise<ExtractedModule | null> {
    const prompt = PromptTemplate.fromTemplate(
      `You are an expert in software requirements engineering.\nAnalyse this document section for the module "{moduleName}".\nANTI-HALLUCINATION RULE: Extract ONLY what is explicitly present in the text.\nSECTION:\n{section}\nRespond ONLY with this valid and COMPLETE JSON:\n{{"name": "{moduleName}", "description": "One-sentence description", "requirements": [{{"title": "Short title (max 10 words)", "description": "Full description", "priority": "high", "type": "functional", "refCode": "MOD-001", "source": "explicit"}}]}}`,
    );
    try {
      const raw      = await this.invokeLlmChain(prompt, { section: sectionContent, moduleName }, langfuseTrace, 'extract-module-requirements', { moduleName });
      const repaired = this.repairJson(raw);
      if (!repaired) return null;
      const parsed   = JSON.parse(repaired);
      return { name: parsed.name || moduleName, description: parsed.description || '', requirements: this.normalizeRequirements(parsed.requirements) };
    } catch { return null; }
  }

  // Normalise la sortie brute du LLM : un modèle 7B omet souvent "title" ou "priority".
  private normalizeRequirements(raw: any): ExtractedRequirement[] {
    if (!Array.isArray(raw)) return [];
    const prios = ['low', 'medium', 'high', 'critical'];
    return raw
      .filter(r => r && typeof r === 'object')
      .map(r => {
        const description = String(r.description ?? r.text ?? r.title ?? r.name ?? '').trim();
        const title = String(r.title ?? r.name ?? '').trim() || description.slice(0, 80);
        const prio = String(r.priority ?? '').toLowerCase();
        return {
          title,
          description,
          priority: (prios.includes(prio) ? prio : 'medium') as ExtractedRequirement['priority'],
          type: (r.type === 'non-functional' ? 'non-functional' : 'functional') as ExtractedRequirement['type'],
          refCode: r.refCode ? String(r.refCode) : undefined,
          source: (r.source === 'inferred' ? 'inferred' : 'explicit') as ExtractedRequirement['source'],
        };
      })
      .filter(r => r.title.length > 0 && r.description.length > 0);
  }

  private repairJson(raw: string): string | null {
    const fullMatch = raw.match(/\{[\s\S]*\}/);
    if (fullMatch) { try { JSON.parse(fullMatch[0]); return fullMatch[0]; } catch {} }
    const start = raw.indexOf('{');
    if (start === -1) return null;
    let json = raw.slice(start);
    const lastObj = json.lastIndexOf('},'), lastObjNoC = json.lastIndexOf('}');
    if (lastObj > 100)         json = json.slice(0, lastObj + 1)    + '\n  ]\n}';
    else if (lastObjNoC > 100) json = json.slice(0, lastObjNoC + 1) + '\n  ]\n}';
    else return null;
    try { JSON.parse(json); return json; } catch { return null; }
  }

  private async extractAllAtOnce(documentContent: string, langfuseTrace?: any): Promise<ExtractedModule[]> {
    const prompt = PromptTemplate.fromTemplate(
      `You are an expert in requirements engineering.\nExtract ALL requirements (explicit AND implicit) from this document, grouped by modules.\nDOCUMENT:\n{document}\nRespond ONLY with this JSON:\n{{"modules": [{{"name": "Name", "description": "Description", "requirements": [{{"title": "Title", "description": "Description", "priority": "high", "type": "functional", "refCode": "MOD-001", "source": "explicit"}}]}}]}}`,
    );
    try {
      const raw      = await this.invokeLlmChain(prompt, { document: documentContent }, langfuseTrace, 'extract-all-at-once', { documentLength: documentContent.length });
      const repaired = this.repairJson(raw);
      if (!repaired) return [];
      const parsed   = JSON.parse(repaired);
      return (parsed.modules || [])
        .filter((m: any) => m && typeof m === 'object')
        .map((m: any) => ({ name: String(m.name || 'Module'), description: String(m.description || ''), requirements: this.normalizeRequirements(m.requirements) }));
    } catch { return []; }
  }
}