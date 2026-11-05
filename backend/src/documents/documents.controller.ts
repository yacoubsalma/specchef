import {
  Controller, Post, Get, UseInterceptors, UploadedFile,
  Body, BadRequestException, Param, HttpException, HttpStatus, UseGuards,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { DocumentsService } from './documents.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../auth/decorators/current-user.decorator';

@ApiTags('documents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post('upload')
  @Roles(Role.ADMIN, Role.BA, Role.PO)
  @ApiOperation({ summary: 'Upload a document and extract functional requirements — Admin/BA only' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        projectName: { type: 'string' },
        projectDescription: { type: 'string' },
      },
      required: ['file', 'projectName'],
    },
  })
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body('projectName') projectName: string,
    @Body('projectDescription') projectDescription: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    if (!projectName) throw new BadRequestException('projectName is required');

    const project = await this.documentsService.processDocument(
      file,
      projectName,
      projectDescription,
      user.sub,
    );

    return {
      message: 'Document uploaded. Extraction in progress...',
      projectId: project.id,
      status: project.status,
      checkStatusUrl: `/documents/status/${project.id}`,
    };
  }

  @Get('status/:projectId')
  @ApiOperation({ summary: 'Get the status of a project extraction' })
  async getStatus(@Param('projectId') projectId: string) {
    try {
      const status = await this.documentsService.getProjectStatus(projectId);
      return status;
    } catch (err) {
      if (err instanceof BadRequestException) {
        throw err;
      }
      throw new HttpException(
        'Failed to fetch status',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('import-confluence')
  @Roles(Role.ADMIN, Role.BA, Role.PO)
  @ApiOperation({ summary: 'Importe une page Confluence existante et lance l\'extraction — Admin/BA only' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        spaceKey: { type: 'string' },
        pageId: { type: 'string' },
        projectName: { type: 'string' },
        projectDescription: { type: 'string' },
      },
      required: ['spaceKey', 'pageId'],
    },
  })
  async importFromConfluence(
    @Body('spaceKey') spaceKey: string,
    @Body('pageId') pageId: string,
    @Body('projectName') projectName: string | undefined,
    @Body('projectDescription') projectDescription: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!spaceKey || !pageId) throw new BadRequestException('spaceKey et pageId sont requis');

    const project = await this.documentsService.importFromConfluence(
      user.sub,
      spaceKey,
      pageId,
      projectName,
      projectDescription,
    );

    return {
      message: 'Page Confluence importée. Extraction en cours...',
      projectId: project.id,
      status: project.status,
      checkStatusUrl: `/documents/status/${project.id}`,
    };
  }
}