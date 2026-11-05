import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { CacheService } from '../cache/cache.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AnalyzerService {
  private readonly logger = new Logger(AnalyzerService.name);
  private processingTasks = new Map<string, Promise<void>>(); // Traque les tâches en cours

  constructor(
    private readonly cacheService: CacheService,
    private readonly prisma: PrismaService,
  ) {}

async analyzeFile(file: Express.Multer.File): Promise<any> {
  const fileSizeMB = file.size / (1024 * 1024);
  const startedAt = Date.now();
  this.logger.log(`📁 Début analyse: ${file.originalname} (${fileSizeMB.toFixed(2)} MB)`);
 
  // ── 1. Hash du fichier ──────────────────────────────────────────────────
  let fileHash: string | null = null;
  try {
    fileHash = await this.cacheService.hashFile(file.path);
 
    // ── 2. Vérifier le cache d'abord (le plus rapide) ─────────────────────
    const cached = await this.cacheService.getAnalysis(fileHash);
    if (cached) {
      const duration_ms = Date.now() - startedAt;
      this.logger.log(`🎯 Cache HIT — ${file.originalname} — ${duration_ms}ms`);
      this._deleteUpload(file.path, file.originalname);
      return { ...cached, duration_ms, _cache: { hit: true, source: 'cache' } };
    }
 
    // ── 3. Vérifier MongoDB ensuite (doc déjà analysé avant) ──────────
    const existingProject = await this.prisma.project.findFirst({
      where: { source_hash: fileHash },
      include: { modules: { include: { requirements: { include: { test_cases: true } } } } },
    });
 
    if (existingProject) {
      const duration_ms = Date.now() - startedAt;
      this.logger.log(`🎯 Cache HIT PostgreSQL — projet existant: ${existingProject.id} — ${duration_ms}ms`);
 
      // Reconstruire le format analysis à partir de PostgreSQL
      const analysisFromDB = this._projectToAnalysis(existingProject, fileSizeMB);
 
      // Re-stocker dans le cache pour les prochains appels
      await this.cacheService.setAnalysis(fileHash, analysisFromDB);
      this.logger.log(`♻️  Cache rechargé depuis PostgreSQL`);
 
      this._deleteUpload(file.path, file.originalname);
      return {
        ...analysisFromDB,
        duration_ms,
        _cache: { hit: true, source: 'postgresql', project_id: existingProject.id },
      };
    }
 
  } catch (err: any) {
    this.logger.warn(`Cache lookup ignoré: ${err.message}`);
  }
 
  // ── 4. Rien trouvé → appeler Python ──────────────────────────────────
  this.logger.log(`❌ Cache MISS total — appel Python`);
  const result = await this._runPython(file, fileHash);
  const duration_ms = Date.now() - startedAt;
  result.duration_ms = duration_ms;
  this.logger.log(`✅ Analyse terminée: ${file.originalname} — ${duration_ms}ms`);
 
  // ── 5. Stocker dans le cache ──────────────────────────────────────────────
  if (fileHash) {
    try {
      await this.cacheService.setAnalysis(fileHash, result);
    } catch { /* ignore */ }
  }
 
  return result;
}

private _projectToAnalysis(project: any, fileSizeMB: number): any {
  // Reconstruire le texte depuis les requirements en base
  // pour que step1 puisse le retraiter si nécessaire
  const modules = (project.modules || []).map((mod: any) => ({
    name: mod.name,
    description: mod.description,
    requirements: (mod.requirements || []).map((req: any) => ({
      id: req.req_id,
      description: req.description,
      priority: req.priority,
    })),
  }));
 
  return {
    extension: project.name?.split('.').pop() || 'pdf',
    filename: project.name,
    size_mb: fileSizeMB,
    content: {
      type: 'document',
      // On reconstruit un markdown minimal depuis les requirements
      full_content: modules
        .map((mod: any) => {
          const reqs = mod.requirements
            .map((r: any) => `${r.id}. ${r.description}`)
            .join('\n');
          return `## ${mod.name}\n\n${reqs}`;
        })
        .join('\n\n'),
      char_count: modules.reduce((a: number, m: any) =>
        a + m.requirements.reduce((b: number, r: any) => b + r.description.length, 0), 0),
      extractor: 'postgresql_cache',
    },
    processing_info: {
      file_size_mb: fileSizeMB,
      processing_time: new Date().toISOString(),
      source: 'postgresql',
    },
    _existing_project_id: project.id,  // ← frontend peut récupérer l'ancien project_id
  };
}
 

