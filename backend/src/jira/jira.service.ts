import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectJiraDto } from './dto/connect-jira.dto';
import { decryptToken, encryptToken } from './jira-crypto.util';
import { buildJiraDescription, buildJiraLabels, buildJiraSummary } from './jira-adf.util';

export interface JiraConnectionStatus {
  connected: boolean;
  jiraBaseUrl?: string;
  jiraEmail?: string;
  updatedAt?: Date;
}

export interface JiraAdminConnectionRow {
  userId: string;
  userName: string;
  userEmail: string;
  userRole: string;
  connected: boolean;
  jiraBaseUrl?: string;
  jiraEmail?: string;
  updatedAt?: Date;
}

// ─── Résolution du projectId (utilisée pour le verrou anti-export concurrent
// et pour journaliser l'export auprès des membres du projet) ────────────────
export interface JiraProjectOption {
  id: string;
  key: string;
  name: string;
}

export interface JiraIssueTypeOption {
  id: string;
  name: string;
  iconUrl?: string;
}

export interface JiraEpicOption {
  id: string;
  key: string;
  summary: string;
}

export interface JiraExportResult {
  testCaseId: string;
  testId: string;
  success: boolean;
  issueKey?: string;
  issueUrl?: string;
  error?: string;
  action?: 'created' | 'updated';
}

/** Statut de la hiérarchie Jira (Epic du module → Story de l'exigence) déjà établie. */
export interface JiraRequirementHierarchy {
  linked: boolean;
  projectKey?: string;
  epicKey?: string;
  epicUrl?: string;
  storyKey?: string;
  storyUrl?: string;
}

@Injectable()
export class JiraService {
  private readonly logger = new Logger(JiraService.name);

