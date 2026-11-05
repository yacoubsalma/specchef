import { Module } from '@nestjs/common';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { LlmModule } from '../llm/llm.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SrsModule } from '../srs/srs.module';
import { AuthModule } from '../auth/auth.module';
import { ConfluenceModule } from '../confluence/confluence.module';
import { ProjectModule } from '../project/project.module';

@Module({
  imports: [
    LlmModule,
    PrismaModule,
     SrsModule, 
     AuthModule,
     ConfluenceModule,
     ProjectModule,
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService],
})
export class DocumentsModule {}