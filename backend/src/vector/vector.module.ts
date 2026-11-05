import { Module } from '@nestjs/common';
import { MongoVectorService } from './mongo-vector.service';
import { SrsMongoVectorService } from './srs-mongo-vector.service';
import { VectorController } from './vector.controller';
import { EmbeddingModule } from '../embedding/embedding.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [EmbeddingModule, PrismaModule],
  providers: [MongoVectorService, SrsMongoVectorService],
  controllers: [VectorController],
  exports: [MongoVectorService, SrsMongoVectorService],
})
export class VectorModule {}