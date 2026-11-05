import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PDFParse } from 'pdf-parse';
import * as mammoth from 'mammoth';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { SrsService } from '../srs/srs.service'; // ← NOUVEAU
import { ConfluenceService } from '../confluence/confluence.service';
import { ProjectService } from '../project/project.service';

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private llmService: LlmService,
    private readonly srsService: SrsService,
    private readonly confluenceService: ConfluenceService,
    private readonly projectService: ProjectService,
  ) {}

  async processDocument(
    file: Express.Multer.File,
    projectName: string,
    projectDescription?: string,
    ownerId?: string,
  ) {
    const content = await this.extractText(file);
    if (!content || content.trim().length < 50) {
      throw new BadRequestException('Document is empty or too short');
    }

    await this.projectService.ensureUniqueProjectName(projectName);

    // Création du projet via Prisma (champs valides uniquement)
    const project = await this.prisma.project.create({
      data: {
        name: projectName,
        document_type: projectDescription || undefined,
        owner_id: ownerId || undefined,
      },
    });

    const startedAt = Date.now();

    // Lance le pipeline en arrière-plan — sans throw pour ne pas crasher
    this.runExtractionPipeline(project.id, content, file.originalname, startedAt).catch((err) => {
      this.logger.error(`Extraction pipeline failed for project ${project.id}`, err);
    });

    return project;
  }

  /**
   * Importe une page Confluence existante et lance le même pipeline
   * d'extraction (modules/exigences) que pour un document uploadé.
   */
  async importFromConfluence(
    ownerId: string,
    spaceKey: string,
    pageId: string,
    projectName?: string,
    projectDescription?: string,
  ) {
    const page = await this.confluenceService.getPageContent(ownerId, pageId);
    const content = page.text;
    if (!content || content.trim().length < 50) {
      throw new BadRequestException('La page Confluence est vide ou trop courte pour être analysée.');
    }

    await this.projectService.ensureUniqueProjectName(projectName?.trim() || page.title);

    const project = await this.prisma.project.create({
      data: {
        name: projectName?.trim() || page.title,
        document_type: projectDescription || undefined,
        owner_id: ownerId || undefined,
      },
    });

    const startedAt = Date.now();

    this.runExtractionPipeline(project.id, content, `${page.title} (Confluence)`, startedAt).catch((err) => {
      this.logger.error(`Extraction pipeline failed for project ${project.id}`, err);
    });

    return project;
  }

   private async runExtractionPipeline(
    projectId: string,
    content: string,
    filename: string = 'document',
    startedAt: number = Date.now(),
  ): Promise<void> {
    this.logger.log(`Starting extraction pipeline for project ${projectId}`);
    try {
      // Vérifier que le projet existe encore avant de démarrer
      const projectExists = await this.prisma.project.findUnique({ where: { id: projectId } });
      if (!projectExists) {
        this.logger.warn(`Project ${projectId} was deleted before pipeline started — aborting`);
        return;
      }
 
      // ── ÉTAPE 1 : Indexation SRS vectorielle ─────────────────────────────────
      // On indexe le contenu du document AVANT l'extraction LLM pour que le
      // contexte SRS soit disponible dès la première génération de test cases.
      // C'est non-bloquant : si l'indexation échoue, l'extraction continue quand même.
      this.logger.log(`📄 [SRS AUTO-INDEX] Indexing "${filename}" for project ${projectId}...`);
      try {
        const srsResult = await this.srsService.uploadSrs(projectId, filename, content);
        this.logger.log(
          `✅ [SRS AUTO-INDEX] ${srsResult.chunksCount} chunks indexed — project ${projectId}`,
        );
      } catch (srsErr: any) {
        // Non-bloquant : l'extraction des exigences peut continuer sans SRS
        this.logger.warn(
          `⚠️ [SRS AUTO-INDEX] Failed (non-blocking): ${srsErr.message}`,
        );
      }
 
      // ── ÉTAPE 2 : Extraction des exigences via LLM ───────────────────────────
      const extractedModules = await this.llmService.extractRequirements(content, projectId);
      this.logger.log(`Extracted ${extractedModules.length} modules`);
 
      // Re-vérifier que le projet existe encore après l'appel LLM (peut durer ~20 min)
      const projectStillExists = await this.prisma.project.findUnique({ where: { id: projectId } });
      if (!projectStillExists) {
        this.logger.warn(`Project ${projectId} was deleted during LLM extraction — aborting save`);
        return;
      }
 
      // ── ÉTAPE 3 : Persistance en base ────────────────────────────────────────
      let reqCounter = 1;
      for (const modData of extractedModules) {
        const module = await this.prisma.requirementModule.create({
          data: {
            name: modData.name,
            description: modData.description,
            project_id: projectId,
          },
        });
        for (const reqData of modData.requirements || []) {
          await this.prisma.requirement.create({
            data: {
              req_id: reqData.refCode || `REQ-${String(reqCounter).padStart(3, '0')}`,
              description: reqData.description,
              priority: reqData.priority || 'MEDIUM',
              manually_edited: false,
              module_id: module.id,
            },
          });
          reqCounter++;
        }
      }
 
      // Marquer le projet comme terminé
      const extraction_duration_ms = Date.now() - startedAt;
      await this.prisma.project.update({
        where: { id: projectId },
        data: { status: 'done', extraction_duration_ms },
      });
      this.logger.log(`Extraction pipeline completed for project ${projectId} in ${extraction_duration_ms}ms`);

      // Création automatique de l'espace Confluence (fire-and-forget) — si le
      // propriétaire du projet a un compte Atlassian connecté (via Jira),
      // sinon le statut reste "none" et rien ne se passe.
      this.confluenceService.createProjectSpace(projectId).catch(err => {
        this.logger.error(`Confluence space creation failed for project ${projectId}`, err);
      });
    } catch (err) {
      this.logger.error('Extraction pipeline error', err);
      try {
        await this.prisma.project.update({
          where: { id: projectId },
          data: {
            status: 'error',
            error_message: err instanceof Error ? err.message : 'Unknown error',
          },
        });
      } catch (updateErr) {
        this.logger.error(`Failed to update project ${projectId} error status`, updateErr);
      }
    }
  }

  async getProjectStatus(projectId: string) {
    if (!projectId || projectId === 'null' || projectId.trim() === '') {
      throw new BadRequestException('Invalid projectId');
    }

    try {
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        include: {
          modules: {
            include: {
              requirements: {
                include: {
                  test_cases: true,
                },
              },
            },
          },
        },
      });

      if (!project) {
        throw new BadRequestException('Project not found');
      }

      return {
        projectId: project.id,
        status: project.status,
        modules: project.modules || [],
        error_message: project.error_message || undefined,
        extraction_duration_ms: project.extraction_duration_ms ?? undefined,
      };
    } catch (err) {
      this.logger.error(`Error fetching project status for ${projectId}`, err);
      throw err;
    }
  }

  private async extractText(file: Express.Multer.File): Promise<string> {
    const mime = file.mimetype;
    const name = file.originalname.toLowerCase();
    if (mime === 'application/pdf' || name.endsWith('.pdf')) {
      const parser = new PDFParse({ data: file.buffer });
      try {
        const data = await parser.getText();
        return data.text;
      } finally {
        await parser.destroy();
      }
    }
    if (
      mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      name.endsWith('.docx')
    ) {
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      return result.value;
    }
    if (mime === 'text/plain' || name.endsWith('.txt') || name.endsWith('.md')) {
      return file.buffer.toString('utf-8');
    }
    throw new BadRequestException(
      `Unsupported file type: ${mime}. Supported: PDF, DOCX, TXT, MD`,
    );
  }
}