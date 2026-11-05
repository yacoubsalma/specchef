import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ProjectService } from './project.service';
import { ExportService } from './export.service';
import { ProjectController } from './project.controller';
import { LlmModule } from '../llm/llm.module';
import { CacheModule } from '../cache/cache.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SrsModule } from '../srs/srs.module';
import { VectorModule } from '../vector/vector.module';
import { EmbeddingModule } from '../embedding/embedding.module';
import { LangfuseService } from '../shared/langfuse.service';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { VersionsModule } from '../versions/versions.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    SrsModule,
    forwardRef(() => LlmModule),
    CacheModule,
    VectorModule,
    EmbeddingModule,      // Pour EmbeddingService.warmUpEmbeddingModel() dans ProjectService
    AuthModule,
    NotificationsModule,  // NotificationsGateway — diffusion temps réel (rooms project:<id>)
    VersionsModule,       // Historique/rollback des modules, exigences et cas de test
  ],
  providers: [ProjectService, ExportService, LangfuseService],
  controllers: [ProjectController],
  exports: [ProjectService],
})
export class ProjectModule {}