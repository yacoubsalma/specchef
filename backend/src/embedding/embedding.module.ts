import { Module } from '@nestjs/common';
import { EmbeddingService } from './embedding.service';
import { LangfuseService } from '../shared/langfuse.service';

@Module({
  providers: [EmbeddingService, LangfuseService],
  exports: [EmbeddingService],
})
export class EmbeddingModule {}
