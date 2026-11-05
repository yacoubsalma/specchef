import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';
import { MatchesProperty } from '../../shared/matches-property.validator';

export class ChangePasswordDto {
  @ApiProperty({ example: 'CurrentPass123!' })
  @IsString()
  currentPassword: string;

  @ApiProperty({
    example: '482913',
    description:
      "Code OTP envoyé par email via POST /users/me/change-password/request-otp",
  })
  @IsString()
  @Length(4, 6)
  otpCode: string;

  @ApiProperty({ example: 'NewStrongPass123!' })
  @IsString()
  @MinLength(8)
  @MaxLength(32)
  @Matches(/((?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z])(?=.*[a-z]).*$/, {
    message: 'Mot de passe trop faible',
  })
  newPassword: string;

  @ApiProperty({ example: 'NewStrongPass123!' })
  @IsString()
  @MatchesProperty('newPassword', { message: 'Les mots de passe ne correspondent pas' })
  confirmPassword: string;
}
