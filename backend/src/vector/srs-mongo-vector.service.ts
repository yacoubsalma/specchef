import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from '../embedding/embedding.service';

interface SrsSearchResult {
  chunks: {
    id: string;
    text: string;
    score: number;
  }[];
  query: string;
}

/**
 * SrsMongoVectorService
 * ──────────────────────
 * Remplace complètement SrsChromaService (srs-chroma.service.ts).
 *
 * Les chunks SRS sont stockés dans la collection MongoDB "srs_chunks"
 * avec leur embedding. La recherche utilise Atlas Vector Search.
 *
 * Prérequis Atlas :
 *  Créer l'index "srs_chunks_vector_index" sur la collection srs_chunks :
 *  { fields: [{ type: 'vector', path: 'embedding', numDimensions: 768, similarity: 'cosine' },
 *             { type: 'filter', path: 'project_id' }] }
 */
@Injectable()
export class SrsMongoVectorService {
  private readonly logger = new Logger(SrsMongoVectorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddingService: EmbeddingService,
  ) {}

  /**
   * Diviser un document SRS en chunks, générer les embeddings
   * et les stocker dans MongoDB (collection srs_chunks).
   *
   * Appelé depuis SrsService.uploadSrs() — remplace srsChroma.indexSrsDocument()
   */
  async indexSrsDocument(
    srsDocumentId: string,
    projectId: string,
    filename: string,
    content: string,
    chunkSize: number = 150,
  ): Promise<{ chunksCount: number }> {
    this.logger.log(`📥 [SRS INDEXING] START — Project: ${projectId}, File: ${filename}`);

    try {
      // 1. Découper le contenu en paragraphes
      const chunks = this.chunkedContent(content, chunkSize);
      this.logger.log(`📋 [SRS CHUNKING] ${chunks.length} chunks créés`);

      // 2. Supprimer les anciens chunks du projet (réindexation)
      await this.clearProjectSrs(projectId);

      // 3. Générer les embeddings et insérer en base
      const BATCH_SIZE = 5;
      let indexedCount = 0;

      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE);

        await Promise.all(
          batch.map(async (text, batchIdx) => {
            const chunkIndex = i + batchIdx;
            try {
              const embedding = await this.embeddingService.embed(text, 'document');

              await this.prisma.srsChunk.create({
                data: {
                  srs_document_id: srsDocumentId,
                  project_id: projectId,
                  chunk_index: chunkIndex,
                  text,
                  embedding,
                },
              });

              indexedCount++;
            } catch (err: any) {
              this.logger.warn(`⚠️ Failed to index chunk ${chunkIndex}: ${err.message}`);
            }
          }),
        );

        this.logger.log(
          `🔄 [SRS INDEXING] ${Math.min(i + BATCH_SIZE, chunks.length)}/${chunks.length} chunks`,
        );
      }

