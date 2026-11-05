import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { JiraService } from './jira.service';
import { ConnectJiraDto } from './dto/connect-jira.dto';
import { ExportToJiraDto } from './dto/export-to-jira.dto';
import { CreateEpicDto } from './dto/create-epic.dto';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { NotificationsService } from '../notifications/notifications.service';

@ApiTags('jira')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('jira')
export class JiraController {
  constructor(
    private readonly jiraService: JiraService,
    private readonly realtimeGateway: NotificationsGateway,
    private readonly notificationsService: NotificationsService,
  ) {}

  // ── Credentials (compte Jira personnel) ──────────────────────────────────

  @Post('credentials')
  @ApiOperation({ summary: "Connecte (ou reconnecte) le compte Jira de l'utilisateur courant" })
  async connect(@Body() dto: ConnectJiraDto, @CurrentUser('sub') userId: string) {
    const status = await this.jiraService.connect(userId, dto);
    return { success: true, data: status };
  }

  @Get('credentials')
  @ApiOperation({ summary: 'Statut de la connexion Jira de l\'utilisateur courant' })
  async getStatus(@CurrentUser('sub') userId: string) {
    const status = await this.jiraService.getStatus(userId);
    return { success: true, data: status };
  }

  @Delete('credentials')
  @ApiOperation({ summary: 'Déconnecte le compte Jira de l\'utilisateur courant' })
  async disconnect(@CurrentUser('sub') userId: string) {
    return this.jiraService.disconnect(userId);
  }

  // ── Supervision Admin des accès Atlassian ──────────────────────────────────

  @Get('admin/connections')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: "Liste le statut de connexion Atlassian de tous les utilisateurs — ADMIN uniquement" })
  async listAllConnections() {
    const connections = await this.jiraService.listAllConnectionsForAdmin();
    return { success: true, data: connections };
  }

  @Delete('admin/connections/:userId')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: "Révoque l'accès Atlassian d'un utilisateur donné — ADMIN uniquement" })
  async revokeConnection(@Param('userId') userId: string) {
    const result = await this.jiraService.adminRevokeConnection(userId);
    return { success: result.success, data: result };
  }

  // ── Projets Jira accessibles ──────────────────────────────────────────────

  @Get('projects')
  @ApiOperation({ summary: "Liste les projets Jira accessibles au compte connecté" })
  async listProjects(@CurrentUser('sub') userId: string) {
    const projects = await this.jiraService.listProjects(userId);
    return { success: true, data: projects };
  }

  @Get('projects/:key/issue-types')
  @ApiOperation({ summary: "Liste les types de ticket disponibles pour un projet Jira donné" })
  async listIssueTypes(@Param('key') projectKey: string, @CurrentUser('sub') userId: string) {
    const issueTypes = await this.jiraService.listIssueTypes(userId, projectKey);
    return { success: true, data: issueTypes };
  }

  @Get('projects/:key/epics')
  @ApiOperation({ summary: "Liste les epics du projet Jira donné, à choisir avant le type de ticket" })
  async listEpics(@Param('key') projectKey: string, @CurrentUser('sub') userId: string) {
    const epics = await this.jiraService.listEpics(userId, projectKey);
    return { success: true, data: epics };
  }

  @Post('projects/:key/epics')
  @Roles(Role.BA, Role.PO, Role.QA)
  @ApiOperation({ summary: "Crée un nouvel epic dans le projet Jira donné — BA/QA uniquement" })
  async createEpic(
    @Param('key') projectKey: string,
    @Body() dto: CreateEpicDto,
    @CurrentUser('sub') userId: string,
  ) {
    const epic = await this.jiraService.createEpic(userId, projectKey, dto.summary);
    return { success: true, data: epic };
  }

  // ── Export ────────────────────────────────────────────────────────────────

  @Get('requirements/:id/hierarchy')
  @ApiOperation({ summary: "Statut de la hiérarchie Jira (Epic → Story) déjà établie pour une exigence" })
  async getRequirementHierarchy(@Param('id') requirementId: string) {
    const hierarchy = await this.jiraService.getRequirementHierarchy(requirementId);
    return { success: true, data: hierarchy };
  }

  @Post('test-cases/:id/export')
  @Roles(Role.BA, Role.PO, Role.QA)
  @ApiOperation({ summary: "Exporte un cas de test vers Jira (crée ou met à jour l'issue) — BA/QA uniquement" })
  async exportTestCase(
    @Param('id') testCaseId: string,
    @Body() dto: ExportToJiraDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const userId = user.sub;
    const actorName = user.name || user.email;
    const lockKey = `jira-export:testcase:${testCaseId}`;
    const lockedBy = this.realtimeGateway.tryLockAction(lockKey, userId, actorName);
    if (lockedBy) {
      throw new ConflictException(`${lockedBy.actorName} exporte déjà ce cas de test vers Jira — réessayez dans un instant.`);
    }
    try {
      const result = await this.jiraService.exportTestCase(userId, testCaseId, dto.projectKey, dto.issueTypeId, dto.epicKey, undefined, dto.storySummary);
      if (result.success) {
        const projectId = await this.jiraService.getProjectIdForTestCase(testCaseId);
        if (projectId) {
          this.notificationsService
            .notifyProjectActivity({
              projectId, actorId: userId, actorName, type: 'export_activity',
              message: `${actorName} a exporté un cas de test vers Jira.`,
              entityType: 'testcase', entityId: testCaseId,
            })
            .catch(() => {});
        }
      }
      return { success: result.success, data: result };
    } finally {
      this.realtimeGateway.unlockAction(lockKey, userId);
    }
  }

  @Post('requirements/:id/export-all')
  @Roles(Role.BA, Role.PO, Role.QA)
  @ApiOperation({ summary: "Exporte tous les cas de test sauvegardés d'une exigence vers Jira — BA/QA uniquement" })
  async exportAllForRequirement(
    @Param('id') requirementId: string,
    @Body() dto: ExportToJiraDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const userId = user.sub;
    const actorName = user.name || user.email;
    const lockKey = `jira-export:requirement:${requirementId}`;
    const lockedBy = this.realtimeGateway.tryLockAction(lockKey, userId, actorName);
    if (lockedBy) {
      throw new ConflictException(`${lockedBy.actorName} exporte déjà les cas de test de cette exigence vers Jira — réessayez dans un instant.`);
    }
    try {
      const result = await this.jiraService.exportAllForRequirement(userId, requirementId, dto.projectKey, dto.issueTypeId, dto.epicKey, dto.storySummary);
      if (result.success && result.success > 0) {
        const projectId = await this.jiraService.getProjectIdForRequirement(requirementId);
        if (projectId) {
          this.notificationsService
            .notifyProjectActivity({
              projectId, actorId: userId, actorName, type: 'export_activity',
              message: `${actorName} a exporté ${result.success} cas de test vers Jira.`,
              entityType: 'requirement', entityId: requirementId,
            })
            .catch(() => {});
        }
      }
      return { success: result.failed === 0, data: result };
    } finally {
      this.realtimeGateway.unlockAction(lockKey, userId);
    }
  }
}