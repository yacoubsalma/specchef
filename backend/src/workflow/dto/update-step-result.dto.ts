import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';
import { WORKFLOW_STEP_STATUSES, WorkflowStepStatus } from '../../shared/workflow-types';

export class UpdateStepResultDto {
  @ApiProperty({ enum: WORKFLOW_STEP_STATUSES })
  @IsIn(WORKFLOW_STEP_STATUSES as unknown as string[])
  status: WorkflowStepStatus;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  note?: string;

  @ApiProperty({
    required: false,
    description: 'Valeurs des variables produites par cette étape (ex: { orderId: "CMD-4821" })',
  })
  @IsOptional()
  @IsObject()
  variableValues?: Record<string, string>;
}
