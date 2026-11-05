import { Module, Global } from '@nestjs/common';
import { TokenizerService } from './tokenizer.service';

// ─── TokenizerModule ──────────────────────────────────────────────────────────
//
// @Global() → TokenizerService injectable dans tout le projet
// sans avoir à importer TokenizerModule partout.
//
// Importer une seule fois dans AppModule suffit.
// ─────────────────────────────────────────────────────────────────────────────

@Global()
@Module({
  providers: [TokenizerService],
  exports:   [TokenizerService],
})
export class TokenizerModule {}