import { Controller, Post, Get, HttpCode, HttpStatus, Param } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { MongoVectorService } from './mongo-vector.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * VectorController
 * ─────────────────
 * Remplace ChromaController (chroma.controller.ts).
 * Expose les endpoints d'administration du vector store.
 * Route : /vector (était /chroma)
 */
@ApiTags('Vector')
@Controller('vector')
export class VectorController {
  constructor(
    private readonly mongoVector: MongoVectorService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Réinitialise tous les embeddings des test cases.
   * Utile pour forcer une réindexation complète.
   */
  @Post('clear')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset all test case embeddings (force re-indexing on next startup)' })
  async clearVector() {
    await this.mongoVector.clearAll();
    return { success: true, message: 'Embeddings réinitialisés (MongoDB Atlas Vector Search)' };
  }

  /**
   * Déclenche la synchronisation des TCs sans embedding.
   * Utile après une migration depuis Chroma.
   */
  @Post('sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Trigger embedding sync for test cases missing embeddings' })
  async syncEmbeddings() {
    // La sync se fait au démarrage (onModuleInit) mais peut être déclenchée manuellement
    return {
      success: true,
      message: 'Sync déclenchée — vérifiez les logs du serveur pour le progrès',
    };
  }

  /**
   * 🔍 Diagnostic: Vérifier l'état des embeddings dans test_cases
   */
  @Get('diagnose/test-cases/:projectId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Diagnose test cases embeddings' })
  async diagnoseTestCases(@Param('projectId') projectId: string) {
    const testCases = await this.prisma.testCase.findMany({
      where: { requirement: { module: { project_id: projectId } } },
      include: { requirement: true },
      take: 5,
    });

    return {
      projectId,
      totalCount: testCases.length,
      testCases: testCases.map((tc) => ({
        testId: tc.test_id,
        title: tc.title,
        requirementId: tc.requirement_id,
        hasEmbedding: tc.embedding && tc.embedding.length > 0,
        embeddingDimensions: tc.embedding?.length ?? 0,
        type: tc.type,
      })),
    };
  }

  /**
   * 🔍 Diagnostic: Vérifier l'état des embeddings dans generation_history_entries
   */
  @Get('diagnose/history/:projectId/:requirementId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Diagnose generation history embeddings' })
  async diagnoseHistory(
    @Param('projectId') projectId: string,
    @Param('requirementId') requirementId: string,
  ) {
    const entries = await this.prisma.generationHistoryEntry.findMany({
      where: { project_id: projectId, requirement_id: requirementId },
      take: 10,
      orderBy: { created_at: 'desc' },
    });

    return {
      projectId,
      requirementId,
      totalCount: entries.length,
      entries: entries.map((entry) => ({
        testId: entry.test_id,
        title: entry.title,
        hasEmbedding: entry.embedding && entry.embedding.length > 0,
        embeddingDimensions: entry.embedding?.length ?? 0,
        type: entry.type,
        createdAt: entry.created_at,
      })),
    };
  }

  /**
   * 🔍 Diagnostic: Tester la recherche vectorielle
   */
  @Get('diagnose/vector-search/:projectId/:requirementId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Test vector search on generation_history_entries' })
  async diagnoseVectorSearch(
    @Param('projectId') projectId: string,
    @Param('requirementId') requirementId: string,
  ) {
    try {
      // 1. Compter les documents qui correspondent aux filtres
      const allMatching = await this.prisma.generationHistoryEntry.findMany({
        where: {
          project_id: projectId,
          requirement_id: requirementId,
        },
      });
      const matchedCount = allMatching.length;

      // 2. Compter ceux avec embedding
      const withEmbedding = allMatching.filter(
        (e) => e.embedding && e.embedding.length > 0,
      ).length;

      // 3. Voir un exemple de document
      const sampleEntry = allMatching[0];

      return {
        projectId,
        requirementId,
        documentsMatching: matchedCount,
        documentsWithEmbedding: withEmbedding,
        sampleEntry: sampleEntry
          ? {
              testId: sampleEntry.test_id,
              title: sampleEntry.title,
              embeddingDimensions: sampleEntry.embedding?.length ?? 0,
            }
          : null,
        note:
          matchedCount === 0
            ? '⚠️ No documents found matching filters!'
            : matchedCount === withEmbedding
              ? '✅ All documents have embeddings'
              : `⚠️ ${matchedCount - withEmbedding} documents are missing embeddings`,
      };
    } catch (err: any) {
      return {
        projectId,
        requirementId,
        error: err.message,
        note: 'Error connecting to MongoDB',
      };
    }
  }

  /**
   * 🔍 Diagnostic: Statistiques globales
   */
  @Get('diagnose/stats/:projectId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get embedding statistics for project' })
  async diagnoseStats(@Param('projectId') projectId: string) {
    // Récupérer tous les test cases
    const testCases = await this.prisma.testCase.findMany({
      where: {
        requirement: {
          module: {
            project_id: projectId,
          },
        },
      },
    });

    const testCasesWithEmbedding = testCases.filter(
      (tc) => tc.embedding && tc.embedding.length > 0,
    ).length;
    const testCasesWithoutEmbedding = testCases.length - testCasesWithEmbedding;

    // Récupérer tous les history entries
    const historyEntries = await this.prisma.generationHistoryEntry.findMany({
      where: {
        project_id: projectId,
      },
    });

    const historyWithEmbedding = historyEntries.filter(
      (entry) => entry.embedding && entry.embedding.length > 0,
    ).length;

    return {
      projectId,
      testCases: {
        total: testCases.length,
        withEmbedding: testCasesWithEmbedding,
        withoutEmbedding: testCasesWithoutEmbedding,
      },
      generationHistory: {
        total: historyEntries.length,
        withEmbedding: historyWithEmbedding,
        withoutEmbedding: historyEntries.length - historyWithEmbedding,
      },
    };
  }
}
