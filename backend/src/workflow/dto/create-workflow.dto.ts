import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateWorkflowDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false, type: [Object], description: 'WorkflowNode[] initial (facultatif, canvas vide par défaut)' })
  @IsOptional()
  @IsArray()
  nodes?: any[];

  @ApiProperty({ required: false, type: [Object], description: 'WorkflowEdge[] initial' })
  @IsOptional()
  @IsArray()
  edges?: any[];

  @ApiProperty({ required: false, type: [Object], description: 'WorkflowVariable[] initial' })
  @IsOptional()
  @IsArray()
  variables?: any[];

  @ApiProperty({ required: false, type: [String], description: "IDs des BA autorisés à voir/modifier/valider ce workflow tant qu'il est en brouillon (en plus du créateur)" })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  assignedUserIds?: string[];
}