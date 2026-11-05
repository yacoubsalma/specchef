import { Controller, Post, Get, Param, Body, UseInterceptors, UploadedFile, Logger, BadRequestException, UseGuards } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiConsumes, ApiBearerAuth } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { SrsService } from './srs.service';
import { PDFParse } from 'pdf-parse';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

const multerConfig = {
  storage: memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 * 1024, // 10GB
  },
};

@ApiTags('SRS')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('srs')
export class SrsController {
  private readonly logger = new Logger(SrsController.name);

  constructor(private srsService: SrsService) {}

  /**
   * Uploader un document SRS (PDF ou TXT) — Admin/BA uniquement
   */
  @Post('/:projectId/upload')
  @Roles(Role.ADMIN, Role.BA, Role.PO)
  @UseInterceptors(FileInterceptor('file', multerConfig))
  @ApiOperation({ summary: 'Upload a SRS document (PDF or TXT) — Admin/BA only' })
  @ApiConsumes('multipart/form-data')
  async uploadSrs(
    @Param('projectId') projectId: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded. Make sure the field name is "file"');
    }

    this.logger.log(`📥 [SRS UPLOAD] File: ${file.originalname}, Size: ${file.size} bytes`);

    // Lire le contenu du fichier
    let content = '';
    
    if (file.originalname.endsWith('.pdf')) {
      // Parser PDF
      try {
        const parser = new PDFParse({ data: file.buffer });
        const data = await parser.getText();
        await parser.destroy();
        content = data.text;
        this.logger.log(`✅ PDF parsed: ${data.total} pages`);
      } catch (err) {
        this.logger.error('PDF parsing error:', err);
        const msg = err instanceof Error ? err.message : String(err);
        throw new BadRequestException(`Failed to parse PDF: ${msg}`);
      }
    } else if (file.originalname.endsWith('.txt') || file.originalname.endsWith('.md')) {
      // Fichier texte
      content = file.buffer.toString('utf-8');
    } else {
      throw new BadRequestException('Unsupported file format. Please use PDF, TXT, or MD files.');
    }

    if (!content || content.trim().length === 0) {
      throw new BadRequestException('File is empty or contains no readable text');
    }

    return this.srsService.uploadSrs(projectId, file.originalname, content);
  }

  /**
   * Uploader directement du texte SRS
   */
  @Post('/:projectId/upload-text')
  @Roles(Role.ADMIN, Role.BA, Role.PO)
  @ApiOperation({ summary: 'Upload SRS content as text — Admin/BA only' })
  async uploadSrsText(
    @Param('projectId') projectId: string,
    @Body() body: { filename: string; content: string },
  ) {
    return this.srsService.uploadSrs(projectId, body.filename, body.content);
  }

  /**
   * Récupérer le document SRS d'un projet
   */
  @Get('/:projectId')
  @ApiOperation({ summary: 'Get SRS document for a project' })
  async getSrs(@Param('projectId') projectId: string) {
    return this.srsService.getSrsDocument(projectId);
  }

  /**
   * Rechercher les contextes SRS pertinents
   * Le défaut (10) est volontairement plus élevé que celui utilisé en interne pour le
   * contexte RAG (2, cf. SrsService.getSrsContext) — ici la recherche est destinée à un
   * humain qui veut explorer les passages pertinents, pas à limiter la taille d'un prompt.
   */
  @Post('/:projectId/search')
  @ApiOperation({ summary: 'Search for relevant SRS context' })
  async searchSrsContext(
    @Param('projectId') projectId: string,
    @Body() body: { question: string; topK?: number },
  ) {
    return this.srsService.getSrsContext(projectId, body.question, body.topK ?? 10);
  }
}