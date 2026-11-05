import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { VersionedEntityType } from '../shared/version-types';

export interface RecordVersionParams {
  projectId: string;
  entityType: VersionedEntityType;
  entityId: string;
  /** Numéro de la version que CE snapshot représente (état avant la modification en cours). */
  versionNumber: number;
  snapshot: Record<string, any>;
  changeType?: 'create' | 'update' | 'delete' | 'restore';
  changeSummary?: string | null;
  changedById?: string | null;
  changedByName?: string | null;
}

/**
 * Service générique de versioning/historique — un seul modèle Mongo
 * (`EntityVersion`) réutilisé pour Requirement, RequirementModule, TestCase
 * et TestWorkflow, plutôt qu'une table dédiée par entité.
 *
 * Chaque service métier (ProjectService, WorkflowService) reste responsable
 * de DÉCIDER quand snapshotter (avant quelle mutation, quels champs) et
 * d'appliquer lui-même la restauration (car chacun a sa propre logique
 * annexe : analyse d'impact, cache, notifications temps réel...). Ce service
 * ne fait que persister/lire — best-effort, jamais bloquant pour la mutation
 * métier elle-même (voir appels `.catch(...)` côté appelants).
 */
@Injectable()
export class VersionsService {
  private readonly logger = new Logger(VersionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async recordVersion(params: RecordVersionParams) {
    return this.prisma.entityVersion.create({
      data: {
        project_id: params.projectId,
        entity_type: params.entityType,
        entity_id: params.entityId,
        version_number: params.versionNumber,
        snapshot: params.snapshot,
        change_type: params.changeType ?? 'update',
        change_summary: params.changeSummary ?? null,
        changed_by_id: params.changedById ?? null,
        changed_by_name: params.changedByName ?? null,
      },
    });
  }

  /** Ne bloque jamais l'appelant : une historisation ratée ne doit jamais faire échouer la mutation métier. */
  async recordVersionSafe(params: RecordVersionParams): Promise<void> {
    try {
      await this.recordVersion(params);
    } catch (err: any) {
      this.logger.warn(`⚠️ Historisation échouée (${params.entityType}/${params.entityId}): ${err.message}`);
    }
  }

  async listVersions(entityType: VersionedEntityType, entityId: string) {
    return this.prisma.entityVersion.findMany({
      where: { entity_type: entityType, entity_id: entityId },
      orderBy: { version_number: 'desc' },
    });
  }

  async getVersion(entityType: VersionedEntityType, entityId: string, versionId: string) {
    const version = await this.prisma.entityVersion.findUnique({ where: { id: versionId } });
    if (!version || version.entity_type !== entityType || version.entity_id !== entityId) return null;
    return version;
  }

  /** Utilisé pour throttler le snapshotting sur les entités à autosave fréquent (ex: workflow canvas). */
  async getLastVersionAt(entityType: VersionedEntityType, entityId: string): Promise<Date | null> {
    const latest = await this.prisma.entityVersion.findFirst({
      where: { entity_type: entityType, entity_id: entityId },
      orderBy: { version_number: 'desc' },
      select: { created_at: true },
    });
    return latest?.created_at ?? null;
  }
}