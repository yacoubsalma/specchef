import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LlmService } from './llm.service';
import { LlmController } from './llm.controller';
import { AnalyzerModule } from '../analyzer/analyzer.module';
import { CacheModule } from '../cache/cache.module';
import { ProjectModule } from '../project/project.module';
import { VectorModule } from '../vector/vector.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SrsModule } from '../srs/srs.module';
import { EmbeddingModule } from '../embedding/embedding.module';
import { EmbeddingService } from '../embedding/embedding.service';
import { SemanticDeduplicator } from '../shared/semantic-dedup.service';
import { LangfuseService } from '../shared/langfuse.service';
import { AuthModule } from '../auth/auth.module';
import { JobStoreService } from './job-store.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    ConfigModule,
    CacheModule,
    PrismaModule,
    EmbeddingModule,
    VectorModule,
    SrsModule,
    AuthModule,
    NotificationsModule, // NotificationsGateway — diffusion temps réel de la génération
    forwardRef(() => AnalyzerModule),
    forwardRef(() => ProjectModule),
  ],
  controllers: [LlmController],
  providers: [
    LlmService,
    SemanticDeduplicator,
    EmbeddingService,
    LangfuseService,
    JobStoreService,
  ],
  exports: [LlmService],
})
export class LlmModule {}