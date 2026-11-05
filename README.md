# SpecChef

Plateforme d'analyse de cahiers des charges (SRS) et de génération de cas de test assistée par IA (LLM local via Ollama).


## Contenu du dépôt

| Dossier | Description | Documentation |
|---|---|---|
| [`backend/`](./backend) | API NestJS, Prisma, MongoDB, Ollama, Langfuse | [backend/README.md](./backend/README.md) |
| [`frontend/`](./frontend) | Interface Next.js (React, Tailwind) | [frontend/README.md](./frontend/README.md) |

## Architecture

```
Navigateur ──► frontend (Next.js :3004) ──proxy /api/backend──► backend (NestJS :3000)
                                                                   ├─ MongoDB Atlas (Prisma + Vector Search)
                                                                   ├─ Ollama (LLM + embeddings, :11434)
                                                                   ├─ Langfuse (traces)
                                                                   └─ Jira / Confluence
```

## Installation complète

Le guide **[GUIDE_INSTALLATION.md](./GUIDE_INSTALLATION.md)** détaille tout : outils à installer, Ollama et modèles, MongoDB Atlas avec les index vectoriels, configuration, lancement et dépannage.

## Démarrage rapide

Prérequis : Node.js 20+, MongoDB Atlas, [Ollama](https://ollama.com) (`qwen2.5-coder:7b`, `nomic-embed-text`), Python 3.10+.

```bash
# 1. Backend
cd backend
cp .env.example .env          # renseigner les valeurs
npm install
npx prisma generate && npx prisma db push
npx ts-node prisma/seed/seed-admin.ts
npm run start:dev             # http://localhost:3000  (Swagger : /api)

# 2. Frontend (autre terminal)
cd frontend
npm install
npm run dev                   # http://localhost:3004
```

Tests : `npm test` dans `backend/` ; la CI GitHub (`.github/workflows/ci.yml`) compile et teste les deux projets à chaque push.

Détails, variables d'environnement et dépannage : voir le README de chaque dossier.