  constructor(private readonly prisma: PrismaService) {}

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
      select: { requirement: { select: { module: { select: { project_id: true } } } } },
    });
    return tc?.requirement?.module?.project_id ?? null;
  }

  // ══════════════════════════════════════════════════════════════════════
  // GESTION DES CREDENTIALS (par utilisateur)
  // ══════════════════════════════════════════════════════════════════════

  private normalizeBaseUrl(url: string): string {
    return url.trim().replace(/\/+$/, '');
  }

  /**
   * Connecte (ou reconnecte) le compte Jira de l'utilisateur.
   * Vérifie d'abord que les identifiants sont valides en appelant /rest/api/3/myself,
   * puis chiffre et persiste le token.
   */
  async connect(userId: string, dto: ConnectJiraDto): Promise<JiraConnectionStatus> {
    const jiraBaseUrl = this.normalizeBaseUrl(dto.jiraBaseUrl);

    // 1) Valider les identifiants avant de les stocker
    await this.verifyCredentials(jiraBaseUrl, dto.jiraEmail, dto.apiToken);

    // 2) Chiffrer le token et upsert
    const { encryptedToken, iv, authTag } = encryptToken(dto.apiToken);

    await this.prisma.jiraCredential.upsert({
      where: { user_id: userId },
      create: {
        user_id: userId,
        jira_base_url: jiraBaseUrl,
        jira_email: dto.jiraEmail,
        encrypted_token: encryptedToken,
        token_iv: iv,
        token_auth_tag: authTag,
      },
      update: {
        jira_base_url: jiraBaseUrl,
        jira_email: dto.jiraEmail,
        encrypted_token: encryptedToken,
        token_iv: iv,
        token_auth_tag: authTag,
      },
    });

    return { connected: true, jiraBaseUrl, jiraEmail: dto.jiraEmail };
  }

  async getStatus(userId: string): Promise<JiraConnectionStatus> {
    const cred = await this.prisma.jiraCredential.findUnique({ where: { user_id: userId } });
    if (!cred) return { connected: false };
    return {
      connected: true,
      jiraBaseUrl: cred.jira_base_url,
      jiraEmail: cred.jira_email,
      updatedAt: cred.updated_at,
    };
  }

  async disconnect(userId: string): Promise<{ success: boolean }> {
    await this.prisma.jiraCredential.deleteMany({ where: { user_id: userId } });
    return { success: true };
  }

  // ══════════════════════════════════════════════════════════════════════
  // SUPERVISION ADMIN — vue d'ensemble et révocation des accès Atlassian
  // (les identifiants restent chiffrés et ne sont jamais exposés à l'admin ;
  // seul le statut de connexion est visible, la révocation force une
  // reconnexion manuelle par l'utilisateur concerné)
  // ══════════════════════════════════════════════════════════════════════

  /** Liste, pour l'admin, le statut de connexion Atlassian de tous les utilisateurs. */
  async listAllConnectionsForAdmin(): Promise<JiraAdminConnectionRow[]> {
    const users = await this.prisma.user.findMany({
      include: { jiraCredential: true },
      orderBy: { name: 'asc' },
    });

    return users.map(u => ({
      userId: u.id,
      userName: u.name,
      userEmail: u.email,
      userRole: u.role,
      connected: !!u.jiraCredential,
      jiraBaseUrl: u.jiraCredential?.jira_base_url,
      jiraEmail: u.jiraCredential?.jira_email,
      updatedAt: u.jiraCredential?.updated_at,
    }));
  }

  /** Révoque, à l'initiative d'un admin, la connexion Atlassian d'un utilisateur donné. */
  async adminRevokeConnection(userId: string): Promise<{ success: boolean }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`Utilisateur ${userId} introuvable`);
    }
    await this.prisma.jiraCredential.deleteMany({ where: { user_id: userId } });
    return { success: true };
  }

  /** Récupère + déchiffre les identifiants Jira de l'utilisateur, ou lève une erreur explicite. */
  private async getDecryptedCredentials(userId: string) {
    const cred = await this.prisma.jiraCredential.findUnique({ where: { user_id: userId } });
    if (!cred) {
      throw new BadRequestException(
        "Aucun compte Jira connecté. Rendez-vous dans les paramètres Jira pour connecter votre compte.",
      );
    }
    const apiToken = decryptToken({
      encryptedToken: cred.encrypted_token,
      iv: cred.token_iv,
      authTag: cred.token_auth_tag,
    });
    return { jiraBaseUrl: cred.jira_base_url, jiraEmail: cred.jira_email, apiToken };
  }

  private authHeader(email: string, apiToken: string): string {
    return 'Basic ' + Buffer.from(`${email}:${apiToken}`).toString('base64');
  }

  private async verifyCredentials(jiraBaseUrl: string, email: string, apiToken: string) {
    let res: Response;
    try {
      res = await fetch(`${jiraBaseUrl}/rest/api/3/myself`, {
        headers: { Authorization: this.authHeader(email, apiToken), Accept: 'application/json' },
      });
    } catch (e: any) {
      throw new BadRequestException(
        `Impossible de joindre ${jiraBaseUrl} : ${e.message}. Vérifiez l'URL de votre instance Jira.`,
      );
    }
    if (res.status === 401) {
      throw new BadRequestException(
        "Identifiants Jira invalides (email ou jeton d'API incorrect).",
      );
    }
    if (!res.ok) {
      throw new BadRequestException(
        `La connexion à Jira a échoué (HTTP ${res.status}). Vérifiez l'URL et vos identifiants.`,
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // PROJETS JIRA ACCESSIBLES (pour le dropdown côté frontend)
  // ══════════════════════════════════════════════════════════════════════

  async listProjects(userId: string): Promise<JiraProjectOption[]> {
    const { jiraBaseUrl, jiraEmail, apiToken } = await this.getDecryptedCredentials(userId);

    const res = await fetch(`${jiraBaseUrl}/rest/api/3/project/search?maxResults=100`, {
      headers: { Authorization: this.authHeader(jiraEmail, apiToken), Accept: 'application/json' },
    });
    if (res.status === 401) {
      throw new BadRequestException('Session Jira expirée ou jeton révoqué. Reconnectez votre compte.');
    }
    if (!res.ok) {
      throw new BadRequestException(`Impossible de récupérer les projets Jira (HTTP ${res.status}).`);
    }
    const data: any = await res.json();
    const values: any[] = data?.values || [];
    return values.map(p => ({ id: p.id, key: p.key, name: p.name }));
  }

  // ══════════════════════════════════════════════════════════════════════
  // TYPES DE TICKET — résolus dynamiquement par projet
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Récupère la liste brute des types de ticket disponibles pour un projet Jira,
   * sous-tâches incluses (on filtre selon le besoin dans les méthodes appelantes).
   */
  private async fetchIssueTypesForProject(
    jiraBaseUrl: string,
    authHeader: string,
    projectKey: string,
  ): Promise<Array<{ id: string; name: string; iconUrl?: string; subtask: boolean }>> {
    const res = await fetch(
      `${jiraBaseUrl}/rest/api/3/issue/createmeta?projectKeys=${encodeURIComponent(projectKey)}&expand=projects.issuetypes`,
      { headers: { Authorization: authHeader, Accept: 'application/json' } },
    );
    if (!res.ok) {
      throw new Error(`Impossible de récupérer les types de ticket du projet ${projectKey} (HTTP ${res.status}).`);
    }
    const data: any = await res.json();
    const project = data?.projects?.[0];
    const issueTypes: any[] = project?.issuetypes || [];

    if (!issueTypes.length) {
      throw new Error(
        `Aucun type de ticket disponible pour le projet ${projectKey}. Vérifiez les permissions du compte connecté.`,
      );
    }
    return issueTypes.map((t: any) => ({ id: t.id, name: t.name, iconUrl: t.iconUrl, subtask: !!t.subtask }));
  }

  /**
   * Endpoint public : liste les types de ticket "normaux" (ni sous-tâche, ni Epic)
   * du projet choisi — c'est le type qui représentera l'EXIGENCE (Story/Task).
   * "Epic" est exclu : il a sa propre étape dédiée. Les sous-tâches sont exclues
   * aussi : c'est le type automatiquement utilisé pour les CAS DE TEST.
   */
  async listIssueTypes(userId: string, projectKey: string): Promise<JiraIssueTypeOption[]> {
    const { jiraBaseUrl, jiraEmail, apiToken } = await this.getDecryptedCredentials(userId);
    const authHeader = this.authHeader(jiraEmail, apiToken);
    const issueTypes = await this.fetchIssueTypesForProject(jiraBaseUrl, authHeader, projectKey);
    return issueTypes
      .filter(t => !t.subtask && t.name?.toLowerCase() !== 'epic')
      .map(t => ({ id: t.id, name: t.name, iconUrl: t.iconUrl }));
  }

  /**
   * Résout le type de ticket "Sous-tâche" du projet — utilisé automatiquement
   * pour créer chaque cas de test comme enfant de la Story de son exigence.
   */
  private async fetchSubtaskType(
    jiraBaseUrl: string,
    authHeader: string,
    projectKey: string,
  ): Promise<{ id: string; name: string }> {
    const issueTypes = await this.fetchIssueTypesForProject(jiraBaseUrl, authHeader, projectKey);
    const subtaskType = issueTypes.find(t => t.subtask);
    if (!subtaskType) {
      throw new BadRequestException(
        `Le projet ${projectKey} ne propose pas de type de ticket "Sous-tâche". Activez les sous-tâches dans les paramètres du projet Jira pour créer la hiérarchie Epic → Story → Sous-tâche.`,
      );
    }
    return { id: subtaskType.id, name: subtaskType.name };
  }

  /**
   * Filet de sécurité : si jamais l'export est déclenché sans type choisi par
   * l'utilisateur, on retombe sur une sélection automatique du type "Story".
   */
  private async resolveIssueTypeId(
    jiraBaseUrl: string,
    authHeader: string,
    projectKey: string,
  ): Promise<{ id: string; name: string }> {
    const issueTypes = (await this.fetchIssueTypesForProject(jiraBaseUrl, authHeader, projectKey))
      .filter(t => !t.subtask && t.name?.toLowerCase() !== 'epic');
    const preferredNames = ['story', 'histoire', 'task', 'tâche', 'tache', 'bug'];
    for (const preferred of preferredNames) {
      const match = issueTypes.find(t => t.name?.toLowerCase() === preferred);
      if (match) return match;
    }
    return issueTypes[0];
  }

  // ══════════════════════════════════════════════════════════════════════
  // EPICS — pour que l'utilisateur choisisse l'Epic parent AVANT la Story
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Liste les Epics du projet donné, pour que l'utilisateur choisisse celui
   * auquel rattacher la Story de son exigence (ordre attendu côté Jira :
   * Projet → Epic → Story (exigence) → Sous-tâches (cas de test)).
   */
  async listEpics(userId: string, projectKey: string): Promise<JiraEpicOption[]> {
    const { jiraBaseUrl, jiraEmail, apiToken } = await this.getDecryptedCredentials(userId);
    const authHeader = this.authHeader(jiraEmail, apiToken);

    const jql = `project = "${projectKey}" AND issuetype = Epic ORDER BY created DESC`;
    const res = await fetch(`${jiraBaseUrl}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jql,
        maxResults: 100,
        fields: ['summary'],
      }),
    });

    if (res.status === 401) {
      throw new BadRequestException('Session Jira expirée ou jeton révoqué. Reconnectez votre compte.');
    }
    if (!res.ok) {
      throw new BadRequestException(`Impossible de récupérer les epics du projet ${projectKey} (HTTP ${res.status}).`);
    }
    const data: any = await res.json();
    const issues: any[] = data?.issues || [];
    return issues.map(i => ({ id: i.id, key: i.key, summary: i.fields?.summary || i.key }));
  }

  /**
   * Crée un nouvel Epic dans le projet donné, pour que l'utilisateur n'ait pas
   * à quitter l'application pour en créer un avant de rattacher son ticket.
   */
  async createEpic(userId: string, projectKey: string, summary: string): Promise<JiraEpicOption> {
    const trimmed = summary?.trim();
    if (!trimmed) {
      throw new BadRequestException("Le nom de l'epic est requis.");
    }

    const { jiraBaseUrl, jiraEmail, apiToken } = await this.getDecryptedCredentials(userId);
    const authHeader = this.authHeader(jiraEmail, apiToken);

    // L'Epic est un type de ticket comme un autre : on résout son id dans ce projet.
    const issueTypes = await this.fetchIssueTypesForProject(jiraBaseUrl, authHeader, projectKey);
    const epicType = issueTypes.find(t => t.name?.toLowerCase() === 'epic');
    if (!epicType) {
      throw new BadRequestException(`Le projet ${projectKey} ne propose pas de type de ticket "Epic".`);
    }

    const res = await fetch(`${jiraBaseUrl}/rest/api/3/issue`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          project: { key: projectKey },
          issuetype: { id: epicType.id },
          summary: trimmed,
        },
      }),
    });
    if (!res.ok) {
      throw new BadRequestException(await this.extractJiraError(res));
    }
    const data: any = await res.json();
    return { id: data.id, key: data.key, summary: trimmed };
  }

  // ══════════════════════════════════════════════════════════════════════
  // HIÉRARCHIE JIRA DE L'EXIGENCE — Epic → Story, créée une fois puis réutilisée
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Sur les projets Jira "classiques" (company-managed), le rattachement d'un
   * ticket à un Epic ne se fait PAS via le champ standard "parent" (réservé aux
   * sous-tâches) mais via un champ personnalisé nommé "Epic Link". Sur les
   * projets "nouvelle génération" (team-managed), ce champ n'existe pas et
   * "parent" fonctionne nativement. On détecte donc dynamiquement lequel
   * utiliser, en mettant en cache le résultat par instance Jira (le champ ne
   * change pas d'une exécution à l'autre).
   */
  private epicLinkFieldCache = new Map<string, string | null>();

  private async resolveEpicLinkFieldId(jiraBaseUrl: string, authHeader: string): Promise<string | null> {
    if (this.epicLinkFieldCache.has(jiraBaseUrl)) {
      return this.epicLinkFieldCache.get(jiraBaseUrl)!;
    }
    try {
      const res = await fetch(`${jiraBaseUrl}/rest/api/3/field`, {
        headers: { Authorization: authHeader, Accept: 'application/json' },
      });
      if (!res.ok) {
        this.epicLinkFieldCache.set(jiraBaseUrl, null);
        return null;
      }
      const fields: any[] = await res.json();
      const epicLinkField = fields.find(
        f => f.schema?.custom === 'com.pyxis.greenhopper.jira:gh-epic-link' || f.name === 'Epic Link',
      );
      const fieldId: string | null = epicLinkField?.id ?? null;
      this.epicLinkFieldCache.set(jiraBaseUrl, fieldId);
      return fieldId;
    } catch {
      this.epicLinkFieldCache.set(jiraBaseUrl, null);
      return null;
    }
  }

  /**
   * Construit le champ Jira permettant de rattacher un ticket à son Epic,
   * quel que soit le type de projet (classique ou nouvelle génération).
   */
  private async buildEpicLinkFields(
    jiraBaseUrl: string,
    authHeader: string,
    epicKey: string,
  ): Promise<Record<string, any>> {
    const epicLinkFieldId = await this.resolveEpicLinkFieldId(jiraBaseUrl, authHeader);
    if (epicLinkFieldId) {
      // Projet classique (company-managed) : champ personnalisé "Epic Link".
      return { [epicLinkFieldId]: epicKey };
    }
    // Projet nouvelle génération (team-managed) : hiérarchie native via "parent".
    return { parent: { key: epicKey } };
  }

  /**
   * Renvoie l'état actuel de la hiérarchie Jira d'une exigence :
   * - Si son Module est déjà rattaché à un Epic, ce dernier est renvoyé même
   *   si CETTE exigence n'a pas encore de Story — le frontend peut alors
   *   sauter directement à la création de la Story (silencieuse, sans picker),
   *   car le Module (donc le projet et l'Epic) est déjà déterminé.
   * - `linked: true` signifie que la Story de CETTE exigence existe déjà :
   *   l'export d'un cas de test peut se faire sans aucune information
   *   supplémentaire (juste créer la sous-tâche).
   */
  async getRequirementHierarchy(requirementId: string): Promise<JiraRequirementHierarchy> {
    const req = await this.prisma.requirement.findUnique({
      where: { id: requirementId },
      include: { module: true },
    });
    if (!req) throw new NotFoundException(`Exigence ${requirementId} introuvable`);

    const moduleProjectKey = req.module?.jira_project_key ?? undefined;
    const moduleEpicKey = req.module?.jira_epic_key ?? undefined;
    const moduleEpicUrl = req.module?.jira_epic_url ?? undefined;

    return {
      linked: !!req.jira_story_key,
      projectKey: req.jira_project_key ?? moduleProjectKey,
      epicKey: moduleEpicKey,
      epicUrl: moduleEpicUrl,
      storyKey: req.jira_story_key ?? undefined,
      storyUrl: req.jira_story_url ?? undefined,
    };
  }

  /**
   * Résout l'Epic Jira représentant le MODULE donné : le réutilise s'il existe
   * déjà (persisté sur le module), sinon le crée avec l'Epic choisi/créé par
   * l'utilisateur, et persiste le lien pour que toutes les exigences suivantes
   * de ce module le réutilisent automatiquement, sans jamais le redemander.
   */
  private async resolveOrCreateModuleEpic(
    module: { id: string; jira_project_key: string | null; jira_epic_key: string | null },
    projectKey: string | undefined,
    epicKey: string | undefined,
    epicUrl: string | undefined,
  ): Promise<{ projectKey: string; epicKey?: string }> {
    // Déjà lié auparavant → on réutilise tel quel, quoi que l'appelant ait fourni.
    if (module.jira_project_key) {
      return { projectKey: module.jira_project_key, epicKey: module.jira_epic_key ?? undefined };
    }

    if (!projectKey) {
      throw new BadRequestException(
        "Aucun projet Jira choisi. Sélectionnez un projet pour créer la hiérarchie de ce module (Epic → Story → Sous-tâche).",
      );
    }

    await this.prisma.requirementModule.update({
      where: { id: module.id },
      data: {
        jira_project_key: projectKey,
        jira_epic_key: epicKey ?? null,
        jira_epic_url: epicUrl ?? null,
      },
    });

    return { projectKey, epicKey };
  }

  /**
   * Résout la Story Jira représentant l'exigence donnée : la réutilise si elle
   * existe déjà (persistée sur l'exigence), sinon la crée sous l'Epic du Module
   * (résolu/créé au passage s'il n'existe pas encore) et persiste son lien pour
   * que tous les cas de test suivants de la même exigence la réutilisent
   * automatiquement, sans redemander à l'utilisateur.
   */
  private async resolveOrCreateStory(
    jiraBaseUrl: string,
    authHeader: string,
    req: {
      id: string;
      req_id: string;
      description: string;
      jira_project_key: string | null;
      jira_story_key: string | null;
      module: { id: string; jira_project_key: string | null; jira_epic_key: string | null; jira_epic_url: string | null };
    },
    projectKey: string | undefined,
    epicKey: string | undefined,
    storyIssueTypeId: string | undefined,
    storySummaryOverride?: string,
  ): Promise<{ storyKey: string; epicKey?: string; projectKey: string }> {
    // Déjà lié auparavant → on réutilise tel quel (l'utilisateur n'a rien à choisir de plus).
    if (req.jira_story_key && req.jira_project_key) {
      return { storyKey: req.jira_story_key, epicKey: req.module.jira_epic_key ?? undefined, projectKey: req.jira_project_key };
    }

    // Le Module = l'Epic : résolu une seule fois pour tout le module, puis
    // réutilisé automatiquement pour toutes ses exigences.
    const { projectKey: resolvedProjectKey, epicKey: resolvedEpicKey } = await this.resolveOrCreateModuleEpic(
      req.module,
      projectKey,
      epicKey,
      epicKey ? `${jiraBaseUrl}/browse/${epicKey}` : undefined,
    );

    const issueTypeId = storyIssueTypeId
      ?? (await this.resolveIssueTypeId(jiraBaseUrl, authHeader, resolvedProjectKey)).id;

    const customSummary = storySummaryOverride?.trim();
    const summaryRaw = customSummary || `[${req.req_id}] ${req.description}`;
    const summary = summaryRaw.length > 250 ? summaryRaw.slice(0, 247) + '...' : summaryRaw;

    const fields: any = {
      project: { key: resolvedProjectKey },
      issuetype: { id: issueTypeId },
      summary,
    };
    if (resolvedEpicKey) {
      Object.assign(fields, await this.buildEpicLinkFields(jiraBaseUrl, authHeader, resolvedEpicKey));
    }

    const res = await fetch(`${jiraBaseUrl}/rest/api/3/issue`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    if (!res.ok) {
      throw new Error(`Création de la Story pour l'exigence ${req.req_id} échouée : ${await this.extractJiraError(res)}`);
    }
    const data: any = await res.json();
    const storyKey: string = data.key;
    const storyUrl = `${jiraBaseUrl}/browse/${storyKey}`;

    await this.prisma.requirement.update({
      where: { id: req.id },
      data: {
        jira_project_key: resolvedProjectKey,
        jira_story_key: storyKey,
        jira_story_url: storyUrl,
      },
    });

    return { storyKey, epicKey: resolvedEpicKey, projectKey: resolvedProjectKey };
  }

  /**
   * Exporte (ou met à jour, si déjà exporté) un TC vers Jira, comme sous-tâche
   * de la Story de son exigence. La Story (et l'Epic parent) sont créées
   * automatiquement au premier export pour cette exigence, puis réutilisées
   * pour tous les cas de test suivants — l'utilisateur ne les choisit qu'une
   * seule fois par exigence.
   */
  async exportTestCase(
    userId: string,
    testCaseId: string,
    projectKey?: string,
    preresolvedIssueTypeId?: string,
    epicKey?: string,
    preresolvedStoryKey?: string,
    storySummary?: string,
  ): Promise<JiraExportResult> {
    const tc = await this.prisma.testCase.findUnique({
      where: { id: testCaseId },
      include: { requirement: { include: { module: true } } },
    });
    if (!tc) throw new NotFoundException(`TestCase ${testCaseId} introuvable`);

    const { jiraBaseUrl, jiraEmail, apiToken } = await this.getDecryptedCredentials(userId);
    const authHeader = this.authHeader(jiraEmail, apiToken);

    const req = tc.requirement;
    const summary = buildJiraSummary(tc, req);
    const description = buildJiraDescription(tc, req);
    const labels = buildJiraLabels(tc);

    try {
      // 1) Résout (ou crée au 1er export) la Story de l'exigence, sous l'Epic choisi.
      const { storyKey, projectKey: resolvedProjectKey } = preresolvedStoryKey
        ? { storyKey: preresolvedStoryKey, projectKey: req.jira_project_key || projectKey! }
        : await this.resolveOrCreateStory(jiraBaseUrl, authHeader, req, projectKey, epicKey, preresolvedIssueTypeId, storySummary);

      let issueKey: string;
      let action: 'created' | 'updated';

      if (tc.jira_issue_key) {
        // Déjà exporté auparavant → on met à jour la sous-tâche existante
        const putRes = await fetch(`${jiraBaseUrl}/rest/api/3/issue/${tc.jira_issue_key}`, {
          method: 'PUT',
          headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: { summary, description, labels } }),
        });
        if (!putRes.ok) {
          // L'issue a peut-être été supprimée côté Jira depuis → on retente en création
          if (putRes.status === 404) {
            const subtaskType = await this.fetchSubtaskType(jiraBaseUrl, authHeader, resolvedProjectKey);
            issueKey = await this.createSubtask(jiraBaseUrl, authHeader, resolvedProjectKey, storyKey, summary, description, labels, subtaskType.id);
            action = 'created';
          } else {
            throw new Error(await this.extractJiraError(putRes));
          }
        } else {
          issueKey = tc.jira_issue_key;
          action = 'updated';
        }
      } else {
        const subtaskType = await this.fetchSubtaskType(jiraBaseUrl, authHeader, resolvedProjectKey);
        issueKey = await this.createSubtask(jiraBaseUrl, authHeader, resolvedProjectKey, storyKey, summary, description, labels, subtaskType.id);
        action = 'created';
      }

      const issueUrl = `${jiraBaseUrl}/browse/${issueKey}`;

      await this.prisma.testCase.update({
        where: { id: testCaseId },
        data: {
          jira_issue_key: issueKey,
          jira_issue_url: issueUrl,
          jira_project_key: resolvedProjectKey,
          jira_exported_at: new Date(),
        },
      });

      return { testCaseId, testId: tc.test_id, success: true, issueKey, issueUrl, action };
    } catch (e: any) {
      this.logger.warn(`Export Jira échoué pour TC ${tc.test_id}: ${e.message}`);
      return { testCaseId, testId: tc.test_id, success: false, error: e.message };
    }
  }

  /** Crée le cas de test comme sous-tâche (enfant direct) de la Story de son exigence. */
  private async createSubtask(
    jiraBaseUrl: string,
    authHeader: string,
    projectKey: string,
    storyKey: string,
    summary: string,
    description: any,
    labels: string[],
    subtaskTypeId: string,
  ): Promise<string> {
    const res = await fetch(`${jiraBaseUrl}/rest/api/3/issue`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          project: { key: projectKey },
          issuetype: { id: subtaskTypeId },
          parent: { key: storyKey },
          summary,
          description,
          labels,
        },
      }),
    });
    if (!res.ok) {
      throw new Error(await this.extractJiraError(res));
    }
    const data: any = await res.json();
    return data.key;
  }

  private async extractJiraError(res: Response): Promise<string> {
    try {
      const data: any = await res.json();
      const messages = [
        ...(data.errorMessages || []),
        ...Object.values(data.errors || {}),
      ];
      if (messages.length) return messages.join(' ');
    } catch { /* ignore parse error */ }
    return `Erreur Jira (HTTP ${res.status})`;
  }

  // ══════════════════════════════════════════════════════════════════════
  // EXPORT EN MASSE (tous les TC persistés d'un requirement)
  // ══════════════════════════════════════════════════════════════════════

  async exportAllForRequirement(
    userId: string,
    requirementId: string,
    projectKey?: string,
    userChosenIssueTypeId?: string,
    epicKey?: string,
    storySummary?: string,
  ): Promise<{ total: number; success: number; failed: number; results: JiraExportResult[] }> {
    // On valide les identifiants une seule fois avant de boucler, pour échouer vite
    // si le compte Jira n'est pas connecté / le token est invalide.
    const { jiraBaseUrl, jiraEmail, apiToken } = await this.getDecryptedCredentials(userId);
    const authHeader = this.authHeader(jiraEmail, apiToken);

    const req = await this.prisma.requirement.findUnique({ where: { id: requirementId }, include: { module: true } });
    if (!req) throw new NotFoundException(`Exigence ${requirementId} introuvable`);

    const testCases = await this.prisma.testCase.findMany({ where: { requirement_id: requirementId } });
    if (testCases.length === 0) {
      throw new BadRequestException('Aucun cas de test sauvegardé pour cette exigence.');
    }

    // La Story (et l'Epic) ne sont résolues/créées qu'UNE SEULE FOIS pour tout le lot,
    // puis réutilisées pour chaque cas de test (au lieu d'un aller-retour Jira par TC).
    const { storyKey, projectKey: resolvedProjectKey } = await this.resolveOrCreateStory(
      jiraBaseUrl, authHeader, req, projectKey, epicKey, userChosenIssueTypeId, storySummary,
    );

    const results: JiraExportResult[] = [];
    for (const tc of testCases) {
      // Séquentiel (pas Promise.all) pour rester sous les limites de rate-limit de l'API Jira
      // eslint-disable-next-line no-await-in-loop
      const result = await this.exportTestCase(userId, tc.id, resolvedProjectKey, undefined, epicKey, storyKey);
      results.push(result);
    }

    const success = results.filter(r => r.success).length;
    return { total: results.length, success, failed: results.length - success, results };
  }
}