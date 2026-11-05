import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { generateOtp } from '../shared/auth-utils';

@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
  ) {}

  /**
   * Génère un nouvel OTP pour `email`, le persiste (15 min de validité)
   * et l'envoie par email.
   */
  async generateAndSendOtp(
    email: string,
    purpose: 'verify' | 'reset' | 'change-password',
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new NotFoundException('Utilisateur introuvable');

    const otp = generateOtp(6);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await this.prisma.user.update({
      where: { email },
      data: { otpCode: otp, otpCodeExpiresAt: expiresAt },
    });

    await this.mailService.sendOtpEmail(email, otp, purpose);
  }
}
