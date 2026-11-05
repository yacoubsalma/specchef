import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { TokenBlacklistService } from './token-blacklist.service';
import { OtpService } from './otp.service';
import { comparePassword, cryptPassword } from '../shared/auth-utils';
import { LoginDto } from './dto/login.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly tokenBlacklistService: TokenBlacklistService,
    private readonly otpService: OtpService,
  ) {}

  private buildPayload(user: { id: string; email: string; name: string; role: string }) {
    return { sub: user.id, email: user.email, name: user.name, role: user.role };
  }

  async signIn(credentials: LoginDto) {
    const { email, password } = credentials;

    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedException('Identifiants invalides');

    if (!user.isActive) {
      throw new UnauthorizedException('Ce compte a été désactivé');
    }

    const isPasswordValid = await comparePassword(password, user.password);
    if (!isPasswordValid) throw new UnauthorizedException('Identifiants invalides');

    if (!user.isEmailVerified) {
      throw new UnauthorizedException(
        "Compte non vérifié — consultez votre email pour le code d'activation",
      );
    }

    const payload = this.buildPayload(user);

    const token = this.jwtService.sign(payload, { expiresIn: '15m' });
    const refreshToken = this.jwtService.sign(payload, { expiresIn: '7d' });

    return {
      token,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  }

  async refreshToken(refreshToken: string) {
    try {
      const decoded = this.jwtService.verify(refreshToken);
      const user = await this.prisma.user.findUnique({ where: { id: decoded.sub } });
      if (!user || !user.isActive) throw new UnauthorizedException('Utilisateur introuvable');

      const payload = this.buildPayload(user);
      const token = this.jwtService.sign(payload, { expiresIn: '15m' });

      return { token, refreshToken };
    } catch {
      throw new UnauthorizedException('Refresh token invalide ou expiré');
    }
  }

  async verifyOtp(dto: VerifyOtpDto) {
    const { email, otpCode, type = 'verify' } = dto;

    const user = await this.prisma.user.findFirst({ where: { email, otpCode } });
    if (!user) throw new UnauthorizedException('Code OTP invalide');

    if (user.otpCodeExpiresAt && user.otpCodeExpiresAt < new Date()) {
      throw new UnauthorizedException('Code OTP expiré — demandez-en un nouveau');
    }

    if (type === 'verify') {
      if (user.isEmailVerified) {
        throw new BadRequestException('Email déjà vérifié');
      }
      await this.prisma.user.update({
        where: { email },
        data: { otpCode: null, otpCodeExpiresAt: null, isEmailVerified: true },
      });
      return { message: 'Email vérifié avec succès. Vous pouvez maintenant vous connecter.' };
    }

    // type === 'reset' : on consomme juste l'OTP, le mot de passe sera mis à jour
    // par /auth/reset-password
    await this.prisma.user.update({
      where: { email },
      data: { otpCode: null, otpCodeExpiresAt: null },
    });
    return { message: 'OTP vérifié — vous pouvez réinitialiser votre mot de passe' };
  }

  async resendOtp(email: string, type: 'verify' | 'reset' | 'change-password' = 'verify') {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedException('Utilisateur introuvable');

    if (type === 'verify' && user.isEmailVerified) {
      throw new BadRequestException('Email déjà vérifié');
    }

    await this.otpService.generateAndSendOtp(email, type);
    return { message: 'Code envoyé par email' };
  }

  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedException('Utilisateur introuvable');

    await this.otpService.generateAndSendOtp(email, 'reset');
    return { message: 'Code de réinitialisation envoyé par email' };
  }

  async resetPassword(email: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedException('Utilisateur introuvable');

    const hashed = await cryptPassword(newPassword);
    await this.prisma.user.update({ where: { email }, data: { password: hashed } });

    return { message: 'Mot de passe réinitialisé avec succès' };
  }

  async logout(token: string, userId: string) {
    try {
      const decoded = this.jwtService.decode(token) as any;
      const expiresAt = new Date(decoded.exp * 1000);
      await this.tokenBlacklistService.blacklistToken(token, userId, expiresAt);
      return { message: 'Déconnexion réussie' };
    } catch {
      throw new UnauthorizedException('Token invalide');
    }
  }
}
