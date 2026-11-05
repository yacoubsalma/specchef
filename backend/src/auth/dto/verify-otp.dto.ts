import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, Length } from 'class-validator';

export class VerifyOtpDto {
  @ApiProperty({ example: 'user@analyzer.local' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: '482913' })
  @IsString()
  @Length(4, 6)
  otpCode: string;

  @ApiProperty({ example: 'verify', enum: ['verify', 'reset', 'change-password'], required: false })
  @IsOptional()
  @IsIn(['verify', 'reset', 'change-password'])
  type?: 'verify' | 'reset' | 'change-password';
}
