import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Role } from '@prisma/client';

export class CreateUserDto {
  @ApiProperty({ example: 'user@analyzer.local' })
  @IsEmail({}, { message: 'Email invalide' })
  @Transform(({ value }) => value?.toLowerCase().trim())
  email: string;

  @ApiProperty({ example: 'Jane Doe' })
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  @Transform(({ value }) => value?.trim())
  name: string;

  @ApiProperty({ enum: Role, example: Role.QA })
  @IsEnum(Role, { message: 'role doit être ADMIN, QA, BA ou PO' })
  role: Role;

  @ApiProperty({
    required: false,
    description:
      'Mot de passe initial. Si omis, un mot de passe temporaire est généré et envoyé par email.',
    example: 'StrongPass123!',
  })
  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'Le mot de passe doit contenir au moins 8 caractères' })
  @MaxLength(32)
  @Matches(/((?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z])(?=.*[a-z]).*$/, {
    message: 'Mot de passe trop faible',
  })
  password?: string;
}