      this.logger.log(`✅ [SRS INDEXING] SUCCESS — ${indexedCount} chunks indexés`);
      return { chunksCount: indexedCount };
    } catch (err: any) {
      this.logger.error(`❌ [SRS INDEXING] FAILED — ${err.message}`);
      throw err;
    }
  }

  /**
   * Rechercher les chunks SRS les plus pertinents pour une question.
   * Utilise Atlas Vector Search ($vectorSearch aggregation).
   *
   * Appelé depuis SrsService.getSrsContext() — remplace srsChroma.searchSrsContext()
   */
  async searchSrsContext(
    projectId: string,
    query: string,
    topK: number = 8,
  ): Promise<SrsSearchResult> {
    this.logger.log(`🔍 [SRS SEARCH] Project: ${projectId}, Query: "${query}", TopK: ${topK}`);

    try {
      // Générer l'embedding de la question
      const queryVector = await this.embeddingService.embed(query, 'query');

      // Atlas Vector Search via aggregateRaw
      const results = await (this.prisma.srsChunk as any).aggregateRaw({
        pipeline: [
          {
            $vectorSearch: {
              index: 'srs_chunks_vector_index',
              path: 'embedding',
              queryVector,
              numCandidates: topK * 5, // Chercher plus de candidats pour meilleure précision
              limit: topK,
              filter: { project_id: projectId },
            },
          },
          {
            $project: {
              _id: 1,
              text: 1,
              chunk_index: 1,
              score: { $meta: 'vectorSearchScore' },
            },
          },
        ],
      });

      if (!results || results.length === 0) {
        this.logger.log('⚠️ [SRS SEARCH] Aucun chunk trouvé');
        return { chunks: [], query };
      }

      const chunks = results.map((r: any) => ({
        id: r._id?.$oid || r._id,
        text: r.text,
        score: r.score ?? 0,
      }));

      this.logger.log(`✅ [SRS SEARCH] ${chunks.length} chunks pertinents trouvés`);
      chunks.forEach((c, i) => {
        this.logger.log(`  📌 Chunk ${i + 1}: Score=${c.score.toFixed(3)}`);
      });

      return { chunks, query };
    } catch (err: any) {
      this.logger.error(`❌ [SRS SEARCH] FAILED — ${err.message}`);
      throw err;
    }
  }

  /**
   * Supprimer tous les chunks SRS d'un projet (avant réindexation).
   * Appelé depuis SrsService — remplace srsChroma.clearProjectSrs()
   */
  async clearProjectSrs(projectId: string): Promise<void> {
    this.logger.log(`🗑️ [SRS CLEAR] Suppression des chunks SRS pour projet ${projectId}`);
    try {
      const deleted = await this.prisma.srsChunk.deleteMany({
        where: { project_id: projectId },
      });
      this.logger.log(`✅ [SRS CLEAR] ${deleted.count} chunks supprimés`);
    } catch (err: any) {
      this.logger.warn(`⚠️ [SRS CLEAR] Failed: ${err.message}`);
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // PRIVATE HELPERS
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Extraire le plan structurel du document SRS par détection de titres (regex).
   * Reprend la logique de LlmService.extractStructuralPlan()
   * Les titres détectés marquent le début des sections, le contenu entre deux titres forme una section.
   */
  private extractSrsStructure(
    content: string,
  ): Array<{ name: string; content: string }> {
    const lines = content.split('\n');
    const headings: Array<{ name: string; lineIndex: number; level: number }> = [];

    // Patterns de titres (du plus précis au plus général)
    // Level : 1 = top-level, 2 = section, 3 = sous-section, 4 = sous-sous-section
    const patterns: Array<{ re: RegExp; level: number; nameGroup: number }> = [
      { re: /^(#{1,4})\s+(.+)$/, level: 1, nameGroup: 2 },                                         // ## Markdown
      { re: /^(\d+\.\d+\.\d+\.\d+)\s*([A-Z].{2,70})$/, level: 4, nameGroup: 2 },                  // 1.2.3.4Title
      { re: /^(\d+\.\d+\.\d+)\s*([A-Z].{2,70})$/, level: 3, nameGroup: 2 },                        // 1.2.3Title
      { re: /^(\d+\.\d+)\s*([A-Z].{2,70})$/, level: 2, nameGroup: 2 },                             // 1.2Title
      { re: /^(\d+\.)\s*([A-Z].{2,70})$/, level: 1, nameGroup: 2 },                                // 1.Title
      { re: /^(\d+)\s{1,3}([A-Z][^a-z]{0,3}[^\n]{2,70})$/, level: 1, nameGroup: 2 },              // 1 Title
      { re: /^(\d+)([A-Z][a-z].{3,70})$/, level: 1, nameGroup: 2 },                                // 3System Features
    ];

    // Détection des titres
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.length < 4 || line.length > 100) continue;

      for (const { re, level, nameGroup } of patterns) {
        const m = line.match(re);
        if (m) {
          const name = m[nameGroup].trim();
          // Rejeter si : trop court, purement numérique, ou ressemble à une cellule de tableau
          if (
            name.length >= 3 &&
            !name.match(/^[\d\s.]+$/) &&
            !name.match(
              /^(Number|Priority|Actors|Description|Trigger|Pre|Post|Normal|Alternative|Exception)/i,
            )
          ) {
            headings.push({ name, lineIndex: i, level });
          }
          break;
        }
      }
    }

    if (headings.length < 2) return []; // Pas assez de structure

    // Construire les sections — chaque section va jusqu'au prochain heading de niveau <= au sien
    const sections: Array<{ name: string; content: string }> = [];
    for (let i = 0; i < headings.length; i++) {
      const h = headings[i];
      const start = h.lineIndex;

      // Trouver la fin : prochain heading de même niveau ou niveau supérieur
      let end = lines.length;
      for (let j = i + 1; j < headings.length; j++) {
        if (headings[j].level <= h.level) {
          end = headings[j].lineIndex;
          break;
        }
        // Si on est au niveau le plus bas (sous-sous-section), s'arrêter au prochain heading
        if (h.level >= 3) {
          end = headings[j].lineIndex;
          break;
        }
      }

      const sectionContent = lines.slice(start, end).join('\n').trim();
      if (sectionContent.length >= 80) {
        sections.push({ name: h.name, content: sectionContent });
      }
    }

    return sections;
  }

  /**
   * Diviser le contenu SRS en chunks en utilisant le découpage structurel par titres.
   * Repère les sections via extractSrsStructure(), puis divise chaque section par limite de mots.
   * Les titres détectés par regex marquent le début des sections.
   */
  private chunkedContent(content: string, maxWordCount: number = 150): string[] {
    // Tentative : extraire la structure par titres
    const sections = this.extractSrsStructure(content);

    if (sections.length >= 2) {
      // Structure détectée : découper en chunks à partir des sections
      this.logger.log(
        `📍 [SRS STRUCTURE] Détecté ${sections.length} sections structurelles`,
      );

      const chunks: string[] = [];
      for (const section of sections) {
        // Diviser chaque section en sous-chunks si trop grande
        const sectionChunks = this.chunkSection(
          section.name,
          section.content,
          maxWordCount,
        );
        chunks.push(...sectionChunks);
      }
      return chunks;
    }

    // Fallback : découpage par paragraphes si pas de structure
    this.logger.log(`⚠️ [SRS CHUNKING] Pas de structure détectée — découpage par paragraphes`);
    return this.chunkByParagraphs(content, maxWordCount);
  }

  // Marqueurs de début d'exigence individuelle dans un tableau SRS
  // (FR-1.2, NFR-3, REQ-04, US-12, UC-3.1, ...) — couvre les conventions les plus courantes.
  private static readonly REQ_MARKER_RE = /(?=\b(?:FR|NFR|REQ|REQUIREMENT|US|UC)[-\s]?\d+(?:\.\d+)*\b)/g;

  /**
   * Si un paragraphe contient plusieurs exigences individuelles (FR-x.x, NFR-x, ...),
   * le découper en un fragment par exigence — INDÉPENDAMMENT du nombre de mots.
   * C'est le vrai fix au problème "6 FR mélangés dans un seul chunk" : un tableau
   * extrait d'un PDF n'a souvent aucune ligne vide entre les lignes, donc le simple
   * découpage par paragraphe ne les sépare jamais, et une limite de mots seule
   * n'aide pas si le bloc entier reste sous le seuil.
   * Retourne null si aucune structure d'exigences n'est détectée (< 3 marqueurs).
   */
  private trySplitByRequirement(paragraph: string): string[] | null {
    const rawParts = paragraph
      .split(SrsMongoVectorService.REQ_MARKER_RE)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (rawParts.length < 3) return null;

    const startsWithMarker = (s: string) => /^(FR|NFR|REQ|REQUIREMENT|US|UC)[-\s]?\d/i.test(s);

    const result: string[] = [];
    let i = 0;
    // Le texte avant le premier marqueur est un préambule/en-tête de tableau
    // ("Requirement ID Description Priority...") : on le fusionne avec la
    // première exigence plutôt que d'en faire un chunk orphelin sans contenu utile.
    if (rawParts.length > 1 && !startsWithMarker(rawParts[0])) {
      result.push(`${rawParts[0]} ${rawParts[1]}`.trim());
      i = 2;
    }
    for (; i < rawParts.length; i++) result.push(rawParts[i]);
    return result;
  }

  /**
   * Découper un paragraphe trop long en unités plus petites (pas de structure
   * d'exigences détectée) : par phrase, et en dernier recours par simple
   * découpage de mots.
   */
  private splitLongParagraph(text: string, maxWordCount: number): string[] {
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length <= maxWordCount) return [text];

    const sentenceParts = text.match(/[^.!?]+[.!?]+(\s|$)/g);
    if (sentenceParts && sentenceParts.length >= 3) {
      return this.packUnits(sentenceParts, maxWordCount, ' ');
    }

    const hardChunks: string[] = [];
    for (let i = 0; i < words.length; i += maxWordCount) {
      hardChunks.push(words.slice(i, i + maxWordCount).join(' '));
    }
    return hardChunks;
  }

  /**
   * Regroupe une liste de fragments en chunks d'au plus maxWordCount mots
   * (bin-packing glouton).
   */
  private packUnits(units: string[], maxWordCount: number, separator: string): string[] {
    const chunks: string[] = [];
    let current = '';
    let wordCount = 0;
    for (const unit of units) {
      const unitWords = unit.split(/\s+/).filter(Boolean).length;
      if (wordCount + unitWords > maxWordCount && current.trim().length > 0) {
        chunks.push(current.trim());
        current = unit;
        wordCount = unitWords;
      } else {
        current += (current ? separator : '') + unit;
        wordCount += unitWords;
      }
    }
    if (current.trim().length > 0) chunks.push(current.trim());
    return chunks;
  }

  /**
   * Transforme une liste de paragraphes en unités de chunking.
   * `standalone: true` = unité déjà correctement dimensionnée (une exigence
   * individuelle, ou un segment déjà découpé) qui ne doit PAS être fusionnée
   * avec ses voisines. `standalone: false` = paragraphe court de prose libre,
   * qui peut être regroupé avec d'autres pour éviter les micro-chunks.
   */
  private explodeParagraphs(
    paragraphs: string[],
    maxWordCount: number,
  ): { text: string; standalone: boolean }[] {
    const blocks: { text: string; standalone: boolean }[] = [];
    for (const para of paragraphs) {
      const reqUnits = this.trySplitByRequirement(para);
      if (reqUnits) {
        blocks.push(...reqUnits.map((t) => ({ text: t, standalone: true })));
        continue;
      }

      const wc = para.split(/\s+/).filter(Boolean).length;
      if (wc > maxWordCount * 1.3) {
        const subParts = this.splitLongParagraph(para, maxWordCount);
        blocks.push(...subParts.map((t) => ({ text: t, standalone: true })));
      } else {
        blocks.push({ text: para, standalone: false });
      }
    }
    return blocks;
  }

  /**
   * Diviser une section en chunks. Inclut le titre du début pour le contexte.
   * Chaque exigence individuelle détectée devient son propre chunk ; le reste
   * (prose libre) est regroupé jusqu'à maxWordCount.
   */
  private chunkSection(
    sectionTitle: string,
    sectionContent: string,
    maxWordCount: number,
  ): string[] {
    const paragraphs = sectionContent
      .split(/\n\s*\n+/)
      .filter((p) => p.trim().length > 0);
    const blocks = this.explodeParagraphs(paragraphs, maxWordCount);

    const titlePrefix = `## ${sectionTitle}\n\n`;
    const titleWords = sectionTitle.split(/\s+/).length;
    const chunks: string[] = [];

    let current = '';
    let wordCount = 0;

    const flush = () => {
      if (current.trim().length > 0) chunks.push(`${titlePrefix}${current}`.trim());
      current = '';
      wordCount = 0;
    };

    for (const block of blocks) {
      const words = block.text.split(/\s+/).filter(Boolean).length;

      if (block.standalone) {
        flush();
        chunks.push(`${titlePrefix}${block.text}`.trim());
        continue;
      }

      if (titleWords + wordCount + words > maxWordCount && current.trim().length > 0) {
        flush();
      }
      current += (current ? '\n\n' : '') + block.text;
      wordCount += words;
    }
    flush();

    return chunks;
  }

  /**
   * Découpage par paragraphes (fallback si pas de structure détectée).
   * Même logique que chunkSection mais sans titre de section à préfixer.
   */
  private chunkByParagraphs(
    content: string,
    maxWordCount: number,
  ): string[] {
    const paragraphs = content
      .split(/\n\s*\n+/)
      .filter((p) => p.trim().length > 0);
    const blocks = this.explodeParagraphs(paragraphs, maxWordCount);

    const chunks: string[] = [];
    let current = '';
    let wordCount = 0;

    const flush = () => {
      if (current.trim().length > 0) chunks.push(current.trim());
      current = '';
      wordCount = 0;
    };

    for (const block of blocks) {
      const words = block.text.split(/\s+/).filter(Boolean).length;

      if (block.standalone) {
        flush();
        chunks.push(block.text.trim());
        continue;
      }

      if (wordCount + words > maxWordCount && current.trim().length > 0) {
        flush();
      }
      current += (current ? '\n\n' : '') + block.text;
      wordCount += words;
    }
    flush();

    return chunks;
  }
}