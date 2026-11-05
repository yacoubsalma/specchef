import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

export class CreateCommentDto {
  @ApiProperty({ enum: ['requirement', 'test_case'] })
  @IsIn(['requirement', 'test_case'])
  entityType: 'requirement' | 'test_case';

  @ApiProperty()
  @IsMongoId()
  entityId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  content: string;

  @ApiProperty({ type: [String], required: false, description: 'IDs des utilisateurs mentionnés (@utilisateur), résolus côté frontend' })
  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  mentionedUserIds?: string[];

  @ApiProperty({ required: false, description: 'ID du commentaire parent, pour répondre dans un fil' })
  @IsOptional()
  @IsMongoId()
  parentId?: string;

  @ApiProperty({
    required: false,
    default: false,
    description: "Coché par l'auteur : ce commentaire nécessite une résolution par les autres membres (le bouton \"Résoudre\" ne sera jamais visible par l'auteur lui-même)",
  })
  @IsOptional()
  @IsBoolean()
  requiresResolution?: boolean;
}