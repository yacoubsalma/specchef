import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';

export class UpdateWorkflowDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  // ── Autosave du canvas ──────────────────────────────────────────────────
  // Envoyés en bloc par le frontend à chaque modification significative du
  // graphe (ajout/déplacement de nœud, nouvelle arête, édition de variable) —
  // même logique d'autosave que ModuleReqEditor / pending_test_cases.
  @ApiProperty({ required: false, type: [Object], description: 'WorkflowNode[] complet' })
  @IsOptional()
  @IsArray()
  nodes?: any[];

  @ApiProperty({ required: false, type: [Object], description: 'WorkflowEdge[] complet' })
  @IsOptional()
  @IsArray()
  edges?: any[];

  @ApiProperty({ required: false, type: [Object], description: 'WorkflowVariable[] complet' })
  @IsOptional()
  @IsArray()
  variables?: any[];
}
