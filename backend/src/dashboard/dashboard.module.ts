import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { CoverageModule } from '../coverage/coverage.module';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';

@Module({
  imports: [PrismaModule, AuthModule, CoverageModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}