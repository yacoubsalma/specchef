import { Feature } from "@/types/feature";

const featuresData: Feature[] = [
  {
    id: 1,
    icon: "/images/icon/icon-01.svg",
    title: "Extraction d'exigences",
    description:
      "Uploadez vos documents (PDF, DOCX, XLSX) et extrayez automatiquement les exigences structurées par module grâce aux LLMs.",
  },
  {
    id: 2,
    icon: "/images/icon/icon-02.svg",
    title: "Génération de cas de test",
    description:
      "Générez des cahiers de recettes complets — positifs, négatifs, edge cases, boundary, sécurité, state transition et plus.",
  },
  {
    id: 3,
    icon: "/images/icon/icon-03.svg",
    title: "AssistTest",
    description:
      "Configurez les champs, valeurs valides/invalides, limites et scope pour obtenir des cas de test ultra-précis.",
  },
  {
    id: 4,
    icon: "/images/icon/icon-04.svg",
    title: "Validation & Persistance",
    description:
      "Validez, rejetez, régénérez ou éditez chaque cas de test. Sauvegardez en base PostgreSQL en un clic.",
  },
  {
    id: 5,
    icon: "/images/icon/icon-05.svg",
    title: "SRS Vector Search",
    description:
      "Indexez votre SRS avec MongoDB Atlas Vector Search. Recherche sémantique pour retrouver les exigences pertinentes.",
  },
  {
    id: 6,
    icon: "/images/icon/icon-06.svg",
    title: "Détection de saturation",
    description:
      "Le système détecte automatiquement quand l'espace sémantique est saturé pour éviter les doublons de cas de test.",
  },
];

export default featuresData;