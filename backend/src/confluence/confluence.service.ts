import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { decryptToken } from '../jira/jira-crypto.util';
import { buildProjectOverviewStorage } from './confluence-content.util';

export interface ConfluenceSpaceStatus {
  status: 'none' | 'pending' | 'created' | 'failed';
  spaceKey?: string | null;
  spaceUrl?: string | null;
  error?: string | null;
  createdAt?: Date | null;
}

export interface ConfluenceSpaceSummary {
  key: string;
  name: string;
  id: string;
}

export interface ConfluencePageSummary {
  id: string;
  title: string;
  spaceKey: string;
  webui: string;
  lastModified?: string;
}

@Injectable()
export class ConfluenceService {
  private readonly logger = new Logger(ConfluenceService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ══════════════════════════════════════════════════════════════════════
  // Credentials Atlassian — réutilisées depuis la connexion Jira existante
  // (même compte Atlassian, mêmes identifiants email + token API chiffré).
  // ══════════════════════════════════════════════════════════════════════

  private async getCredentials(userId: string): Promise<{ baseUrl: string; authHeader: string; jiraBaseUrl: string }> {
    const cred = await this.prisma.jiraCredential.findUnique({ where: { user_id: userId } });
    if (!cred) {
      throw new Error("Aucun compte Atlassian connecté. Connecte d'abord ton compte Jira dans les paramètres.");
    }
    let apiToken: string;
    try {
      apiToken = decryptToken({
        encryptedToken: cred.encrypted_token,
        iv: cred.token_iv,
        authTag: cred.token_auth_tag,
      });
    } catch (decryptErr: any) {
      throw new Error(`Impossible de déchiffrer le token Atlassian : ${decryptErr.message}`);
    }
    return {
      baseUrl: this.confluenceBaseUrl(cred.jira_base_url),
      authHeader: this.authHeader(cred.jira_email, apiToken),
      jiraBaseUrl: cred.jira_base_url,
    };
  }

  private authHeader(email: string, apiToken: string): string {
    return 'Basic ' + Buffer.from(`${email}:${apiToken}`).toString('base64');
  }

  private confluenceBaseUrl(jiraBaseUrl: string): string {
    return `${jiraBaseUrl.replace(/\/+$/, '')}/wiki`;
  }

  // ══════════════════════════════════════════════════════════════════════
  // Import — parcourir les espaces / pages Confluence et récupérer le
  // contenu d'une page pour l'injecter dans le pipeline d'extraction.
  // ══════════════════════════════════════════════════════════════════════

  async listSpaces(userId: string): Promise<ConfluenceSpaceSummary[]> {
    const { baseUrl, authHeader } = await this.getCredentials(userId);
    const res = await fetch(`${baseUrl}/rest/api/space?limit=100&status=current`, {
      headers: { Authorization: authHeader, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Impossible de récupérer les espaces Confluence (HTTP ${res.status}) : ${await this.extractError(res)}`);
    const data: any = await res.json();
    return (data.results || []).map((s: any) => ({ key: s.key, name: s.name, id: String(s.id) }));
  }

  async searchPagesInSpace(userId: string, spaceKey: string, query?: string): Promise<ConfluencePageSummary[]> {
    const { baseUrl, authHeader } = await this.getCredentials(userId);
    let cql = `space="${spaceKey}" and type=page`;
    if (query && query.trim()) {
      cql += ` and title~"${query.trim().replace(/"/g, '\\"')}*"`;
    }
    const url = `${baseUrl}/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=50&expand=version`;
    const res = await fetch(url, { headers: { Authorization: authHeader, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Impossible de rechercher les pages Confluence (HTTP ${res.status}) : ${await this.extractError(res)}`);
    const data: any = await res.json();
    return (data.results || []).map((p: any) => ({
      id: p.id,
      title: p.title,
      spaceKey,
      webui: p._links?.webui || '',
      lastModified: p.version?.when,
    }));
  }

  /** Récupère le contenu d'une page Confluence, converti en texte brut pour le pipeline d'extraction. */
  async getPageContent(userId: string, pageId: string): Promise<{ title: string; text: string }> {
    const { baseUrl, authHeader } = await this.getCredentials(userId);
    const res = await fetch(`${baseUrl}/rest/api/content/${pageId}?expand=body.storage`, {
      headers: { Authorization: authHeader, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Impossible de récupérer la page Confluence (HTTP ${res.status}) : ${await this.extractError(res)}`);
    const data: any = await res.json();
    const storageHtml = data.body?.storage?.value || '';
    return { title: data.title || 'Page Confluence', text: this.storageHtmlToText(storageHtml) };
  }

  /** Convertit le format "storage" (XHTML) de Confluence en texte brut lisible pour le LLM. */
  private storageHtmlToText(html: string): string {
    return html
      .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<td[^>]*>/gi, ' | ')
      .replace(/<th[^>]*>/gi, ' | ')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ══════════════════════════════════════════════════════════════════════
  // Génération d'une clé d'espace unique à partir du nom du projet
  // ══════════════════════════════════════════════════════════════════════

  private generateSpaceKey(projectName: string, projectId: string, attempt = 0): string {
    const base = (projectName || 'PRJ')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 6) || 'PRJ';
    const suffix = projectId.slice(-6).toUpperCase();
    const extra = attempt > 0 ? String(Date.now()).slice(-4) : '';
    // Une clé Confluence doit commencer par une lettre
    const key = `${/^[A-Z]/.test(base) ? base : 'P' + base}${suffix}${extra}`;
    return key.slice(0, 40);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Statut (pour affichage frontend)
  // ══════════════════════════════════════════════════════════════════════

  async getStatus(projectId: string): Promise<ConfluenceSpaceStatus> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException(`Projet ${projectId} introuvable`);
    return {
      status: (project.confluence_status as any) || 'none',
      spaceKey: project.confluence_space_key,
      spaceUrl: project.confluence_space_url,
      error: project.confluence_error,
      createdAt: project.confluence_created_at,
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  // Création automatique de l'espace Confluence pour un projet
  // Appelée en fire-and-forget juste après l'extraction des modules/exigences.
  // ══════════════════════════════════════════════════════════════════════

  async createProjectSpace(projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        modules: { include: { requirements: true } },
        assignedUsers: { select: { id: true, role: true } },
      },
    });
    if (!project) return;

    // Comptes Atlassian candidats, par ordre de priorité : le propriétaire du
    // projet, puis les BA et PO assignés (un BA/PO connecté à Atlassian peut
    // donc créer l'espace Confluence même si le propriétaire ne l'est pas).
    const candidateUserIds = [
      ...(project.owner_id ? [project.owner_id] : []),
      ...project.assignedUsers
        .filter(u => u.role === Role.BA || u.role === Role.PO)
        .map(u => u.id),
    ].filter((id, idx, arr) => arr.indexOf(id) === idx);

    if (candidateUserIds.length === 0) {
      this.logger.warn(`Projet ${projectId} sans propriétaire ni BA/PO assigné — création Confluence ignorée.`);
      return;
    }

    // Marque tout de suite "pending" pour que l'UI affiche quelque chose pendant
    // qu'on résout les credentials + qu'on appelle l'API Confluence.
    await this.prisma.project.update({
      where: { id: projectId },
      data: { confluence_status: 'pending', confluence_error: null },
    });

    try {
      let cred: Awaited<ReturnType<typeof this.prisma.jiraCredential.findUnique>> = null;
      for (const userId of candidateUserIds) {
        cred = await this.prisma.jiraCredential.findUnique({ where: { user_id: userId } });
        if (cred) break;
      }
      if (!cred) {
        // Ni le propriétaire ni un BA/PO assigné n'est connecté à Atlassian → statut explicite (pas de blocage silencieux)
        await this.prisma.project.update({
          where: { id: projectId },
          data: { confluence_status: 'none', confluence_error: null },
        });
        return;
      }

      let apiToken: string;
      try {
        apiToken = decryptToken({
          encryptedToken: cred.encrypted_token,
          iv: cred.token_iv,
          authTag: cred.token_auth_tag,
        });
      } catch (decryptErr: any) {
        throw new Error(
          `Impossible de déchiffrer le token Atlassian (JIRA_TOKEN_ENCRYPTION_KEY invalide ou modifiée depuis la connexion) : ${decryptErr.message}`,
        );
      }

      const jiraBaseUrl = cred.jira_base_url;
      const jiraEmail = cred.jira_email;
      const baseUrl = this.confluenceBaseUrl(jiraBaseUrl);
      const authHeader = this.authHeader(jiraEmail, apiToken);

      const { key, spaceId } = await this.createSpaceWithRetry(baseUrl, authHeader, project.name, project.id);
      const defaultSpaceUrl = `${jiraBaseUrl.replace(/\/+$/, '')}/wiki/spaces/${key}/overview`;

      const modulesData = project.modules.map(m => ({
        name: m.name,
        description: m.description,
        requirements: m.requirements.map(r => ({
          req_id: r.req_id,
          description: r.description,
          priority: r.priority,
        })),
      }));

      const { webui } = await this.populateHomepage(baseUrl, authHeader, key, project.name, project.document_type, modulesData);
      const spaceUrl = webui ? `${jiraBaseUrl.replace(/\/+$/, '')}/wiki${webui}` : defaultSpaceUrl;

      await this.prisma.project.update({
        where: { id: projectId },
        data: {
          confluence_status: 'created',
          confluence_space_key: key,
          confluence_space_id: spaceId,
          confluence_space_url: spaceUrl,
          confluence_error: null,
          confluence_created_at: new Date(),
        },
      });
      this.logger.log(`Espace Confluence créé pour le projet ${projectId}: ${key}`);
    } catch (e: any) {
      this.logger.warn(`Création Confluence échouée pour le projet ${projectId}: ${e.message}`);
      await this.prisma.project.update({
        where: { id: projectId },
        data: { confluence_status: 'failed', confluence_error: e.message?.slice(0, 500) },
      }).catch(updateErr => {
        this.logger.error(`Impossible d'écrire le statut "failed" pour le projet ${projectId}`, updateErr);
      });
    }
  }

  /** Relance manuelle (bouton "Réessayer" côté frontend en cas d'échec). */
  async retryProjectSpace(projectId: string): Promise<void> {
    await this.createProjectSpace(projectId);
  }

  // ── Création de l'espace, avec une retentative en cas de clé déjà utilisée ─

  private async createSpaceWithRetry(
    baseUrl: string,
    authHeader: string,
    projectName: string,
    projectId: string,
  ): Promise<{ key: string; spaceId: string }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const key = this.generateSpaceKey(projectName, projectId, attempt);
      const res = await fetch(`${baseUrl}/rest/api/space`, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key,
          name: projectName.slice(0, 200),
          description: {
            plain: { value: 'Espace créé automatiquement par SpecChef à partir du document SRS.', representation: 'plain' },
          },
        }),
      });
      if (res.ok) {
        const data: any = await res.json();
        return { key: data.key, spaceId: String(data.id) };
      }
      const errText = await this.extractError(res);
      const isKeyConflict = res.status === 400 && /key.*(already|existe|used)/i.test(errText);
      if (!isKeyConflict || attempt === 1) {
        if (res.status === 403) {
          throw new Error(
            "Le compte Atlassian connecté n'a pas les droits pour créer un espace Confluence (droits admin requis).",
          );
        }
        throw new Error(errText);
      }
      // sinon on boucle et on retente avec une clé différente
    }
    throw new Error("Impossible de créer l'espace Confluence après plusieurs tentatives.");
  }

  // ── Remplit la page d'accueil de l'espace avec les modules/exigences ──────
  // (avec retry + repli sur une page dédiée si la homepage n'est pas encore
  // disponible juste après la création de l'espace — Confluence a parfois un
  // léger délai de provisioning).

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async populateHomepage(
    baseUrl: string,
    authHeader: string,
    spaceKey: string,
    projectName: string,
    documentType: string | null | undefined,
    modules: Array<{ name: string; description?: string | null; requirements: Array<{ req_id: string; description: string; priority: string }> }>,
  ): Promise<{ webui?: string }> {
    const storageBody = buildProjectOverviewStorage(projectName, documentType, modules);

    // 1) On tente de récupérer et remplir la homepage auto-créée avec l'espace,
    //    avec quelques retries car Confluence peut mettre un court instant à
    //    la rendre disponible via l'API juste après la création de l'espace.
    let homepage: any = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await this.sleep(1500);
      const spaceRes = await fetch(
        `${baseUrl}/rest/api/space/${encodeURIComponent(spaceKey)}?expand=homepage.version`,
        { headers: { Authorization: authHeader, Accept: 'application/json' } },
      );
      if (!spaceRes.ok) {
        const errText = await this.extractError(spaceRes);
        throw new Error(`Impossible de récupérer l'espace ${spaceKey} (HTTP ${spaceRes.status}) : ${errText}`);
      }
      const spaceData: any = await spaceRes.json();
      if (spaceData.homepage?.id) {
        homepage = spaceData.homepage;
        break;
      }
    }

    if (homepage?.id) {
      const nextVersion = (homepage.version?.number || 1) + 1;
      const updateRes = await fetch(`${baseUrl}/rest/api/content/${homepage.id}`, {
        method: 'PUT',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: homepage.id,
          type: 'page',
          title: projectName.slice(0, 200),
          space: { key: spaceKey },
          version: { number: nextVersion },
          body: { storage: { value: storageBody, representation: 'storage' } },
        }),
      });
      if (updateRes.ok) {
        const updated: any = await updateRes.json().catch(() => null);
        this.logger.log(`Homepage Confluence remplie pour l'espace ${spaceKey}`);
        return { webui: updated?._links?.webui };
      }
      const errText = await this.extractError(updateRes);
      this.logger.warn(`Échec du remplissage de la homepage (HTTP ${updateRes.status}) : ${errText} — repli sur une page dédiée.`);
      // on ne throw pas ici : on tente le repli ci-dessous plutôt que d'échouer tout de suite
    } else {
      this.logger.warn(`Homepage introuvable pour l'espace ${spaceKey} après plusieurs tentatives — repli sur une page dédiée.`);
    }

    // 2) Repli : création d'une page dédiée "Modules & Exigences" directement
    //    sous l'espace, qui ne dépend pas de la homepage auto-générée.
    const createRes = await fetch(`${baseUrl}/rest/api/content`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'page',
        title: `Modules & Exigences — ${projectName}`.slice(0, 200),
        space: { key: spaceKey },
        body: { storage: { value: storageBody, representation: 'storage' } },
      }),
    });
    if (!createRes.ok) {
      const errText = await this.extractError(createRes);
      throw new Error(`Impossible de créer la page des modules/exigences dans l'espace ${spaceKey} (HTTP ${createRes.status}) : ${errText}`);
    }
    const created: any = await createRes.json().catch(() => null);
    this.logger.log(`Page "Modules & Exigences" créée dans l'espace ${spaceKey}`);
    return { webui: created?._links?.webui };
  }

  private async extractError(res: Response): Promise<string> {
    try {
      const data: any = await res.json();
      if (data?.message) return data.message;
      if (data?.data?.errors) return JSON.stringify(data.data.errors);
    } catch { /* ignore parse error */ }
    return `Erreur Confluence (HTTP ${res.status})`;
  }
}