private _runPython(file: Express.Multer.File, fileHash: string | null): Promise<any> {
  const fileSizeMB = file.size / (1024 * 1024);
  const pythonScript = path.join(__dirname, '../../analyzer/analyze.py');

  return new Promise((resolve, reject) => {
    const python = spawn('python3', [pythonScript, file.path]);
    let dataString = '';
    let errorString = '';

    python.stdout?.on('data', (d) => { dataString += d.toString(); });
    python.stderr?.on('data', (d) => {
      const msg = d.toString();
      if (msg.includes('[PROGRESS]')) this.logger.log(`📄 ${msg.replace('[PROGRESS]', '').trim()}`);
      else { errorString += msg; this.logger.error(`❌ ${msg}`); }
    });

    const timeout = setTimeout(() => { python.kill(); reject(new Error('Timeout >15min')); }, 15 * 60 * 1000);

    python.on('close', (code) => {
      clearTimeout(timeout);
      this._deleteUpload(file.path, file.originalname);
      if (code !== 0) { reject(new Error(`Erreur analyse: ${errorString || 'Code ' + code}`)); return; }
      try {
        const result = JSON.parse(dataString);
        result.processing_info = { file_size_mb: fileSizeMB, is_large_file: fileSizeMB > 100, is_very_large_file: fileSizeMB > 500, processing_time: new Date().toISOString() };
        result._fileHash = fileHash;  // ← passer le hash au controller
        resolve(result);
      } catch { reject(new Error('Erreur parsing résultat Python')); }
    });
  });
}

private _deleteUpload(filePath: string, name: string): void {
  try { fs.unlinkSync(filePath); this.logger.log(`🗑️  Supprimé: ${name}`); }
  catch (e: any) { this.logger.error(`⚠️  Suppression: ${e.message}`); }
}

// ─────────────────────────────────────────────────────────────────────────
// TRAITEMENT ASYNCHRONE
// ─────────────────────────────────────────────────────────────────────────

/**
 * Lance le traitement du fichier EN ARRIÈRE-PLAN
 * Retourne immédiatement le projectId avec status = "processing"
 */
async analyzeFileAsync(file: Express.Multer.File, projectName?: string): Promise<{ projectId: string; status: string }> {
  this.logger.log(`📁 Lancement analyse async: ${file.originalname}`);

  // Créer le projet avec statut "processing"
  const project = await this.prisma.project.create({
    data: {
      name: projectName || file.originalname,
      document_type: null,
      status: 'processing',
      source_hash: null,
    },
  });

  this.logger.log(`📌 Projet créé: ${project.id} avec status="processing"`);

  // Lancer le traitement en arrière-plan (sans attendre)
  this.processingTasks.set(project.id, this._processFileInBackground(file, project.id));

  return { projectId: project.id, status: 'processing' };
}

/**
 * Traitement du fichier en arrière-plan
 */
private async _processFileInBackground(file: Express.Multer.File, projectId: string): Promise<void> {
  try {
    this.logger.log(`⏳ Traitement en arrière-plan lancé pour ${projectId}`);

    // Hash du fichier
    let fileHash: string | null = null;
    try {
      fileHash = await this.cacheService.hashFile(file.path);
    } catch (err: any) {
      this.logger.warn(`Hachage du fichier échoué: ${err.message}`);
    }

    // Vérifier le cache
    if (fileHash) {
      const cached = await this.cacheService.getAnalysis(fileHash);
      if (cached && cached.content?.modules) {
        this.logger.log(`🎯 Cache HIT — utilisation pour ${projectId}`);
        await this._saveCachedAnalysisToProject(projectId, cached, fileHash);
        this._deleteUpload(file.path, file.originalname);
        return;
      }
    }

    // Vérifier le cache MongoDB
    if (fileHash) {
      const existingProject = await this.prisma.project.findFirst({
        where: { source_hash: fileHash, status: 'done' },
        include: { modules: { include: { requirements: { include: { test_cases: true } } } } },
      });

      if (existingProject) {
        this.logger.log(`🎯 Cache HIT MongoDB — copie pour ${projectId}`);
        await this._copyProjectModules(existingProject.id, projectId);
        await this.prisma.project.update({
          where: { id: projectId },
          data: { source_hash: fileHash, status: 'done' },
        });
        this._deleteUpload(file.path, file.originalname);
        return;
      }
    }

    // Pas de cache → appeler Python
    this.logger.log(`❌ Pas de cache — analyse Python pour ${projectId}`);
    const result = await this._runPython(file, fileHash);

    // Sauvegarder dans le cache
    if (fileHash) {
      try {
        await this.cacheService.setAnalysis(fileHash, result);
      } catch (err: any) {
        this.logger.warn(`Sauvegarde cache échouée: ${err.message}`);
      }
    }

    // Sauvegarder dans MongoDB et mettre à jour le statut
    await this._savePythonResultToProject(projectId, result, fileHash);
    
    this.logger.log(`✅ Traitement terminé pour ${projectId}`);
  } catch (error: any) {
    this.logger.error(`❌ Erreur traitement async pour ${projectId}: ${error.message}`);
    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        status: 'error',
        error_message: error.message || 'Erreur inconnue',
      },
    });
  } finally {
    this.processingTasks.delete(projectId);
  }
}

