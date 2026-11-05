import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { UserService } from './user.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { RequestPasswordOtpDto } from './dto/request-password-otp.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../auth/decorators/current-user.decorator';

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  // ── GET /users/me ───────────────────────────────────────────────────────
  // Accessible à tout utilisateur connecté (pas de restriction de rôle)
  @Get('me')
  @ApiOperation({ summary: "Profil de l'utilisateur connecté" })
  getMe(@CurrentUser('sub') userId: string) {
    return this.userService.findOne(userId);
  }

  // ── POST /users/me/change-password/request-otp ─────────────────────────
  // Étape 1 : vérifie le mot de passe actuel puis envoie un code OTP par
  // email. Le code doit être fourni à PATCH /users/me/change-password.
  @Post('me/change-password/request-otp')
  @ApiOperation({ summary: 'Demander un code OTP pour confirmer le changement de mot de passe' })
  requestPasswordChangeOtp(
    @CurrentUser('sub') userId: string,
    @Body() dto: RequestPasswordOtpDto,
  ) {
    return this.userService.requestPasswordChangeOtp(userId, dto);
  }

  // ── PATCH /users/me/change-password ────────────────────────────────────
  // Étape 2 : change le mot de passe après vérification du code OTP reçu.
  @Patch('me/change-password')
  @ApiOperation({ summary: 'Changer son propre mot de passe (avec confirmation OTP)' })
  changeOwnPassword(
    @CurrentUser('sub') userId: string,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.userService.changePassword(userId, dto);
  }

  // ── POST /users/me/request-deletion ────────────────────────────────────
  // Notifie les Admins ; la suppression effective reste une action Admin.
  @Post('me/request-deletion')
  @ApiOperation({ summary: 'Demander la suppression de son compte (notifie les Admins)' })
  requestDeletion(@CurrentUser('sub') userId: string) {
    return this.userService.requestDeletion(userId);
  }

  // ── POST /users — Admin uniquement ─────────────────────────────────────
  @Post()
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Créer un compte utilisateur (Admin uniquement)' })
  create(@Body() dto: CreateUserDto) {
    return this.userService.create(dto);
  }

  // ── GET /users/directory — tout utilisateur connecté ────────────────────
  // Liste légère (id, nom, email, rôle) utilisée pour choisir des
  // collaborateurs à assigner à un projet. Doit être déclarée avant
  // GET /users/:id pour que "directory" ne soit pas interprété comme un id.
  @Get('directory')
  @ApiOperation({ summary: 'Annuaire léger des utilisateurs actifs (pour assignation de projet)' })
  findDirectory() {
    return this.userService.findDirectory();
  }

  // ── GET /users — Admin uniquement ──────────────────────────────────────
  @Get()
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Lister tous les utilisateurs (Admin uniquement)' })
  findAll() {
    return this.userService.findAll();
  }

  // ── GET /users/:id — Admin uniquement ──────────────────────────────────
  @Get(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Détail d\'un utilisateur (Admin uniquement)' })
  findOne(@Param('id') id: string) {
    return this.userService.findOne(id);
  }

  // ── PATCH /users/:id — Admin uniquement ────────────────────────────────
  @Patch(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Modifier un utilisateur — nom, rôle, statut actif (Admin uniquement)' })
  update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.userService.update(id, dto);
  }

  // ── DELETE /users/:id — Admin uniquement ───────────────────────────────
  @Delete(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Supprimer un utilisateur (Admin uniquement)' })
  remove(@Param('id') id: string, @CurrentUser() requester: AuthenticatedUser) {
    return this.userService.remove(id, requester.sub);
  }
}
