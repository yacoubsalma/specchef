import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional } from 'class-validator';

export class ResendOtpDto {
  @ApiProperty({ example: 'user@analyzer.local' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'verify', enum: ['verify', 'reset', 'change-password'], required: false })
  @IsOptional()
  @IsIn(['verify', 'reset', 'change-password'])
  type?: 'verify' | 'reset' | 'change-password';
}
