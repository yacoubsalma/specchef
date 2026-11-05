import { Module } from '@nestjs/common';
import { SrsService } from './srs.service';
import { SrsController } from './srs.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { VectorModule } from '../vector/vector.module'; // ← remplace SrsChromaService
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    PrismaModule,
    VectorModule,
    AuthModule, // ← fournit SrsMongoVectorService + MongoVectorService
  ],
  providers: [SrsService],
  controllers: [SrsController],
  exports: [SrsService],
})
export class SrsModule {}
