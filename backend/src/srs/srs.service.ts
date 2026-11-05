import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SrsMongoVectorService } from '../vector/srs-mongo-vector.service';

@Injectable()
export class SrsService {
  private readonly logger = new Logger(SrsService.name);

  // Cache en mémoire du contexte SRS par (projectId + query).
  // Évite de refaire la même recherche Atlas entre appels generateSingleTestCase successifs.
  // La clé inclut les 120 premiers caractères de la query pour couvrir les variantes.
  // Le cache est invalidé lors d'un nouvel upload SRS (clearProjectSrs).
  private readonly _srsContextCache = new Map<string, { chunks: any[]; source: string | null }>();

  constructor(
    private prisma: PrismaService,
    private srsVector: SrsMongoVectorService,
  ) {}

  /**
   * Uploader et indexer un document SRS dans MongoDB Atlas Vector Search
   */
  async uploadSrs(
    projectId: string,
    filename: string,
    content: string,
  ): Promise<{ id: string; filename: string; chunksCount: number; message: string }> {
    this.logger.log(`📥 [SRS UPLOAD] START — Project: ${projectId}, File: ${filename}`);

    try {
      // Valider que le projet existe
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
      });
      if (!project) throw new Error(`Project ${projectId} not found`);

      // Supprimer l'ancien SrsDocument + ses chunks (cascade Prisma)
      await this.prisma.srsDocument.deleteMany({
        where: { project_id: projectId },
      });

      // Créer le nouveau SrsDocument d'abord (pour avoir l'ID)
      const srsDoc = await this.prisma.srsDocument.create({
        data: {
          project_id: projectId,
          filename,
          content,
          chunks_count: 0, // sera mis à jour après indexation
        },
      });

      // Indexer les chunks dans MongoDB Atlas Vector Search
      // Les chunks sont créés directement dans la collection srs_chunks
      const { chunksCount } = await this.srsVector.indexSrsDocument(
        srsDoc.id,
        projectId,
        filename,
        content,
      );

      // Mettre à jour le nombre de chunks
      await this.prisma.srsDocument.update({
        where: { id: srsDoc.id },
        data: { chunks_count: chunksCount },
      });

      this.logger.log(`✅ [SRS UPLOAD] SUCCESS — ${chunksCount} chunks indexés dans MongoDB`);
      return {
        id: srsDoc.id,
        filename: srsDoc.filename,
        chunksCount,
        message: `SRS uploaded and indexed in ${chunksCount} chunks (MongoDB Atlas Vector Search)`,
      };
    } catch (err: any) {
      this.logger.error(`❌ [SRS UPLOAD] FAILED — ${err.message}`);
      throw err;
    }
  }

  /**
   * Récupérer le document SRS d'un projet
   */
  async getSrsDocument(projectId: string) {
    const srsDoc = await this.prisma.srsDocument.findFirst({
      where: { project_id: projectId },
      orderBy: { created_at: 'desc' },
    });
    return srsDoc;
  }

  /**
   * Rechercher les contextes SRS pertinents via Atlas Vector Search.
   * Les résultats sont mis en cache en mémoire pour éviter des appels Atlas
   * redondants entre appels generateSingleTestCase successifs sur le même requirement.
   */
  async getSrsContext(projectId: string, question: string, nResults: number = 2) {
    this.logger.log(`🔍 [SRS CONTEXT] Fetching context for: "${question}"`);

    const cacheKey = `${projectId}:${nResults}:${question.slice(0, 120)}`;
    const cached = this._srsContextCache.get(cacheKey);
    if (cached) {
      this.logger.log(`🎯 [SRS CONTEXT] Cache hit — skipping Atlas search`);
      return cached;
    }

    const srsDoc = await this.getSrsDocument(projectId);
    if (!srsDoc) {
      this.logger.warn(`⚠️ No SRS document found for project ${projectId}`);
      return { chunks: [], source: null };
    }

    const searchResult = await this.srsVector.searchSrsContext(projectId, question, nResults);
    const result = {
      chunks: searchResult.chunks,
      source: srsDoc.filename,
    };

    this._srsContextCache.set(cacheKey, result);
    return result;
  }

  /**
   * Effacer tous les chunks SRS d'un projet (supprime chunks + document).
   * Invalide aussi le cache mémoire pour ce projet.
   */
  async clearProjectSrs(projectId: string): Promise<void> {
    // La suppression du SrsDocument cascade sur les SrsChunks (schema Prisma)
    await this.prisma.srsDocument.deleteMany({
      where: { project_id: projectId },
    });
    // Invalider le cache SRS pour ce projet
    for (const key of this._srsContextCache.keys()) {
      if (key.startsWith(`${projectId}:`)) {
        this._srsContextCache.delete(key);
      }
    }
    this.logger.log(`🗑️ [SRS CLEAR] Documents et chunks supprimés pour projet ${projectId}`);
  }
}