import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class SuggestNextTestCasesDto {
  @ApiProperty({ description: "ID (Mongo) du DERNIER cas de test du workflow — celui pour lequel on cherche une suite logique" })
  @IsString()
  @IsNotEmpty()
  testCaseId!: string;

  @ApiProperty({
    required: false,
    isArray: true,
    type: String,
    description:
      "IDs (Mongo), DANS L'ORDRE, de tous les cas de test déjà présents dans le workflow — y compris testCaseId, en dernière position. " +
      "Permet à l'IA de tenir compte de tout le scénario déjà construit (pas seulement de la dernière étape isolée) : elle voit ce qui a " +
      "déjà été fait avant, pour ne pas re-suggérer une étape redondante ou incohérente avec l'état déjà établi par les étapes précédentes. " +
      "Si omis, seul testCaseId est utilisé comme contexte (comportement dégradé).",
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  workflowTestCaseIds?: string[];
}