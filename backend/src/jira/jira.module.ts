import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { JiraController } from './jira.controller';
import { JiraService } from './jira.service';

@Module({
  imports: [PrismaModule, AuthModule, NotificationsModule],
  controllers: [JiraController],
  providers: [JiraService],
  exports: [JiraService],
})
export class JiraModule {}
