import { Controller, ConflictException, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { ConfluenceService } from './confluence.service';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { NotificationsService } from '../notifications/notifications.service';

@ApiTags('confluence')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('confluence')
export class ConfluenceController {
  constructor(
    private readonly confluenceService: ConfluenceService,
    private readonly realtimeGateway: NotificationsGateway,
    private readonly notificationsService: NotificationsService,
  ) {}

  @Get('projects/:id/status')
  @ApiOperation({ summary: "Statut de l'espace Confluence auto-créé pour un projet" })
  async getStatus(@Param('id') projectId: string) {
    const data = await this.confluenceService.getStatus(projectId);
    return { success: true, data };
  }

  @Post('projects/:id/retry')
  @ApiOperation({ summary: "Relance la création de l'espace Confluence (en cas d'échec précédent) — bloque si déjà en cours" })
  async retry(@Param('id') projectId: string, @CurrentUser() user: AuthenticatedUser) {
    const actorName = user.name || user.email;
    const lockKey = `confluence-space:${projectId}`;
    const lockedBy = this.realtimeGateway.tryLockAction(lockKey, user.sub, actorName, 3 * 60 * 1000);
    if (lockedBy) {
      throw new ConflictException(`${lockedBy.actorName} a déjà relancé la création de l'espace Confluence pour ce projet — réessayez dans un instant.`);
    }
    // Fire-and-forget : le frontend repolle le statut ensuite. Le verrou est
    // libéré une fois la création terminée (succès ou échec), quoi qu'il arrive.
    this.confluenceService
      .retryProjectSpace(projectId)
      .then(() => {
        this.notificationsService
          .notifyProjectActivity({
            projectId, actorId: user.sub, actorName, type: 'export_activity',
            message: `${actorName} a relancé la création de l'espace Confluence du projet.`,
          })
          .catch(() => {});
      })
      .catch(() => {})
      .finally(() => this.realtimeGateway.unlockAction(lockKey, user.sub));
    return { success: true, data: { status: 'pending' } };
  }

  @Get('spaces')
  @ApiOperation({ summary: "Liste les espaces Confluence accessibles avec le compte Atlassian connecté" })
  async listSpaces(@CurrentUser() user: AuthenticatedUser) {
    const data = await this.confluenceService.listSpaces(user.sub);
    return { success: true, data };
  }

  @Get('spaces/:key/pages')
  @ApiOperation({ summary: "Recherche des pages dans un espace Confluence (pour import)" })
  async searchPages(@Param('key') key: string, @Query('query') query: string | undefined, @CurrentUser() user: AuthenticatedUser) {
    const data = await this.confluenceService.searchPagesInSpace(user.sub, key, query);
    return { success: true, data };
  }
}