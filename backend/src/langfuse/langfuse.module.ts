import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { LangfuseAdminController } from './langfuse.controller';
import { LangfuseAdminService } from './langfuse-admin.service';

@Module({
  imports: [ConfigModule, AuthModule],
  controllers: [LangfuseAdminController],
  providers: [LangfuseAdminService],
})
export class LangfuseAdminModule {}