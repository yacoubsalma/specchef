import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { VersionsService } from './versions.service';

@Module({
  imports: [PrismaModule],
  providers: [VersionsService],
  exports: [VersionsService],
})
export class VersionsModule {}