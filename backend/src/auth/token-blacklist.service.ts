import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TokenBlacklistService {
  constructor(private readonly prisma: PrismaService) {}

  async blacklistToken(token: string, userId: string, expiresAt: Date): Promise<void> {
    await this.prisma.blacklistedToken.create({
      data: { token, userId, expiresAt },
    });
  }

  async isTokenBlacklisted(token: string): Promise<boolean> {
    const found = await this.prisma.blacklistedToken.findFirst({
      where: { token, expiresAt: { gt: new Date() } },
    });
    return !!found;
  }

  async cleanupExpiredTokens(): Promise<void> {
    await this.prisma.blacklistedToken.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
  }
}
