import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Langfuse from 'langfuse';

@Injectable()
export class LangfuseService implements OnModuleDestroy {
  private readonly logger = new Logger(LangfuseService.name);
  public readonly client: Langfuse;

  constructor(private config: ConfigService) {
    const publicKey = this.config.get<string>('LANGFUSE_PUBLIC_KEY');
    const secretKey = this.config.get<string>('LANGFUSE_SECRET_KEY');
    const baseUrl   = this.config.get<string>('LANGFUSE_BASE_URL', 'https://cloud.langfuse.com');

    if (!publicKey || !secretKey) {
      this.logger.warn('⚠️  Langfuse keys missing — tracing disabled');
    }

    this.client = new Langfuse({
      publicKey:     publicKey ?? 'disabled',
      secretKey:     secretKey ?? 'disabled',
      baseUrl,
      flushAt:       10,
      flushInterval: 5000,
    });

    this.logger.log(`✅ Langfuse initialized → ${baseUrl}`);
  }

  /**
   * Envoie des scores sur une génération spécifique dans Langfuse.
   *
   * @param traceId       — id de la trace parente
   * @param observationId — id de la génération (phase-b-test-case, phase-a-test-case, etc.)
   * @param scores        — map nom → valeur (ex: { 'tc-clarity': 0.88 })
   *
   * Utilisation dans llm.service.ts :
   *   await this.langfuseService.scoreGeneration(
   *     trace.id,
   *     generation.id,
   *     { 'tc-clarity': 0.88, 'tc-coverage': 0.91, 'tc-expected-result': 0.75 },
   *   );
   */
  async scoreGeneration(
    traceId: string,
    observationId: string,
    scores: Record<string, number>,
  ): Promise<void> {
    for (const [name, value] of Object.entries(scores)) {
      try {
        await this.client.score({
          traceId,
          observationId,
          name,
          value,
        });
        this.logger.debug(`📊 [Score] ${name}=${value} → observationId=${observationId}`);
      } catch (err: any) {
        this.logger.warn(`⚠️  [Score] Failed to send score "${name}": ${err.message}`);
      }
    }
  }

  async onModuleDestroy() {
    await this.client.flushAsync();
    this.logger.log('🔁 Langfuse flushed on shutdown');
  }
}