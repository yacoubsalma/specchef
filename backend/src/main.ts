import { sdk } from './instrumentation';

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationPipe } from '@nestjs/common';
import * as express from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();

  // Validation globale des DTOs (class-validator) — requis pour Auth/Users
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  // Augmenter la limite de payload JSON
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  app.enableCors({
    origin: ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3004'],
    credentials: true,
  });

  // Désactiver la compression pour les SSE (sinon le flush ne fonctionne pas)
  app.use((req: any, res: any, next: any) => {
    if (req.path?.includes('generate-stream')) {
      res.setHeader('Content-Encoding', 'identity');
    }
    next();
  });

  // Configuration Swagger
  const config = new DocumentBuilder()
    .setTitle('File Analyzer API')
    .setDescription('API pour analyser différents types de fichiers (PDF, texte, binaire)')
    .setVersion('1.0')
    .addTag('analyze', 'Endpoints d\'analyse de fichiers')
    .addTag('auth', 'Authentification (JWT + OTP email)')
    .addTag('users', 'Gestion des utilisateurs (rôles Admin / QA / BA)')
    .addBearerAuth()
    .build();
  
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  const shutdown = async () => {
    await app.close();
    await sdk.shutdown();
  };

  process.once('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });

  process.once('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });

  await app.listen(3000);
  console.log('🚀 Backend NestJS démarré sur http://localhost:3000');
  console.log('📡 SSE endpoint: POST http://localhost:3000/llm/generate-stream');
}
bootstrap();
