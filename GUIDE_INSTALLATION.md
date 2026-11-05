# Guide d'installation et de lancement — SpecChef

Ce guide explique, pas à pas, comment installer et lancer SpecChef sur une machine neuve (macOS, Linux ou Windows).

## Sommaire

1. [Vue d'ensemble](#1-vue-densemble)
2. [Outils à installer](#2-outils-à-installer)
3. [Ollama et modèles IA](#3-ollama-et-modèles-ia)
4. [Base de données MongoDB Atlas](#4-base-de-données-mongodb-atlas)
5. [Configuration du backend](#5-configuration-du-backend)
6. [Installation et lancement du backend](#6-installation-et-lancement-du-backend)
7. [Frontend](#7-frontend)
8. [Premier démarrage](#8-premier-démarrage)
9. [Services optionnels](#9-services-optionnels-email-langfuse-jira-traduction)
10. [Dépannage](#10-dépannage)
11. [Commandes utiles](#11-commandes-utiles)

---

## 1. Vue d'ensemble

| Composant | Rôle | Port / lieu |
|---|---|---|
| **Frontend** Next.js | Interface web | `http://localhost:3004` |
| **Backend** NestJS | API, logique métier, WebSocket | `http://localhost:3000` (Swagger : `/api`) |
| **MongoDB Atlas** | Base de données + recherche vectorielle | Cloud |
| **Ollama** | LLM local (génération) et embeddings | `http://localhost:11434` |
| **Tokenizer Python** | Comptage de tokens (lancé **automatiquement** par le backend) | `http://localhost:5001` |
| **Script Python `analyze.py`** | Extraction du texte des PDF/DOCX/XLSX (lancé par le backend à chaque upload) | — |
| Langfuse, SMTP, Jira, Azure Translator | Optionnels | — |

Les trois choses à démarrer vous-même : **Ollama**, le **backend** et le **frontend**.

## 2. Outils à installer

| Outil | Version | Vérification |
|---|---|---|
| Git | récent | `git --version` |
| Node.js + npm | **20 ou plus** (22 fonctionne) | `node -v` |
| Python | **3.10 ou plus** | `python3 --version` |
| Ollama | récent | `ollama --version` |

**macOS** (avec [Homebrew](https://brew.sh)) :
```bash
brew install git node python@3.12
brew install --cask ollama      # ou téléchargement sur https://ollama.com/download
```

**Linux (Debian/Ubuntu)** :
```bash
sudo apt update && sudo apt install -y git python3 python3-venv python3-pip
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
curl -fsSL https://ollama.com/install.sh | sh
```

**Windows** : installez Git, Node.js (LTS) et Python depuis leurs sites officiels (cochez « Add Python to PATH »), puis Ollama depuis https://ollama.com/download. Utilisez PowerShell ou Git Bash. Le backend appelle la commande `python3` : sous Windows, vérifiez qu'elle existe (`python3 --version`), sinon créez un alias ou utilisez WSL.

> **Important** : le backend lance Python avec la commande `python3` trouvée dans le PATH **du terminal où vous démarrez le backend**. Si vous utilisez un environnement virtuel ou conda, activez-le *avant* `npm run start:dev` (voir étape 6).

## 3. Ollama et modèles IA

SpecChef utilise deux modèles :

| Modèle | Usage | Taille approx. |
|---|---|---|
| `qwen2.5-coder:7b` | Génération des cas de test, analyse | ~5 Go |
| `nomic-embed-text` | Embeddings (768 dimensions) pour la recherche sémantique | ~300 Mo |

```bash
ollama serve                    # inutile si l'application Ollama tourne déjà (macOS/Windows)
ollama pull qwen2.5-coder:7b
ollama pull nomic-embed-text
ollama list                     # les deux modèles doivent apparaître
```

Test rapide :
```bash
curl http://localhost:11434/api/tags
```
La réponse doit lister les deux modèles. Ollama doit rester lancé tant que vous utilisez SpecChef.

> Les dimensions d'embedding (768) sont figées dans les index Atlas de l'étape 4 : ne changez pas de modèle d'embedding sans recréer ces index.

## 4. Base de données MongoDB Atlas

La recherche vectorielle exige **MongoDB Atlas** (un MongoDB local simple ne suffit pas). Le palier gratuit **M0** convient.

### 4.1 Créer le cluster
1. Créez un compte sur https://www.mongodb.com/cloud/atlas.
2. **Create a deployment** → palier **M0 (Free)** → choisissez un fournisseur et une région proches.
3. **Database Access** → *Add New Database User* : choisissez un nom et un mot de passe (évitez les caractères spéciaux, ou encodez-les en URL), rôle *Read and write to any database*.
4. **Network Access** → *Add IP Address* : votre IP actuelle (ou `0.0.0.0/0` en développement uniquement).

### 4.2 Récupérer la chaîne de connexion
**Connect** → **Drivers** → copiez l'URI, qui ressemble à :
```
mongodb+srv://<utilisateur>:<mot_de_passe>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
```
**Ajoutez le nom de la base avant le `?`** (par exemple `specchef`) :
```
mongodb+srv://<utilisateur>:<mot_de_passe>@cluster0.xxxxx.mongodb.net/specchef?retryWrites=true&w=majority
```
Cette valeur ira dans `DATABASE_URL` (étape 5).

### 4.3 Créer les collections
Les collections sont créées par Prisma à l'étape 6 (`npx prisma db push`). **Faites d'abord l'étape 6 jusqu'à cette commande, puis revenez ici créer les index vectoriels.**

### 4.4 Créer les 3 index de recherche vectorielle
Dans Atlas : votre cluster → onglet **Search & Vector Search** → **Create Search Index** → **Vector Search** → **JSON Editor**. Choisissez la base `specchef` (ou le nom que vous avez mis dans l'URI). **Les noms d'index doivent être exactement ceux ci-dessous.**

**Index 1** — collection `test_cases`, nom `test_cases_vector_index` :
```json
{
  "fields": [
    { "type": "vector", "path": "embedding", "numDimensions": 768, "similarity": "cosine" },
    { "type": "filter", "path": "requirement_id" }
  ]
}
```

**Index 2** — collection `generation_history_entries`, nom `generation_history_vector_index` :
```json
{
  "fields": [
    { "type": "vector", "path": "embedding", "numDimensions": 768, "similarity": "cosine" },
    { "type": "filter", "path": "project_id" },
    { "type": "filter", "path": "requirement_id" }
  ]
}
```

**Index 3** — collection `srs_chunks`, nom `srs_chunks_vector_index` :
```json
{
  "fields": [
    { "type": "vector", "path": "embedding", "numDimensions": 768, "similarity": "cosine" },
    { "type": "filter", "path": "project_id" }
  ]
}
```
Attendez que chaque index passe au statut **Active** (une à deux minutes).

## 5. Configuration du backend

```bash
git clone <url-du-depot> specchef
cd specchef/backend
cp .env.example .env
```

Ouvrez `.env` et renseignez :

| Variable | Obligatoire ? | Valeur |
|---|---|---|
| `DATABASE_URL` | **Oui** | L'URI Atlas de l'étape 4.2 (avec le nom de base) |
| `JWT_SECRET` | **Oui** (en pratique) | Une longue chaîne aléatoire. Sans elle, le code utilise une valeur par défaut faible. Générer : `openssl rand -base64 48` |
| `PORT` | Non | `3000` |
| `FRONTEND_URL` | Recommandé | `http://localhost:3004` (utilisé dans les liens des emails) |
| `OLLAMA_BASE_URL` et `OLLAMA_URL` | Oui | `http://localhost:11434` (les deux variables sont lues par des parties différentes du code) |
| `OLLAMA_MODEL` | Non | `qwen2.5-coder:7b` |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_NAME` | Recommandé | Compte Admin initial. Sans valeurs, le seed crée `admin@analyzer.local` / `ChangeMe123!` : **changez-le** |
| `JIRA_TOKEN_ENCRYPTION_KEY` | Pour Jira | Chaîne aléatoire d'au moins 16 caractères (`openssl rand -base64 24`). Ne la changez plus ensuite : les tokens Jira déjà enregistrés deviendraient illisibles |
| `EMAIL_*` | Non | SMTP pour les codes OTP. **Sans SMTP, les emails (et donc les codes) s'affichent dans la console du backend** — pratique en développement |
| `LANGFUSE_*` | Non | Traces des appels LLM (voir étape 9) |
| `AZURE_TRANSLATOR_*` | Non | Traduction FR→EN avant les prompts ; sans clé, le texte est envoyé tel quel |
| `TOKENIZER_PATH` | Non | Laisser vide |

## 6. Installation et lancement du backend

### 6.1 Dépendances Node et client Prisma
```bash
cd specchef/backend
npm install                  # lance aussi `prisma generate` (postinstall)
```
Si une erreur du type « Module '@prisma/client' has no exported member 'Role' » apparaît : `npx prisma generate`.

### 6.2 Créer les collections dans Atlas
```bash
npx prisma db push
```
Revenez maintenant à l'**étape 4.4** pour créer les 3 index vectoriels si ce n'est pas fait.

### 6.3 Créer le compte Admin
```bash
npx ts-node prisma/seed/seed-admin.ts
```
Le script est sans effet si un Admin existe déjà.

### 6.4 Dépendances Python
Créez un environnement isolé **dans `backend/`** :

```bash
python3 -m venv .venv
source .venv/bin/activate              # Windows : .venv\Scripts\activate
pip install --upgrade pip
pip install -r requirements.txt
```
L'installation de `docling` est longue et lourde (plusieurs Go avec ses dépendances) : c'est normal.

> Pour que le backend utilise ce Python, **gardez l'environnement activé dans le terminal qui lance le backend** (étape suivante). Avec conda, activez votre environnement conda de la même façon.

### 6.5 Lancer le backend
Ollama doit déjà tourner (étape 3). Dans le terminal où l'environnement Python est activé :

```bash
npm run start:dev
```

Au premier lancement, le backend démarre aussi le tokenizer Python, qui télécharge le tokenizer Qwen depuis Hugging Face (connexion Internet requise, quelques secondes à quelques minutes). Si le tokenizer ne démarre pas, le backend continue et estime les tokens de façon approximative.

Le backend est prêt quand la console affiche `Backend NestJS démarré sur http://localhost:3000`. Vérifications :
- http://localhost:3000/api → documentation Swagger ;
- http://localhost:3000/llm/health → état d'Ollama.

## 7. Frontend

Dans un **second terminal** :

```bash
cd specchef/frontend
cp .env.example .env.local      # les valeurs par défaut conviennent en local
npm install
npm run dev
```
Ouvrez **http://localhost:3004**.

Si vous changez le port du frontend, ajoutez-le à la liste CORS dans `backend/src/main.ts` (`origin: [...]`).

## 8. Premier démarrage

1. Allez sur http://localhost:3004/auth/signin et connectez-vous avec le compte Admin du seed.
2. Menu Admin → **Utilisateurs** : créez les comptes de l'équipe (rôles `ADMIN`, `QA`, `BA`, `PO`). Il n'y a pas d'inscription publique.
3. **Projets** → créez un projet, importez un cahier des charges (PDF, DOCX…), lancez l'analyse.
4. Ouvrez le projet, choisissez une exigence et générez des cas de test. La première génération est plus lente (chargement des modèles en mémoire).

**Codes OTP sans SMTP** : lorsqu'un email devrait être envoyé (activation, mot de passe oublié), le backend affiche son contenu, dont le code à 6 chiffres, dans sa console.

## 9. Services optionnels (email, Langfuse, Jira, traduction)

**Email (SMTP)** — exemple Gmail : activez la validation en deux étapes, créez un *mot de passe d'application*, puis :
```env
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=votre.adresse@gmail.com
EMAIL_PASSWORD=<mot de passe d'application>
EMAIL_FROM=SpecChef <votre.adresse@gmail.com>
```

**Langfuse (traces LLM)** — créez un compte gratuit sur https://cloud.langfuse.com, créez un projet, puis un couple de clés API :
```env
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
```
Les traces sont consultables dans Langfuse et dans la page Admin → Langfuse de l'application. (Le fonctionnement sans ces clés n'a pas été testé de bout en bout : s'il génère des erreurs au démarrage, renseignez-les.)

**Jira / Confluence** — définissez `JIRA_TOKEN_ENCRYPTION_KEY` (étape 5). Chaque utilisateur connecte ensuite son compte Atlassian dans l'application avec l'URL de son site, l'email du compte et un **jeton d'API** (à créer sur https://id.atlassian.com/manage-profile/security/api-tokens, ce n'est pas le mot de passe).

**Traduction (Azure)** — ressource *Translator* dans le portail Azure : renseignez la clé, la région et l'endpoint. Côté frontend, la traduction de l'assistant utilise MyMemory ; une adresse email facultative (`NEXT_PUBLIC_MYMEMORY_EMAIL` dans `frontend/.env.local`) relève son quota gratuit.

## 10. Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| `Missing required environment variable: DATABASE_URL` | Fichier `.env` absent | `cp .env.example .env` puis renseigner `DATABASE_URL` |
| `has no exported member 'Role'` (et erreurs `unknown`) | Client Prisma non généré | `npx prisma generate` |
| `Cannot find module '.../dist/main'` alors que « 0 errors » | Cache de compilation obsolète | `rm -rf dist tsconfig.tsbuildinfo` puis relancer |
| `MongoServerSelectionError` / timeout | IP non autorisée dans Atlas, ou mot de passe erroné | Network Access Atlas ; vérifier l'URI (caractères spéciaux à encoder) |
| Erreur « index … doesn't exist » ou recherche sémantique vide | Index vectoriel absent ou mal nommé | Vérifier les 3 index (étape 4.4), noms exacts, statut *Active* |
| `ECONNREFUSED 127.0.0.1:11434` | Ollama non lancé | Lancer l'application Ollama ou `ollama serve` |
| `model "qwen2.5-coder:7b" not found` | Modèle non téléchargé | `ollama pull qwen2.5-coder:7b` (et `nomic-embed-text`) |
| Génération très lente ou expirée | CPU seul, RAM insuffisante | Fermer d'autres applications ; augmenter `PROXY_TIMEOUT_MS` dans `frontend/.env.local` |
| Upload de fichier en erreur, `python3: command not found` ou `ModuleNotFoundError: docling` | Python absent du PATH du backend ou dépendances non installées | Activer l'environnement Python **avant** `npm run start:dev` ; `pip install -r requirements.txt` |
| Tokenizer qui ne démarre pas | Hors-ligne au premier lancement, ou `transformers` manquant | Connexion Internet + `pip install -r requirements.txt` ; le backend fonctionne en estimation sinon |
| Erreur CORS dans le navigateur | Frontend sur un port non autorisé | Utiliser le port 3004 ou modifier `backend/src/main.ts` |
| `EADDRINUSE :::3000` | Port déjà utilisé | Arrêter l'ancien processus (`lsof -i :3000`) ou changer `PORT` |
| Déconnexions après un changement de `JWT_SECRET` | Anciens tokens invalidés | Se reconnecter |
| Plus de connexion Jira après changement de `JIRA_TOKEN_ENCRYPTION_KEY` | Anciens tokens illisibles | Reconnecter le compte Jira |

## 11. Commandes utiles

| Où | Commande | Effet |
|---|---|---|
| `backend/` | `npm run start:dev` | API en développement (rechargement automatique) |
| `backend/` | `npm run build && npm run start:prod` | Build et lancement en production |
| `backend/` | `npm test` | Tests unitaires |
| `backend/` | `npx prisma generate` | Régénère le client Prisma (après modification du schéma) |
| `backend/` | `npx prisma db push` | Applique le schéma à la base |
| `backend/` | `npx ts-node prisma/seed/seed-admin.ts` | Crée l'Admin initial |
| `backend/` | `npx ts-node scripts/backfill-versions.ts` | Migration du versioning (données anciennes uniquement) |
| `frontend/` | `npm run dev` | Interface en développement (port 3004) |
| `frontend/` | `npm run build && npm run start` | Build et lancement en production |
| `frontend/` | `npx tsc --noEmit` | Vérification des types |

**Ordre de démarrage au quotidien** : 1) Ollama, 2) backend (`npm run start:dev`, environnement Python activé), 3) frontend (`npm run dev`).
