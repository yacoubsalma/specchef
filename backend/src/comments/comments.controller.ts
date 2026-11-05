import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { CommentsService } from './comments.service';
import { CreateCommentDto } from './dto/create-comment.dto';

@ApiTags('comments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('projects/:projectId/comments')
export class CommentsController {
  constructor(private readonly commentsService: CommentsService) {}

  // ── POST /projects/:projectId/comments ─────────────────────────────────
  @Post()
  @ApiOperation({ summary: 'Ajouter un commentaire sur une exigence ou un cas de test' })
  async create(
    @Param('projectId') projectId: string,
    @Body() dto: CreateCommentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const comment = await this.commentsService.create(
      projectId,
      dto,
      { userId: user.sub, isAdmin: user.role === 'ADMIN' },
      user.name,
    );
    return { success: true, data: comment };
  }

  // ── GET /projects/:projectId/comments?entityType=&entityId= ────────────
  @Get()
  @ApiOperation({ summary: 'Lister les commentaires d’une exigence ou d’un cas de test' })
  async list(
    @Param('projectId') projectId: string,
    @Query('entityType') entityType: string,
    @Query('entityId') entityId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const comments = await this.commentsService.listForEntity(
      projectId,
      entityType,
      entityId,
      { userId: user.sub, isAdmin: user.role === 'ADMIN' },
    );
    return { success: true, data: comments };
  }

  // ── GET /projects/:projectId/comments/unread-entities ───────────────────
  @Get('unread-entities')
  @ApiOperation({ summary: 'Liste des exigences/TC ayant un commentaire non lu par l’utilisateur courant' })
  async unreadEntities(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const data = await this.commentsService.getUnreadEntities(projectId, {
      userId: user.sub,
      isAdmin: user.role === 'ADMIN',
    });
    return { success: true, data };
  }

  // ── GET /projects/:projectId/comments/:id/seen-by ───────────────────────
  @Get(':id/seen-by')
  @ApiOperation({ summary: 'Accusés de lecture ("vu") d’un commentaire — auteur du commentaire uniquement' })
  async seenBy(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const data = await this.commentsService.getSeenBy(id, {
      userId: user.sub,
      isAdmin: user.role === 'ADMIN',
    });
    return { success: true, data };
  }

  // ── POST /projects/:projectId/comments/:id/remind ───────────────────────
  @Post(':id/remind')
  @ApiOperation({ summary: 'Relancer les destinataires d’un commentaire qui ne l’ont pas encore lu — auteur uniquement' })
  async remind(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const res = await this.commentsService.remind(
      id,
      { userId: user.sub, isAdmin: user.role === 'ADMIN' },
      user.name,
    );
    return { success: true, ...res };
  }

  // ── PATCH /projects/:projectId/comments/mark-read ────────────────────────
  @Patch('mark-read')
  @ApiOperation({ summary: 'Marquer le fil de commentaires d’une exigence/TC comme lu' })
  async markRead(
    @Param('projectId') projectId: string,
    @Body() body: { entityType: string; entityId: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const res = await this.commentsService.markRead(
      projectId,
      body.entityType,
      body.entityId,
      { userId: user.sub, isAdmin: user.role === 'ADMIN' },
      user.name,
    );
    return { success: true, ...res };
  }

  // ── GET /projects/:projectId/comments/read-receipts?entityType=&entityId= ──
  @Get('read-receipts')
  @ApiOperation({ summary: 'Accusés de lecture ("vu") de tout le fil — tout membre du projet, pas seulement l’auteur' })
  async readReceipts(
    @Param('projectId') projectId: string,
    @Query('entityType') entityType: string,
    @Query('entityId') entityId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const data = await this.commentsService.getReadReceipts(projectId, entityType, entityId, {
      userId: user.sub,
      isAdmin: user.role === 'ADMIN',
    });
    return { success: true, data };
  }

  // ── PATCH /projects/:projectId/comments/:id/resolve ─────────────────────
  @Patch(':id/resolve')
  @ApiOperation({ summary: 'Marquer un commentaire comme résolu' })
  async resolve(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const comment = await this.commentsService.resolve(
      id,
      { userId: user.sub, isAdmin: user.role === 'ADMIN' },
      user.name,
    );
    return { success: true, data: comment };
  }

  // ── PATCH /projects/:projectId/comments/:id/reopen ──────────────────────
  @Patch(':id/reopen')
  @ApiOperation({ summary: 'Rouvrir un commentaire résolu' })
  async reopen(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const comment = await this.commentsService.reopen(
      id,
      { userId: user.sub, isAdmin: user.role === 'ADMIN' },
      user.name,
    );
    return { success: true, data: comment };
  }

  // ── DELETE /projects/:projectId/comments/:id ────────────────────────────
  @Delete(':id')
  @ApiOperation({ summary: 'Supprimer un commentaire (auteur ou Admin uniquement)' })
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const res = await this.commentsService.remove(id, {
      userId: user.sub,
      isAdmin: user.role === 'ADMIN',
    });
    return { success: true, ...res };
  }
}
