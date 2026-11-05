import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { LangfuseAdminService, OverviewPeriod } from './langfuse-admin.service';

const VALID_PERIODS: OverviewPeriod[] = ['today', 'week', 'month'];

/**
 * Dashboard Langfuse intégré — Admin uniquement.
 *
 * Toutes les routes sont protégées par @Roles(Role.ADMIN) : un utilisateur
 * QA/BA authentifié reçoit un 403, pas seulement un masquage côté UI.
 * Les credentials Langfuse (secret key) restent côté serveur ; le frontend
 * ne reçoit que les données déjà récupérées par LangfuseAdminService.
 */
@ApiTags('admin-langfuse')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin/langfuse')
export class LangfuseAdminController {
  constructor(private readonly langfuseAdmin: LangfuseAdminService) {}

  @Get('dashboard-url')
  @ApiOperation({ summary: "URL du dashboard Langfuse (pour le lien 'Ouvrir dans Langfuse')" })
  getDashboardUrl() {
    return this.langfuseAdmin.getDashboardUrl();
  }

  @Get('overview')
  @ApiOperation({ summary: "KPIs agrégés (coût, latence, volume) sur une vraie fenêtre calendaire ('today' | 'week' | 'month')" })
  getOverview(@Query('period') period?: string) {
    const resolved = VALID_PERIODS.includes(period as OverviewPeriod) ? (period as OverviewPeriod) : 'week';
    return this.langfuseAdmin.getOverview(resolved);
  }

  @Get('traces')
  @ApiOperation({ summary: 'Liste paginée des traces Langfuse' })
  listTraces(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('userId') userId?: string,
    @Query('name') name?: string,
    @Query('sessionId') sessionId?: string,
    @Query('tags') tags?: string,
    @Query('fromTimestamp') fromTimestamp?: string,
    @Query('toTimestamp') toTimestamp?: string,
    @Query('orderBy') orderBy?: string,
  ) {
    return this.langfuseAdmin.listTracesWithTokens({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      userId,
      name,
      sessionId,
      tags,
      fromTimestamp,
      toTimestamp,
      orderBy,
    });
  }

  @Get('traces/:id')
  @ApiOperation({ summary: "Détail complet d'une trace (observations, scores, I/O)" })
  getTrace(@Param('id') id: string) {
    return this.langfuseAdmin.getTrace(id);
  }

  @Get('scores')
  @ApiOperation({ summary: 'Liste paginée des scores (qualité TC, feedback...)' })
  listScores(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('traceId') traceId?: string,
    @Query('userId') userId?: string,
  ) {
    return this.langfuseAdmin.listScores({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      traceId,
      userId,
    });
  }
}