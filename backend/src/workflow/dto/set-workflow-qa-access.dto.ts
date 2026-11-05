import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString } from 'class-validator';

export class SetWorkflowQaAccessDto {
  @ApiProperty({ type: [String], description: "IDs des QA autorisés à exécuter ce workflow (remplace la liste existante — vide = aucun QA ne peut l'exécuter)" })
  @IsArray()
  @IsString({ each: true })
  userIds: string[];
}