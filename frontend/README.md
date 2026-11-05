# SpecChef — Frontend

Interface web de **SpecChef** : import d'un cahier des charges (SRS), gestion des exigences, génération assistée de cas de test par IA, suivi de campagnes, collaboration en temps réel et export vers Jira.

> L'API NestJS se trouve dans `../backend`. Elle doit tourner pour que le frontend fonctionne.

## Fonctionnalités

- **Projets et exigences** : modules, exigences, cas de test, édition en ligne avec vérification par le LLM, traçabilité des exigences.
- **Génération de cas de test** : choix du mode (automatique, assisté, création), aperçu des angles de test avant génération, suivi en direct (streaming).
- **MyersWizard** : assistant multi-étapes (classes d'équivalence, valeurs limites, règles métier, contraintes de fichiers, périmètre) avec pré-remplissage par LLM, traduction automatique (MyMemory) et matrice de couverture estimée.
- **Workflows et campagnes de test** : tableau et canvas de flows, exécution, clôture de campagne.
- **Collaboration** : commentaires, notifications, présence, fil d'activité, historique des versions.
- **Intégrations** : export Jira (réglages dans l'interface), Confluence.
- **Administration** : comptes et rôles (`ADMIN`, `QA`, `BA`, `PO`), page de suivi Langfuse, tableau de bord.

## Stack

Next.js 15 (App Router) · React · TypeScript · Tailwind CSS · Socket.IO client · Framer Motion · react-hot-toast

## Structure

```
.
├── app/
│   ├── (site)/
│   │   ├── page.tsx          Landing
│   │   ├── auth/             Connexion, OTP, mot de passe oublié (pas d'inscription : comptes créés par un Admin)
│   │   ├── projects/         Liste et détail des projets
│   │   ├── analyzer/         Écran principal d'analyse et de génération
│   │   ├── campaigns/        Campagnes de test
│   │   ├── dashboard/        Statistiques
│   │   ├── account/          Profil
│   │   ├── admin/            Administration (utilisateurs, Langfuse, Atlassian)
│   ├── api/backend/[...path] Proxy vers l'API NestJS
│   ├── components/           Composants métier (MyersWizard, workflows, commentaires…)
│   ├── context/              Auth, Jira, toasts, commentaires, notifications
│   └── hooks/                Session, polling, temps réel (WebSocket)
├── components/               Composants de la landing (Header, Hero, Features…)
├── lib/                      Clients d'API typés (projets, workflows, Jira, versions…)
├── middleware.ts             Protection des routes
└── public/                   Images et icônes
```

> Installation complète (Ollama, base, backend…) : [../GUIDE_INSTALLATION.md](../GUIDE_INSTALLATION.md).

## Prérequis

- Node.js 20+ et npm
- Le backend SpecChef lancé (par défaut sur `http://localhost:3000`)

## Installation

```bash
npm install
```

Copier `.env.example` en `.env.local` (tous les champs sont optionnels, les valeurs fournies sont les défauts) :

```bash
cp .env.example .env.local
```

## Lancement

```bash
npm run dev      # http://localhost:3004
```

| Commande | Rôle |
|---|---|
| `npm run dev` | Développement (Turbopack, port 3004) |
| `npm run build` | Build de production |
| `npm run start` | Serveur de production |
| `npx tsc --noEmit` | Vérification des types |

Le port **3004** est celui autorisé par le CORS du backend ; en cas de changement, mettre à jour `backend/src/main.ts`.

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `BACKEND_URL` | `http://localhost:3000` | URL de l'API, utilisée par le proxy `/api/backend` |
| `NEXT_PUBLIC_BACKEND_WS_URL` | `http://localhost:3000` | URL des WebSockets (notifications, commentaires, présence) |
| `PROXY_TIMEOUT_MS` | 25 minutes | Délai max d'une requête proxifiée (les générations LLM peuvent être longues) |
| `NEXT_PUBLIC_MYMEMORY_EMAIL` | vide | Email optionnel transmis à MyMemory (traduction) pour relever le quota gratuit |

## Fonctionnement

- Les appels à l'API passent par le proxy `app/api/backend/[...path]`, qui transmet la session et gère les longues requêtes de génération.
- Les mises à jour en direct (commentaires, activité, présence) utilisent Socket.IO sur le namespace `/notifications`.
- Les types partagés se trouvent dans `lib/tc-types.ts` et `lib/workflow-types.ts`.

## Points d'attention

- Le contenu de la landing (Hero, Features, About, FAQ, Contact…) vient du template *Solid Next.js* et reste à personnaliser.
- Plusieurs écrans sont volumineux (`analyzer/page.tsx`, `AssistTest.tsx`) ; ils sont candidats à un découpage.
