/**
 * LLM Test Case Generation API
 * 
 * Utilitaires pour appeler les endpoints de génération TC du backend
 */

const API_BASE = '/api/backend';

export interface TestCaseFormData {
  validInputClasses?: string[];
  invalidInputClasses?: string[];
  businessRules?: string[];
}

export interface GenerateRequirementTCPayload {
  model?: string;
  project_id?: string;
  myersContext?: string;
  formContext?: string;
  formData?: TestCaseFormData;
  selectedScope?: string[];
  approvedAngles?: { focus: string; tcType?: string }[];
  forceAngleFocuses?: string[];
  existingTcCount?: number;
  actorName?: string;
  actorId?: string;
  /** Mode de génération choisi par l'utilisateur (Flash/Création/Signature) —
   *  purement informatif, diffusé aux autres utilisateurs via WebSocket. */
  genMode?: 'fast' | 'assisted' | 'explicit';
}

export interface GenerateRequirementTCResponse {
  success: boolean;
  timestamp: string;
  test_cases: any[];
  duration_ms?: number;
  dedupRejections?: any[];
}

/**
 * Génération TC — variante ASYNCHRONE (job + polling).
 *
 * Pourquoi : une génération peut prendre 10 à 30+ minutes (observé en
 * pratique). Garder une requête HTTP synchrone ouverte aussi longtemps est
 * fragile — timeout du proxy Next.js (`/api/backend/[...path]/route.ts`),
 * d'un reverse-proxy en prod, ou du navigateur lui-même. On démarre donc le
 * job côté backend (réponse quasi instantanée avec un jobId), puis on poll
 * son statut à intervalle régulier. Chaque requête HTTP est courte — plus
 * aucun risque de timeout sur la génération elle-même.
 */

export type JobStatus = 'pending' | 'running' | 'done' | 'error';

export interface GenerateRequirementJobStatusResponse extends Partial<GenerateRequirementTCResponse> {
  jobId: string;
  status: JobStatus;
  error?: string;
}

async function startGenerateRequirementJob(
  requirementId: string,
  payload: GenerateRequirementTCPayload = {}
): Promise<{ jobId: string }> {
  const response = await fetch(
    `${API_BASE}/llm/generate-requirement/${requirementId}/start`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.message || `HTTP ${response.status}: ${response.statusText}`);
  }
  return data;
}

async function fetchGenerateRequirementJobStatus(
  jobId: string
): Promise<GenerateRequirementJobStatusResponse> {
  const response = await fetch(`${API_BASE}/llm/generate-requirement/job/${jobId}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.message || `HTTP ${response.status}: ${response.statusText}`);
  }
  return data;
}

export interface PollOptions {
  /** Intervalle entre deux polls, en ms (défaut : 3000). */
  intervalMs?: number;
  /** Durée max d'attente avant abandon côté front, en ms (défaut : 60 min). */
  maxWaitMs?: number;
  /** Callback optionnel appelé à chaque poll (pour afficher une progression). */
  onStatus?: (status: JobStatus) => void;
}

/**
 * Démarre une génération TC et attend le résultat en pollant le statut du job.
 * Remplace l'appel synchrone direct pour les générations potentiellement longues.
 */
export async function generateRequirementTestCasesAsync(
  requirementId: string,
  payload: GenerateRequirementTCPayload = {},
  options: PollOptions = {}
): Promise<GenerateRequirementTCResponse> {
  const { intervalMs = 3000, maxWaitMs = 60 * 60 * 1000, onStatus } = options;

  const { jobId } = await startGenerateRequirementJob(requirementId, payload);

  const startedAt = Date.now();
  while (true) {
    if (Date.now() - startedAt > maxWaitMs) {
      throw new Error(
        `La génération est toujours en cours après ${Math.round(maxWaitMs / 60000)} min. ` +
        `Le job continue en arrière-plan côté serveur (jobId=${jobId}) ; réessayez plus tard.`
      );
    }

    await new Promise(resolve => setTimeout(resolve, intervalMs));

    const job = await fetchGenerateRequirementJobStatus(jobId);
    onStatus?.(job.status);

    if (job.status === 'error') {
      throw new Error(job.error || 'La génération a échoué.');
    }
    if (job.status === 'done') {
      return {
        success: job.success ?? true,
        timestamp: job.timestamp ?? new Date().toISOString(),
        test_cases: job.test_cases ?? [],
        duration_ms: job.duration_ms,
        ...(job as any).dedupRejections ? { dedupRejections: (job as any).dedupRejections } : {},
      } as GenerateRequirementTCResponse;
    }
    // 'pending' | 'running' → on continue de poller
  }
}