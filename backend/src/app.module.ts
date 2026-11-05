import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AnalyzerModule } from './analyzer/analyzer.module';
import { LlmModule } from './llm/llm.module';
import { CacheModule } from './cache/cache.module';
import { ProjectModule } from './project/project.module';
import { PrismaModule } from './prisma/prisma.module';
import { SrsModule } from './srs/srs.module';
import { DocumentsModule } from './documents/documents.module';
import { TokenizerModule } from './tokenizer/tokenizer.module';
import { MailModule } from './mail/mail.module';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './user/user.module';
import { JiraModule } from './jira/jira.module';
import { LangfuseAdminModule } from './langfuse/langfuse.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { ConfluenceModule } from './confluence/confluence.module';
import { CoverageModule } from './coverage/coverage.module';
import { NotificationsModule } from './notifications/notifications.module';
import { CommentsModule } from './comments/comments.module';
import { WorkflowModule } from './workflow/workflow.module';
// ChromaModule supprimé — Atlas Vector Search est géré via VectorModule (dans SrsModule + LlmModule)

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    // Tokenizer Python — spawné une fois au boot, tué proprement au shutdown
    // @Global() dans TokenizerModule → TokenizerService injectable partout sans ré-importer
    TokenizerModule,

    // Prisma — connexion MongoDB Atlas
    PrismaModule,

    // Auth — JWT + OTP email + RBAC (Admin / QA / BA)
    MailModule,
    AuthModule,
    UserModule,

    // SRS + Vector Search (Atlas) — indexation et recherche sémantique
    SrsModule,
    CacheModule,
    ProjectModule,
    AnalyzerModule,
    LlmModule,
    DocumentsModule,
    JiraModule,
    ConfluenceModule,
    LangfuseAdminModule,
    DashboardModule,
    CoverageModule,
    NotificationsModule,
    CommentsModule,
    WorkflowModule,

  ],
})
export class AppModule {}