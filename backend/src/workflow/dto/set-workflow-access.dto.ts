import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString } from 'class-validator';

export class SetWorkflowAccessDto {
  @ApiProperty({ type: [String], description: "IDs des BA autorisés à voir/modifier/valider ce workflow (remplace la liste existante)" })
  @IsArray()
  @IsString({ each: true })
  userIds: string[];
}