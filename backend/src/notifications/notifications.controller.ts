import { Controller, Get, Patch, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { NotificationsService } from './notifications.service';

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  // ── GET /notifications ─────────────────────────────────────────────────
  @Get()
  @ApiOperation({ summary: 'Liste paginée des notifications de l’utilisateur courant' })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('unreadOnly') unreadOnly?: string,
  ) {
    const data = await this.notificationsService.list(user.sub, {
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
      unreadOnly: unreadOnly === 'true',
    });
    return { success: true, data };
  }

  // ── GET /notifications/unread-count ────────────────────────────────────
  @Get('unread-count')
  @ApiOperation({ summary: 'Nombre de notifications non lues' })
  async unreadCount(@CurrentUser() user: AuthenticatedUser) {
    const count = await this.notificationsService.unreadCount(user.sub);
    return { success: true, count };
  }

  // ── GET /notifications/ws-ticket ───────────────────────────────────────
  // Ticket court (60s) dédié à l'authentification de la connexion WebSocket.
  // On évite d'exposer le token d'accès principal (plus longue durée de vie)
  // sur le transport WebSocket.
  @Get('ws-ticket')
  @ApiOperation({ summary: 'Génère un ticket court pour authentifier la connexion WebSocket' })
  async getWsTicket(@CurrentUser() user: AuthenticatedUser) {
    const secret = this.configService.get<string>('JWT_SECRET', 'secret');
    const ticket = await this.jwtService.signAsync(
      { sub: user.sub, name: user.name, email: user.email, purpose: 'ws-ticket' },
      { secret, expiresIn: '60s' },
    );
    return { success: true, ticket };
  }

  // ── PATCH /notifications/:id/read ──────────────────────────────────────
  @Patch(':id/read')
  @ApiOperation({ summary: 'Marquer une notification comme lue' })
  async markRead(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    const notif = await this.notificationsService.markRead(user.sub, id, user.name);
    return { success: true, data: notif };
  }

  // ── PATCH /notifications/read-all ──────────────────────────────────────
  @Patch('read-all')
  @ApiOperation({ summary: 'Marquer toutes les notifications comme lues' })
  async markAllRead(@CurrentUser() user: AuthenticatedUser) {
    const res = await this.notificationsService.markAllRead(user.sub, user.name);
    return { success: true, ...res };
  }
}
