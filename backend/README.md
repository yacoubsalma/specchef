# SpecChef — Backend

API NestJS de **SpecChef**, plateforme d'analyse de cahiers des charges (SRS) et de génération de cas de test assistée par IA. Le LLM tourne **en local** (Ollama) ; les techniques de test s'appuient sur les travaux de G. J. Myers (partitions d'équivalence et valeurs limites).

> Le frontend Next.js se trouve dans `../frontend`.

## Fonctionnalités

- **Analyse de SRS** : import PDF/DOCX, extraction des exigences, regroupement en modules.
- **Génération de cas de test en deux phases** : phase A (angles de test) puis phase B (cas de test structurés en JSON), avec mode assisté (validation des angles avant génération) et streaming SSE.
- **Recherche sémantique** : embeddings `nomic-embed-text` (768 dim.) et MongoDB Atlas Vector Search ; déduplication sémantique des cas de test.
- **Analyse d'impact** : similarité cosinus entre ancienne et nouvelle description d'une exigence (≥ 0,94 = reformulation ; en dessous, les cas de test sont marqués « à réviser »).
- **Collaboration** : commentaires, notifications et présence en temps réel (WebSocket), historique et versioning des entités, journal d'activité.
- **Campagnes et workflows de test** (`TestWorkflow`, `WorkflowRun`, `CampaignRun`).
- **Intégrations** : Jira (export, mapping modules → Epics) et Confluence.
- **Export** PDF et Excel (module ou projet complet).
- **Authentification** JWT avec codes OTP par email, rôles `ADMIN`, `QA`, `BA`, `PO` ; pas d'inscription publique (les comptes sont créés par un Admin).
- **Observabilité** : traces Langfuse (OpenTelemetry), page d'administration côté front.

## Stack

| Couche | Technologie |
|---|---|
| API | NestJS 10, TypeScript, Socket.IO, Swagger |
| Données | MongoDB (Atlas) via Prisma |
| IA | Ollama (`qwen2.5-coder:7b`, `nomic-embed-text`), LangChain |
| Observabilité | Langfuse + OpenTelemetry |
| Python | `analyzer/analyze.py` (pdfplumber, docling), `tokenizer-server.py` (transformers) |

## Structure

```
backend/
├── analyzer/               Script Python d'extraction de texte (PDF, etc.)
├── prisma/                 schema.prisma + seed/seed-admin.ts
├── scripts/                backfill-versions.ts (migration du versioning)
├── tokenizer-server.py     Micro-service de comptage de tokens (port 5001)
└── src/
    ├── auth/           JWT, OTP, guards, rôles, blacklist de tokens
    ├── user/           Gestion des comptes
    ├── project/        Projets, modules, exigences, cas de test, export
    ├── llm/            Génération (SSE), jobs, orchestration Ollama
    ├── vector/ srs/    Recherche vectorielle et indexation des SRS
    ├── embedding/      Appels d'embeddings
    ├── workflow/       Flows et exécutions de test
    ├── coverage/       Couverture
    ├── versions/       Historique et versioning
    ├── comments/ notifications/   Collaboration temps réel
    ├── dashboard/      Statistiques
    ├── jira/ confluence/          Intégrations
    ├── langfuse/       Administration des traces
    ├── analyzer/       Endpoint d'upload + appel du script Python
    ├── tokenizer/      Client du micro-service de tokens
    ├── cache/ mail/ prisma/ documents/ shared/
    └── main.ts
```

## Prérequis

- Node.js 20+ et npm
- Une base **MongoDB** (Atlas recommandé : la recherche vectorielle l'exige)
- [Ollama](https://ollama.com) avec les modèles :
  ```bash
  ollama pull qwen2.5-coder:7b
  ollama pull nomic-embed-text
  ```
- Python 3.10+ (analyse de fichiers et tokenizer)
- Optionnel : compte Langfuse, serveur SMTP, clé Azure Translator

> Guide complet pas à pas (Ollama, MongoDB Atlas, index vectoriels, Python…) : [../GUIDE_INSTALLATION.md](../GUIDE_INSTALLATION.md).

## Installation

```bash
cp .env.example .env        # puis renseigner les valeurs (voir ci-dessous)
npm install
npx prisma generate
npx prisma db push          # crée les collections et index classiques
```

Les **3 index de recherche vectorielle** (`test_cases_vector_index`, `generation_history_vector_index`, `srs_chunks_vector_index`) se créent à la main dans Atlas : voir l'étape 4.4 du guide d'installation.

Dépendances Python :

```bash
pip install -r requirements.txt     # analyzer/analyze.py et tokenizer-server.py
```

Créer le premier compte Admin (utilise `SEED_ADMIN_*`, sans effet si un Admin existe déjà) :

```bash
npx ts-node prisma/seed/seed-admin.ts
```

## Lancement

```bash
npm run start:dev            # API sur http://localhost:3000
```

Le micro-service tokenizer (`tokenizer-server.py`, port 5001) est démarré **automatiquement** par le backend avec la commande `python3` du terminal courant : activez votre environnement Python avant de lancer le backend. Ollama doit déjà tourner.

| Commande | Rôle |
|---|---|
| `npm run start:dev` | Développement (watch) |
| `npm run build` puis `npm run start:prod` | Production |
| `npm test` | Tests unitaires (Jest) |
| `npm run format` | Prettier |

Documentation interactive Swagger : **http://localhost:3000/api**

## Variables d'environnement

Voir `backend/.env.example`.

| Variable | Description |
|---|---|
| `DATABASE_URL` | Chaîne de connexion MongoDB |
| `PORT` | Port de l'API (3000 par défaut) |
| `JWT_SECRET` | Secret JWT (à définir : sinon une valeur par défaut faible est utilisée) |
| `OLLAMA_BASE_URL`, `OLLAMA_URL`, `OLLAMA_MODEL` | Serveur et modèle Ollama |
| `LANGFUSE_SECRET_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_BASE_URL` | Traces Langfuse |
| `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USER`, `EMAIL_PASSWORD`, `EMAIL_FROM` | SMTP pour les OTP (sans config, les emails sont affichés dans la console) |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_NAME` | Compte Admin initial |
| `AZURE_TRANSLATOR_KEY`, `_REGION`, `_ENDPOINT` | Traduction FR→EN avant chaque prompt (sinon texte transmis tel quel) |
| `JIRA_TOKEN_ENCRYPTION_KEY` | Chiffrement des tokens Jira stockés |
| `FRONTEND_URL`, `TOKENIZER_PATH` | Optionnels |

## Points d'attention

- **CORS** : seules les origines `localhost:3000`, `3001` et `3004` sont autorisées (voir `src/main.ts`). Adapter pour un autre déploiement.
- **Secrets** : ne jamais committer `.env`.
- **Migration** : sur des données antérieures au versioning, exécuter une fois `npx ts-node scripts/backfill-versions.ts`.
- **Linux/CI** : les noms de fichiers sont en minuscules (kebab-case) ; garder cette convention, les imports sont sensibles à la casse.
