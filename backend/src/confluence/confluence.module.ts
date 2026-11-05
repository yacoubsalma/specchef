import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ConfluenceController } from './confluence.controller';
import { ConfluenceService } from './confluence.service';

@Module({
  imports: [PrismaModule, AuthModule, NotificationsModule],
  controllers: [ConfluenceController],
  providers: [ConfluenceService],
  exports: [ConfluenceService],
})
export class ConfluenceModule {}
