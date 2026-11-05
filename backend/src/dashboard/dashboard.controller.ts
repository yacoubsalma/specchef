import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { DashboardService, parseDashboardDays } from './dashboard.service';

@ApiTags('dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  // ── GET /dashboard/admin ───────────────────────────────────────────────────
  @Get('admin')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Dashboard Admin : vue globale plateforme + mes projets créés' })
  @ApiQuery({ name: 'days', required: false, enum: [7, 14, 30] })
  @ApiQuery({ name: 'projectId', required: false })
  async getAdminDashboard(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days') days?: string,
    @Query('projectId') projectId?: string,
  ) {
    return { success: true, data: await this.dashboardService.getAdminDashboard(user.sub, parseDashboardDays(days), projectId) };
  }

  // ── GET /dashboard/ba ───────────────────────────────────────────────────────
  @Get('ba')
  @Roles(Role.BA)
  @ApiOperation({ summary: 'Dashboard BA : SRS (modules/exigences) + export Jira' })
  @ApiQuery({ name: 'days', required: false, enum: [7, 14, 30] })
  @ApiQuery({ name: 'projectId', required: false })
  async getBaDashboard(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days') days?: string,
    @Query('projectId') projectId?: string,
  ) {
    return { success: true, data: await this.dashboardService.getBaDashboard(user.sub, user.role === 'ADMIN', parseDashboardDays(days), projectId) };
  }

  // ── GET /dashboard/po ────────────────────────────────────────────────────
  @Get('po')
  @Roles(Role.ADMIN, Role.PO)
  @ApiOperation({ summary: 'Dashboard PO : avancement produit — campagnes, prêt-à-lancer, traçabilité Jira' })
  @ApiQuery({ name: 'days', required: false, enum: [7, 14, 30] })
  @ApiQuery({ name: 'projectId', required: false })
  async getPoDashboard(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days') days?: string,
    @Query('projectId') projectId?: string,
  ) {
    return { success: true, data: await this.dashboardService.getPoDashboard(user.sub, user.role === 'ADMIN', parseDashboardDays(days), projectId) };
  }

  // ── GET /dashboard/po/campaigns ──────────────────────────────────────────
  @Get('po/campaigns')
  @Roles(Role.ADMIN, Role.PO)
  @ApiOperation({ summary: 'Vue globale des campagnes de tests (tous projets) — PO/Admin' })
  @ApiQuery({ name: 'days', required: false, enum: [7, 14, 30] })
  @ApiQuery({ name: 'projectId', required: false })
  async getPoCampaignsOverview(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days') days?: string,
    @Query('projectId') projectId?: string,
  ) {
    return { success: true, data: await this.dashboardService.getPoCampaignsOverview(user.sub, user.role === 'ADMIN', parseDashboardDays(days), projectId) };
  }

  // ── GET /dashboard/qa ───────────────────────────────────────────────────────
  @Get('qa')
  @Roles(Role.QA)
  @ApiOperation({ summary: 'Dashboard QA : génération, validation, rejet, export Jira des TC' })
  @ApiQuery({ name: 'days', required: false, enum: [7, 14, 30] })
  @ApiQuery({ name: 'projectId', required: false })
  async getQaDashboard(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days') days?: string,
    @Query('projectId') projectId?: string,
  ) {
    return { success: true, data: await this.dashboardService.getQaDashboard(user.sub, user.role === 'ADMIN', parseDashboardDays(days), projectId) };
  }
}