/**
 * Récupère l'état du projet
 */
async getProjectStatus(projectId: string): Promise<{
  projectId: string;
  status: 'processing' | 'done' | 'error';
  modules?: any[];
  error_message?: string;
}> {
  // Valider que projectId n'est pas null/undefined
  if (!projectId || projectId === 'null' || projectId === '') {
    throw new Error('projectId invalide ou manquant');
  }

  const project = await this.prisma.project.findUnique({
    where: { id: projectId },
    include: {
      modules: {
        include: {
          requirements: {
            include: { test_cases: true },
          },
        },
      },
    },
  });

  if (!project) {
    throw new Error(`Projet ${projectId} introuvable`);
  }

  const response: any = {
    projectId: project.id,
    status: project.status,
  };

  if (project.status === 'done') {
    // Formater les modules pour le frontend
    response.modules = project.modules.map(mod => ({
      name: mod.name,
      description: mod.description,
      requirements: mod.requirements.map(req => ({
        id: req.req_id,
        _uuid: req.id, // UUID pour les opérations DB
        description: req.description,
        priority: req.priority,
        test_cases: req.test_cases.map(tc => ({
          testId: tc.test_id,
          title: tc.title,
          preconditions: tc.preconditions,
          steps: tc.steps,
          testData: tc.test_data,
          expectedResult: tc.expected_result,
          type: tc.type,
          priority: tc.priority,
          id: tc.id,
          validated: tc.validated,
        })),
      })),
    }));
  }

  if (project.status === 'error') {
    response.error_message = project.error_message;
  }

  return response;
}

/**
 * Sauvegarde les résultats du Python dans MongoDB
 */
private async _savePythonResultToProject(
  projectId: string,
  result: any,
  fileHash: string | null,
): Promise<void> {
  const modules = result.content?.modules || [];

  // Mettre à jour le projet
  await this.prisma.project.update({
    where: { id: projectId },
    data: {
      document_type: result.document_type || 'unknown',
      source_hash: fileHash,
      status: 'done',
    },
  });

  // Créer les modules et requirements
  for (const mod of modules) {
    await this.prisma.requirementModule.create({
      data: {
        name: mod.name,
        description: mod.description || '',
        project_id: projectId,
        requirements: {
          create: (mod.requirements || []).map((req: any) => ({
            req_id: req.id,
            description: req.description,
            priority: req.priority || 'MEDIUM',
          })),
        },
      },
    });
  }

  this.logger.log(`✅ ${modules.length} modules sauvegardés pour ${projectId}`);
}

/**
 * Sauvegarde les résultats du cache dans MongoDB
 */
private async _saveCachedAnalysisToProject(
  projectId: string,
  cachedResult: any,
  fileHash: string,
): Promise<void> {
  const modules = cachedResult.content?.modules || [];

  await this.prisma.project.update({
    where: { id: projectId },
    data: {
      document_type: cachedResult.document_type || 'unknown',
      source_hash: fileHash,
      status: 'done',
    },
  });

  for (const mod of modules) {
    await this.prisma.requirementModule.create({
      data: {
        name: mod.name,
        description: mod.description || '',
        project_id: projectId,
        requirements: {
          create: (mod.requirements || []).map((req: any) => ({
            req_id: req.id,
            description: req.description,
            priority: req.priority || 'MEDIUM',
          })),
        },
      },
    });
  }

  this.logger.log(`✅ Analyse du cache sauvegardée pour ${projectId}`);
}

/**
 * Copie les modules d'un projet existant vers le nouveau
 */
private async _copyProjectModules(sourceProjectId: string, targetProjectId: string): Promise<void> {
  const sourceProject = await this.prisma.project.findUnique({
    where: { id: sourceProjectId },
    include: {
      modules: {
        include: {
          requirements: { include: { test_cases: true } },
        },
      },
    },
  });

  if (!sourceProject) return;

  for (const mod of sourceProject.modules) {
    await this.prisma.requirementModule.create({
      data: {
        name: mod.name,
        description: mod.description || '',
        project_id: targetProjectId,
        requirements: {
          create: mod.requirements.map(req => ({
            req_id: req.req_id,
            description: req.description,
            priority: req.priority,
          })),
        },
      },
    });
  }

  this.logger.log(`✅ Modules copiés de ${sourceProjectId} vers ${targetProjectId}`);
}
}