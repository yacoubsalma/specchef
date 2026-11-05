import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { OtpService } from '../auth/otp.service';
import { NotificationsService } from '../notifications/notifications.service';
import { comparePassword, cryptPassword, generateTempPassword } from '../shared/auth-utils';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { RequestPasswordOtpDto } from './dto/request-password-otp.dto';

// Champs sûrs à renvoyer au client (jamais le hash du mot de passe)
const SAFE_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  isEmailVerified: true,
  isActive: true,
  created_at: true,
  updated_at: true,
  pinnedProjectIds: true,
};

@Injectable()
export class UserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly otpService: OtpService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Création d'un compte par un Admin. Pas d'inscription publique.
   * Si aucun mot de passe n'est fourni, un mot de passe temporaire est
   * généré et envoyé par email avec le code OTP d'activation.
   */
  async create(dto: CreateUserDto) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('Un utilisateur avec cet email existe déjà');

    const plainPassword = dto.password || generateTempPassword();
    const hashedPassword = await cryptPassword(plainPassword);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        name: dto.name,
        role: dto.role,
        password: hashedPassword,
        isEmailVerified: false,
      },
      select: SAFE_SELECT,
    });

    // Email de bienvenue avec le mot de passe (uniquement s'il a été généré)
    if (!dto.password) {
      await this.mailService.sendAccountCreatedEmail(
        dto.email,
        dto.name,
        plainPassword,
        dto.role,
      );
    }

    // Code OTP d'activation du compte
    await this.otpService.generateAndSendOtp(dto.email, 'verify');

    return user;
  }

  findAll() {
    return this.prisma.user.findMany({ select: SAFE_SELECT, orderBy: { created_at: 'desc' } });
  }

  // Liste légère, accessible à tout utilisateur connecté (pas seulement Admin) :
  // utilisée pour choisir des collaborateurs à assigner à un projet.
  findDirectory() {
    return this.prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, name: true, email: true, role: true },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: SAFE_SELECT });
    if (!user) throw new NotFoundException('Utilisateur introuvable');
    return user;
  }

  /**
   * Demande de suppression de compte : notifie tous les Admins actifs.
   * La suppression elle-même reste une action Admin (DELETE /users/:id).
   */
  async requestDeletion(userId: string) {
    const user = await this.findOne(userId);
    const admins = await this.prisma.user.findMany({
      where: { role: 'ADMIN', isActive: true, id: { not: userId } },
      select: { id: true },
    });
    if (admins.length === 0) {
      throw new BadRequestException('Aucun administrateur disponible pour traiter la demande');
    }
    await this.notifications.notifyMany(
      admins.map((a) => a.id),
      {
        type: 'account_deletion_request',
        message: `${user.name} (${user.email}) demande la suppression de son compte`,
        actorId: userId,
        link: '/admin/users',
      },
    );
    return { success: true };
  }

  async update(id: string, dto: UpdateUserDto) {
    try {
      return await this.prisma.user.update({
        where: { id },
        data: dto,
        select: SAFE_SELECT,
      });
    } catch {
      throw new NotFoundException('Utilisateur introuvable');
    }
  }

  async remove(id: string, requesterId: string) {
    if (id === requesterId) {
      throw new ForbiddenException('Vous ne pouvez pas supprimer votre propre compte');
    }
    try {
      await this.prisma.user.delete({ where: { id } });
      return { success: true, id };
    } catch {
      throw new NotFoundException('Utilisateur introuvable');
    }
  }

  /**
   * Étape 1 du changement de mot de passe : vérifie le mot de passe actuel
   * puis envoie un code OTP à l'adresse email de l'utilisateur connecté
   * (purpose 'change-password'). Le code doit ensuite être fourni à
   * changePassword() pour confirmer le changement.
   */
  async requestPasswordChangeOtp(userId: string, dto: RequestPasswordOtpDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Utilisateur introuvable');

    const isValid = await comparePassword(dto.currentPassword, user.password);
    if (!isValid) throw new UnauthorizedException('Mot de passe actuel incorrect');

    await this.otpService.generateAndSendOtp(user.email, 'change-password');
    return { message: 'Code de confirmation envoyé par email' };
  }

  /**
   * Étape 2 : revérifie le mot de passe actuel (au cas où il aurait changé
   * entre les deux étapes) puis valide le code OTP reçu par email avant
   * d'appliquer le nouveau mot de passe. Le code est consommé (à usage
   * unique) qu'il aboutisse ou non à un mot de passe valide.
   */
  async changePassword(userId: string, dto: ChangePasswordDto) {
    if (dto.newPassword !== dto.confirmPassword) {
      throw new BadRequestException('Les mots de passe ne correspondent pas');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Utilisateur introuvable');

    const isValid = await comparePassword(dto.currentPassword, user.password);
    if (!isValid) throw new UnauthorizedException('Mot de passe actuel incorrect');

    const isSameAsOld = await comparePassword(dto.newPassword, user.password);
    if (isSameAsOld) {
      throw new BadRequestException("Le nouveau mot de passe doit être différent de l'actuel");
    }

    if (!user.otpCode || user.otpCode !== dto.otpCode) {
      throw new UnauthorizedException('Code OTP invalide');
    }
    if (user.otpCodeExpiresAt && user.otpCodeExpiresAt < new Date()) {
      throw new UnauthorizedException('Code OTP expiré — demandez-en un nouveau');
    }

    const hashed = await cryptPassword(dto.newPassword);
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashed, otpCode: null, otpCodeExpiresAt: null },
    });

    return { message: 'Mot de passe modifié avec succès' };
  }
}