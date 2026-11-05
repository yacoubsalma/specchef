import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class GenerateTestDataDto {
  @ApiProperty({
    required: false,
    description: "Contexte libre pour guider la génération (ex: \"client tunisien, dossier de rénovation\")",
  })
  @IsOptional()
  @IsString()
  notes?: string;
}
