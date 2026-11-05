import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class RequestPasswordOtpDto {
  @ApiProperty({ example: 'CurrentPass123!' })
  @IsString()
  currentPassword: string;
}
