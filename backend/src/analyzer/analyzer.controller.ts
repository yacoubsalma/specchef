import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
  UseGuards,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiConsumes,
  ApiBody,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AnalyzerService } from './analyzer.service';
import { LlmService } from '../llm/llm.service';
import { diskStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

const multerConfig = {
  storage: diskStorage({
    destination: './uploads',
    filename: (req, file, cb) => {
      const uniqueName = `${Date.now()}-${file.originalname}`;
      cb(null, uniqueName);
    },
  }),
  limits: {
    fileSize: 10 * 1024 * 1024 * 1024, // 10GB
  },
};

@ApiTags('analyze')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('analyze')
export class AnalyzerController {
  private readonly logger = new Logger(AnalyzerController.name);

  constructor(
    private readonly analyzerService: AnalyzerService,
    @Inject(forwardRef(() => LlmService))
    private readonly llmService: LlmService,
  ) {}

  // ============================================================
  // POST /analyze/upload — Upload et analyse d'un fichier
  // ============================================================
  @Post('upload')
  @ApiOperation({ summary: 'Upload et analyse de fichier' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary', description: 'Fichier à analyser' },
      },
    },
  })
  @UseInterceptors(FileInterceptor('file', multerConfig))
  async upload(@UploadedFile() file: Express.Multer.File) {
    this.logger.log(`📤 Upload via /upload: ${file.originalname}`);
    const analysis = await this.analyzerService.analyzeFile(file);
    return analysis;
  }
}
