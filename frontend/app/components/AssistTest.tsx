"use client";

import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { useSanitizer } from "./useSanitizer";
import ConfirmDeleteModal from "./ConfirmDeleteModal";

// Email optionnel : MyMemory relève le quota gratuit quand `de=<email>` est fourni.
const MYMEMORY_EMAIL = process.env.NEXT_PUBLIC_MYMEMORY_EMAIL;
const MYMEMORY_EMAIL_PARAM = MYMEMORY_EMAIL ? `&de=${encodeURIComponent(MYMEMORY_EMAIL)}` : "";
const TRANSLATION_ENABLED = true;
// ─── Types ────────────────────────────────────────────────────────────────────

export interface FormRequirement {
  reqId: string;
  reqUUID: string;
  reqDesc: string;
  module: string;
  priority: "SHALL" | "SHOULD" | "MAY" | "MUST";
}

export interface FieldDefinition {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
}

export type FieldType = string;

export interface FileDefinition {
  name: string;
  acceptedFormats: string[];
  rejectedFormats: string[];
  maxSizeLabel: string;
  minSizeLabel: string;
  mimeNote: string;
}

export interface ErrorMessageDefinition {
  fieldName: string;        // kept for backward compat (used in card display)
  fieldNames?: string[];    // multi-selection
  text: string;
  position: "inline" | "toast" | "banner" | "modal";
}

export interface ConditionalFlow {
  id: string;
  condition: string;
  trueBranch: string;
  falseBranch: string;
}

export interface StepDefinition {
  id: string;
  label: string;
  requiredFields: string[];
}

type PaymentScenario = "accepted" | "refused" | "cancelled" | "double_click" | "timeout" | "confirmation";

// Champs de saisie à tester pour le paiement
type PaymentField = "card_number" | "card_expiry" | "card_cvv" | "card_holder" | "iban" | "amount" | "currency";

export interface PaymentGateway {
  name: string;
  scenarios: PaymentScenario[];
  amount: string;
  currency: string;
  mode: "sandbox" | "production";
  paymentMethod: "card" | "iban" | "both";
  fieldsToTest: PaymentField[];
  notes: string;
}

export interface DbConstraint {
  column: string;
  notNull: boolean;
  unique: boolean;
  maxLength: string;
}

type CrudOp = "create" | "update" | "delete" | "search" | "filter" | "sort" | "pagination";

export interface CrudResource {
  resource: string;
  baseEndpoint: string;
  ops: CrudOp[];
  idField: string;
  queryParams: string;
}

export interface AuthContext {
  roles: string[];
  passwordPolicy: string;
  maxAttempts: string;
  sessionDuration: string;
  mfaType: string;
  protectedResources: string[];
}

export interface TestFormData {
  fields: FieldDefinition[];
  validValues: Record<string, string[]>;
  invalidValues: Record<string, string[]>;
  businessRules: string[];
  minBoundary: Record<string, string>;
  maxBoundary: Record<string, string>;
  outOfBounds: Record<string, string>;
  fileInputs: FileDefinition[];
  errorMessages: ErrorMessageDefinition[];
  conditionalFlows: ConditionalFlow[];
  steps: StepDefinition[];
  paymentGateways: PaymentGateway[];
  dbConstraints: DbConstraint[];
  crudResources: CrudResource[];
  authContext: AuthContext;
  fieldOptions: Record<string, string[]>;
}

interface AssistTestProps {
  requirement: FormRequirement;
  model: string;
  projectId?: string | null;
  apiBaseUrl?: string;
  docLanguage?: string;
  /** Utilisateur courant — sert à signaler aux AUTRES utilisateurs "remplit
   *  le formulaire assisté" tant que ce modal est ouvert (présence best-effort,
   *  sans verrou — voir POST /llm/generation-presence). */
  actorId?: string;
  actorName?: string;
  onTCsGenerated: (result: {
    formContext: string;
    formData: TestFormData;
    selectedScope: string[];
  }) => void;
  onClose: () => void;
  onError?: (message: string) => void;
  onGenerationError?: (message: string) => void;
  externalError?: string | null;
  // Suivi temps réel : renseigné si un AUTRE utilisateur est en train de
  // générer des cas de test sur CETTE MÊME exigence (via un mode quelconque
  // — Flash, Création ou Signature, le verrou serveur est par exigence, pas
  // par mode). Mis à jour en direct par page.tsx (WebSocket), donc reste
  // exact même si la génération démarre APRÈS l'ouverture de ce formulaire.
  // `genMode`/`step` détaillent précisément l'étape (angles, cas de test, ou
  // remplissage du formulaire Signature).
  liveGenerationLock?: { actorName: string; genMode?: string; step?: string } | null;
}

// ─── Libellé détaillé mode + étape (miroir de formatGenerationStatus dans
// analyzer/page.tsx — dupliqué ici car ce composant n'importe pas ce module) ──
const GEN_MODE_LABELS: Record<string, string> = { fast: "Mode Flash", assisted: "Mode Création", explicit: "Mode Signature" };
const GEN_STEP_LABELS: Record<string, string> = {
  angles: "génère les angles de test",
  testcases: "génère les cas de test",
  form: "remplit le formulaire assisté",
};
function formatLockStatus(lock: { actorName: string; genMode?: string; step?: string }): string {
  const modeLabel = lock.genMode && GEN_MODE_LABELS[lock.genMode] ? ` (${GEN_MODE_LABELS[lock.genMode]})` : "";
  const stepLabel = lock.step && GEN_STEP_LABELS[lock.step] ? GEN_STEP_LABELS[lock.step] : "génère des cas de test";
  return `${lock.actorName}${modeLabel} ${stepLabel}`;
}

// ─── Helper : champs de type "choix" ─────────────────────────────────────────
function isChoiceField(type: FieldType): boolean {
  return type === "select" || type === "checkbox";
}

// ─── MyMemory Translation ─────────────────────────────────────────────────────

const SUPPORTED_LANGUAGES: { code: string; label: string }[] = [
  { code: "en", label: "Anglais" },
  { code: "fr", label: "Français" },
  { code: "es", label: "Espagnol" },
  { code: "de", label: "Allemand" },
  { code: "it", label: "Italien" },
  { code: "pt", label: "Portugais" },
  { code: "nl", label: "Néerlandais" },
  { code: "pl", label: "Polonais" },
  { code: "ru", label: "Russe" },
  { code: "ja", label: "Japonais" },
  { code: "zh", label: "Chinois" },
  { code: "ar", label: "Arabe" },
  { code: "tr", label: "Turc" },
  { code: "ko", label: "Coréen" },
];

type TranslationStatus = "idle" | "loading" | "done" | "error";

interface TranslationState {
  status: TranslationStatus;
  error: string | null;
  translatedData: TestFormData | null;
  targetLang: string;
}

async function detectLanguage(text: string): Promise<string> {
  if (!text.trim()) return "fr";
  const sample = text.slice(0, 300);
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(sample)}&langpair=autodetect|en${MYMEMORY_EMAIL_PARAM}`;
    const res = await fetch(url);
    const data = await res.json();
    const detected: string =
      data?.responseData?.detectedLanguage ??
      data?.matches?.[0]?.["source-lang"] ??
      "fr";
    return detected.split("-")[0].toLowerCase();
  } catch {
    return "fr";
  }
}

async function translateText(text: string, targetLang: string): Promise<string> {
  if (!text.trim()) return text;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=autodetect|${targetLang}${MYMEMORY_EMAIL_PARAM}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (
    data.responseStatus === 400 ||
    (typeof data.responseDetails === "string" &&
      data.responseDetails.toUpperCase().includes("PLEASE SELECT TWO DISTINCT LANGUAGES"))
  ) {
    return text;
  }
  if (data.responseStatus !== 200) throw new Error(data.responseDetails ?? "MyMemory error");
  return data.responseData?.translatedText ?? text;
}

async function translateArray(arr: string[], targetLang: string): Promise<string[]> {
  if (arr.length === 0) return arr;
  const joined = arr.join("\n|||SPLIT|||\n");
  const translated = await translateText(joined, targetLang);
  const parts = translated.split(/\n?\|\|\|SPLIT\|\|\|\n?/);
  if (parts.length !== arr.length) return arr;
  return parts.map(p => p.trim());
}

async function translateFormData(
  formData: TestFormData,
  targetLang: string,
  onProgress?: (pct: number) => void,
): Promise<TestFormData> {
  const result = structuredClone(formData) as TestFormData;
  const tasks: (() => Promise<void>)[] = [];

  for (const key of Object.keys(result.validValues)) {
    const vals = result.validValues[key];
    if (vals.length > 0) {
      tasks.push(async () => { result.validValues[key] = await translateArray(vals, targetLang); });
    }
  }
  for (const key of Object.keys(result.invalidValues)) {
    const vals = result.invalidValues[key];
    if (vals.length > 0) {
      tasks.push(async () => { result.invalidValues[key] = await translateArray(vals, targetLang); });
    }
  }
  if (result.businessRules.length > 0) {
    tasks.push(async () => { result.businessRules = await translateArray(result.businessRules, targetLang); });
  }
  for (const key of Object.keys(result.minBoundary)) {
    if (result.minBoundary[key].trim()) {
      tasks.push(async () => { result.minBoundary[key] = await translateText(result.minBoundary[key], targetLang); });
    }
  }
  for (const key of Object.keys(result.maxBoundary)) {
    if (result.maxBoundary[key].trim()) {
      tasks.push(async () => { result.maxBoundary[key] = await translateText(result.maxBoundary[key], targetLang); });
    }
  }
  for (const key of Object.keys(result.outOfBounds)) {
    if (result.outOfBounds[key].trim()) {
      tasks.push(async () => { result.outOfBounds[key] = await translateText(result.outOfBounds[key], targetLang); });
    }
  }
  result.errorMessages.forEach((em, i) => {
    if (em.text.trim()) {
      tasks.push(async () => { result.errorMessages[i] = { ...em, text: await translateText(em.text, targetLang) }; });
    }
  });
  result.conditionalFlows.forEach((cf, i) => {
    tasks.push(async () => {
      const [cond, tb, fb] = await Promise.all([
        cf.condition.trim() ? translateText(cf.condition, targetLang) : Promise.resolve(cf.condition),
        cf.trueBranch.trim() ? translateText(cf.trueBranch, targetLang) : Promise.resolve(cf.trueBranch),
        cf.falseBranch.trim() ? translateText(cf.falseBranch, targetLang) : Promise.resolve(cf.falseBranch),
      ]);
      result.conditionalFlows[i] = { ...cf, condition: cond, trueBranch: tb, falseBranch: fb };
    });
  });
  result.steps.forEach((s, i) => {
    if (s.label.trim()) {
      tasks.push(async () => { result.steps[i] = { ...s, label: await translateText(s.label, targetLang) }; });
    }
  });
  result.fileInputs.forEach((fi, i) => {
    if (fi.mimeNote.trim()) {
      tasks.push(async () => { result.fileInputs[i] = { ...fi, mimeNote: await translateText(fi.mimeNote, targetLang) }; });
    }
  });
  for (let i = 0; i < tasks.length; i++) {
    await tasks[i]();
    onProgress?.(Math.round(((i + 1) / tasks.length) * 100));
  }
  return result;
}

// ─── Field type catalogue ─────────────────────────────────────────────────────

const FIELD_TYPES: { value: FieldType; label: string; hint: string; emoji: string }[] = [
  { value: "text", label: "Texte", hint: "Champ texte libre (nom, prénom, adresse…)", emoji: "Aa" },
  { value: "email", label: "Email", hint: "Adresse email avec validation format", emoji: "@" },
  { value: "number", label: "Nombre", hint: "Valeur numérique entière ou décimale", emoji: "123" },
  { value: "date", label: "Date", hint: "Date, heure ou datetime avec format attendu", emoji: "📅" },
  { value: "phone", label: "Téléphone", hint: "Numéro de téléphone avec indicatif optionnel", emoji: "📞" },
  { value: "url", label: "URL", hint: "Lien web avec protocole (https://…)", emoji: "🔗" },
  { value: "select", label: "Liste", hint: "Dropdown / sélection parmi des valeurs fixes", emoji: "▾" },
  { value: "checkbox", label: "Case à cocher", hint: "Booléen ou case à cocher", emoji: "☑" },
  { value: "file", label: "Fichier", hint: "Upload de fichier (format, taille, type MIME)", emoji: "📎" },
  { value: "textarea", label: "Zone de texte", hint: "Texte long, multiligne", emoji: "¶" },
];

const CUSTOM_TYPES_STORAGE_KEY = "assisttest_custom_field_types_v1";

// ─── Scope catalogue ──────────────────────────────────────────────────────────
export type ScopeCategory =
  | "form_validation"
  | "file_handling"
  | "business_logic"
  | "journey_flow"
  | "crud_operations"
  | "authentication"
  | "integration_dependencies";

interface ScopeFeature {
  id: string;
  category: string;
  title: string;
  examples: string;
}

const SCOPE_CATEGORIES: { id: ScopeCategory; label: string }[] = [
  { id: "form_validation", label: "Contrôle de saisie" },
  { id: "file_handling", label: "Upload & fichiers" },
  { id: "business_logic", label: "Règles & calculs" },
  { id: "journey_flow", label: "Navigation & étapes" },
  { id: "crud_operations", label: "Actions sur les données" },
  { id: "authentication", label: "Authentification" },
  { id: "integration_dependencies", label: "Services externes" },
];

const SCOPE_FEATURES: ScopeFeature[] = [
  { id: "form_required_fields", category: "form_validation", title: "Champs obligatoires", examples: "exemple: un champ vide, tous vides, whitespace uniquement" },
  { id: "form_regex_validation", category: "form_validation", title: "Expressions régulières", examples: "exemple: format email, téléphone, URL — valides et invalides" },
  { id: "form_error_messages", category: "form_validation", title: "Alertes & messages", examples: "exemple: message d'erreur inline, toast de succès, bannière d'avertissement, erreurs multiples simultanées" },
  { id: "file_corrupted", category: "file_handling", title: "Fichiers corrompus", examples: "exemple: fichier tronqué, binaire aléatoire, encodage incorrect" },
  { id: "file_metadata", category: "file_handling", title: "Métadonnées fichier", examples: "exemple: métadonnées conservées après upload/re-téléchargement, fichier sans metadata" },
  { id: "business_calculations", category: "business_logic", title: "Calculs corrects", examples: "exemple: résultat exact, division par zéro, arrondi flottant" },
  { id: "business_rules_applied", category: "business_logic", title: "Application des règles", examples: "exemple: règle appliquée, règle violée, changement d'état" },
  { id: "business_conditional_flows", category: "business_logic", title: "Flux conditionnels", examples: "exemple: branche vraie et fausse, if/else, switch — chaque condition nommée" },
  { id: "business_state_transitions", category: "business_logic", title: "Transitions d'état", examples: "exemple: Draft → Submitted → Approved, rejet d'un statut invalide" },
  { id: "business_expected_effects", category: "business_logic", title: "Effets métier attendus", examples: "exemple: compte créé, email envoyé, statut mis à jour" },
  { id: "journey_navigation", category: "journey_flow", title: "Flux de navigation", examples: "exemple: flux nominal, accès direct à une étape, retour arrière" },
  { id: "journey_redirections", category: "journey_flow", title: "Redirections", examples: "exemple: succès → dashboard, erreur → page erreur, retour avec état préservé" },
  { id: "journey_multi_step", category: "journey_flow", title: "Processus multi-étapes", examples: "exemple: toutes étapes complétées, étape incomplète, refresh en cours de processus" },
  { id: "journey_prev_next", category: "journey_flow", title: "Navigation Préc./Suiv.", examples: "exemple: Suivant bloqué si étape invalide, Précédent conserve les données" },
  { id: "crud_create", category: "crud_operations", title: "Création", examples: "exemple: création avec données valides, soumission réussie" },
  { id: "crud_update", category: "crud_operations", title: "Modification", examples: "exemple: mise à jour partielle, modification complète" },
  { id: "crud_delete", category: "crud_operations", title: "Suppression", examples: "exemple: suppression confirmée, suppression annulée" },
  { id: "crud_search", category: "crud_operations", title: "Recherche", examples: "exemple: résultat trouvé, aucun résultat" },
  { id: "crud_filter", category: "crud_operations", title: "Filtrage", examples: "exemple: filtre simple, filtre multiple combiné" },
  { id: "crud_sort", category: "crud_operations", title: "Tri", examples: "exemple: ordre croissant, décroissant" },
  { id: "auth_password_policy", category: "authentication", title: "Politique de mot de passe", examples: "exemple: longueur minimale, complexité requise, confirmation correcte/incorrecte" },
  { id: "auth_login", category: "authentication", title: "Connexion", examples: "exemple: identifiants valides, mot de passe incorrect, utilisateur inexistant" },
  { id: "auth_mfa", category: "authentication", title: "Authentification multifactorielle (MFA)", examples: "exemple: code valide, code expiré, code incorrect" },
  { id: "auth_session", category: "authentication", title: "Gestion des sessions", examples: "exemple: session active, expiration automatique, déconnexion manuelle" },
  { id: "auth_rate_limiting", category: "authentication", title: "Limitation des tentatives", examples: "exemple: 3 essais échoués → blocage temporaire, reset compteur après succès" },
  { id: "integration_payment", category: "integration_dependencies", title: "Passerelles de paiement", examples: "exemple: paiement accepté, refusé, annulé, double clic, timeout fournisseur, confirmation de transaction" },
  { id: "integration_notifications", category: "integration_dependencies", title: "Notifications", examples: "exemple: email de confirmation envoyé, SMS reçu, notification non envoyée, doublon évité" },
  { id: "file_import", category: "file_handling", title: "Import de fichier (CSV/Excel)", examples: "exemple: fichier bien formé, colonnes manquantes, encodage incorrect, fichier vide, ligne en double" },
  { id: "file_export", category: "file_handling", title: "Export de données", examples: "exemple: export CSV/Excel/PDF complet, export filtré, export vide, format correct" },
];

const SCOPE_SUGGESTIONS: Record<string, string[]> = {
  // Anciennes paires obligatoires → désormais suggestions
  journey_multi_step:         ["journey_prev_next"],
  journey_prev_next:          ["journey_multi_step"],
  auth_rate_limiting:         ["auth_login"],
  auth_mfa:                   ["auth_login"],
  auth_session:               ["auth_login"],
  auth_password_policy:       ["auth_login"],

  // Suggestions existantes
  crud_create:                ["form_required_fields"],
  crud_search:                ["crud_filter", "crud_sort"],
  file_corrupted:             ["file_metadata"],
  business_state_transitions: ["business_conditional_flows"],
  journey_redirections:       ["journey_navigation"],

  // Nouvelles suggestions ajoutées
  crud_update:                ["crud_create"],
  crud_delete:                ["crud_create", "crud_update"],
  crud_filter:                ["crud_sort", "crud_search"],
  crud_sort:                  ["crud_filter"],
  auth_login:                 ["auth_session", "auth_rate_limiting"],
  integration_payment:        ["business_expected_effects", "integration_notifications"],
  file_import:                ["form_error_messages"],
  file_export:                ["crud_filter"],
  business_calculations:      ["business_rules_applied"],
  business_conditional_flows: ["business_rules_applied"],
  journey_navigation:         ["journey_redirections"],
  form_regex_validation:      ["form_error_messages"],
  form_required_fields:       ["form_error_messages"],
};

const FORM_SCOPE_IDS = new Set(SCOPE_FEATURES.filter(f => f.category === "form_validation").map(f => f.id));
const FILE_SCOPE_IDS = new Set(SCOPE_FEATURES.filter(f => f.category === "file_handling").map(f => f.id));

function hasFormScope(selected: Set<string>): boolean {
  return [...selected].some(id => FORM_SCOPE_IDS.has(id));
}
function hasFileScope(selected: Set<string>): boolean {
  return [...selected].some(id => FILE_SCOPE_IDS.has(id));
}

// ─── Context compiler ─────────────────────────────────────────────────────────

function compileFormContext(formData: TestFormData, selectedScopeIds: string[]): string {
  const lines: string[] = ["USER TESTING CONTEXT:"];

  if (formData.fields.length > 0) {
    const fieldsSummary = formData.fields
      .map(f => `${f.name}[${f.type}]${f.required ? "*" : ""}${f.label !== f.name ? ` (${f.label})` : ""}`)
      .join(", ");
    lines.push(`FIELDS: ${fieldsSummary}`);
  }

  for (const field of formData.fields) {
    if (isChoiceField(field.type)) {
      const opts = (formData.fieldOptions ?? {})[field.name] ?? [];
      if (opts.length > 0) {
        lines.push(`[OPTIONS:${field.name}] ${opts.join(" | ")}`);
      }
    }
  }

  if (formData.fileInputs && formData.fileInputs.length > 0) {
    for (const fi of formData.fileInputs) {
      if (fi.acceptedFormats.length > 0) lines.push(`[FILE:${fi.name}:ACCEPTED] ${fi.acceptedFormats.join(", ")}`);
      if (fi.rejectedFormats.length > 0) lines.push(`[FILE:${fi.name}:REJECTED] ${fi.rejectedFormats.join(", ")}`);
      if (fi.maxSizeLabel.trim()) lines.push(`[FILE:${fi.name}:MAX_SIZE] ${fi.maxSizeLabel.trim()}`);
      if (fi.minSizeLabel.trim()) lines.push(`[FILE:${fi.name}:MIN_SIZE] ${fi.minSizeLabel.trim()}`);
      if (fi.mimeNote.trim()) lines.push(`[FILE:${fi.name}:MIME] ${fi.mimeNote.trim()}`);
    }
  }

  for (const field of formData.fields) {
    if (isChoiceField(field.type)) continue;
    const vals = formData.validValues[field.name] ?? [];
    if (vals.length > 0) lines.push(`[VALID:${field.name}] ${vals.join(" | ")}`);
  }
  const globalValid = formData.validValues["__global__"] ?? [];
  if (globalValid.length > 0) lines.push(`[VALID] ${globalValid.join(" | ")}`);

  for (const field of formData.fields) {
    if (isChoiceField(field.type)) continue;
    const vals = formData.invalidValues[field.name] ?? [];
    if (vals.length > 0) lines.push(`[INVALID:${field.name}] ${vals.join(" | ")}`);
  }
  const globalInvalid = formData.invalidValues["__global__"] ?? [];
  if (globalInvalid.length > 0) lines.push(`[INVALID] ${globalInvalid.join(" | ")}`);

  if (formData.businessRules.length > 0)
    lines.push(`[RULES] ${formData.businessRules.join(" | ")}`);

  for (const field of formData.fields) {
    if (isChoiceField(field.type)) continue;
    const min = formData.minBoundary[field.name] ?? "";
    const max = formData.maxBoundary[field.name] ?? "";
    const oob = formData.outOfBounds[field.name] ?? "";
    if (min.trim()) lines.push(`MIN:${field.name}: ${min.trim()}`);
    if (max.trim()) lines.push(`MAX:${field.name}: ${max.trim()}`);
    if (oob.trim()) lines.push(`OUT_OF_BOUNDS:${field.name}: ${oob.trim()}`);
  }

  for (const em of (formData.errorMessages ?? [])) {
    lines.push(`[ERROR_MSG:${em.fieldName}:${em.position}] "${em.text}"`);
  }
  for (const cf of (formData.conditionalFlows ?? [])) {
    lines.push(`[COND:${cf.id}] IF(${cf.condition}) → TRUE:${cf.trueBranch} | FALSE:${cf.falseBranch}`);
  }
  if ((formData.steps ?? []).length > 0) {
    const stepsSummary = (formData.steps ?? []).map(s => `${s.id}(${s.label})[${s.requiredFields.join(",")}]`).join(" → ");
    lines.push(`[STEPS] ${stepsSummary}`);
  }
  for (const pg of (formData.paymentGateways ?? [])) {
    lines.push(`[PAYMENT:${pg.name}] mode:${pg.mode} method:${pg.paymentMethod}${pg.amount ? ` amount:${pg.amount} ${pg.currency}` : ""}`);
    if (pg.scenarios.length > 0) lines.push(`[PAYMENT:${pg.name}:SCENARIOS] ${pg.scenarios.join(" | ")}`);
    if (pg.fieldsToTest?.length > 0) lines.push(`[PAYMENT:${pg.name}:FIELDS_TO_TEST] ${pg.fieldsToTest.join(" | ")}`);
    if (pg.notes?.trim()) lines.push(`[PAYMENT:${pg.name}:NOTES] ${pg.notes.trim()}`);
  }
  for (const dc of (formData.dbConstraints ?? [])) {
    const parts: string[] = [];
    if (dc.notNull) parts.push("NOT NULL");
    if (dc.unique) parts.push("UNIQUE");
    if (dc.maxLength.trim()) parts.push(`MAX_LENGTH:${dc.maxLength.trim()}`);
    if (parts.length > 0) lines.push(`[DB:${dc.column}] ${parts.join(", ")}`);
  }
  for (const cr of (formData.crudResources ?? [])) {
    const ops = cr.ops.length > 0 ? cr.ops.join(",") : "all";
    lines.push(`[CRUD:${cr.resource}] endpoint:${cr.baseEndpoint || "?"} ops:${ops}`);
    if (cr.idField.trim()) lines.push(`[CRUD:${cr.resource}:ID] ${cr.idField.trim()}`);
    if (cr.queryParams.trim()) lines.push(`[CRUD:${cr.resource}:PARAMS] ${cr.queryParams.trim()}`);
  }
  const auth = formData.authContext;
  if (auth) {
    if ((auth.roles ?? []).length > 0) lines.push(`[AUTH:ROLES] ${auth.roles.join(" | ")}`);
    if ((auth.passwordPolicy ?? "").trim()) lines.push(`[AUTH:PASSWORD_POLICY] ${auth.passwordPolicy.trim()}`);
    if ((auth.maxAttempts ?? "").trim()) lines.push(`[AUTH:MAX_ATTEMPTS] ${auth.maxAttempts.trim()}`);
    if ((auth.sessionDuration ?? "").trim()) lines.push(`[AUTH:SESSION] ${auth.sessionDuration.trim()}`);
    if ((auth.mfaType ?? "").trim()) lines.push(`[AUTH:MFA_TYPE] ${auth.mfaType.trim()}`);
    if ((auth.protectedResources ?? []).length > 0) lines.push(`[AUTH:PROTECTED] ${auth.protectedResources.join(" | ")}`);
  }
  if (selectedScopeIds.length > 0) {
    for (const id of selectedScopeIds) {
      const feat = SCOPE_FEATURES.find(f => f.id === id);
      if (feat) lines.push(`[SCOPE:${feat.title}] ${feat.examples}`);
    }
  }
  return lines.join("\n");
}

function computeQualityScore(formData: TestFormData, scopeSize: number): number {
  let score = 0;
  score += Math.min(formData.fields.length, 3) * 15;
  const totalValid = Object.values(formData.validValues).flat().length;
  const totalInvalid = Object.values(formData.invalidValues).flat().length;
  score += Math.min(totalValid, 3) * 8;
  score += Math.min(totalInvalid, 3) * 8;
  score += Math.min(formData.businessRules.length, 2) * 4;
  const hasMin = Object.values(formData.minBoundary).some(v => v.trim());
  const hasMax = Object.values(formData.maxBoundary).some(v => v.trim());
  const hasOob = Object.values(formData.outOfBounds).some(v => v.trim());
  if (hasMin) score += 6;
  if (hasMax) score += 6;
  if (hasOob) score += 5;
  const fileCount = (formData.fileInputs ?? []).length;
  score += Math.min(fileCount, 2) * 10;
  const hasFileFormats = (formData.fileInputs ?? []).some(f => f.acceptedFormats.length > 0 || f.rejectedFormats.length > 0);
  if (hasFileFormats) score += 5;
  if ((formData.errorMessages ?? []).length > 0) score += 5;
  if ((formData.conditionalFlows ?? []).length > 0) score += 5;
  if ((formData.steps ?? []).length > 0) score += 5;
  if ((formData.paymentGateways ?? []).length > 0) score += 5;
  if ((formData.dbConstraints ?? []).length > 0) score += 5;
  score += Math.min(scopeSize, 4) * 3;
  return Math.min(score, 100);
}

// ─── Token Budget ─────────────────────────────────────────────────────────────

/** Extrait la taille nominale (en milliards) du modèle depuis son nom Ollama.
 *  Exemples : "qwen2.5:7b" → 7, "llama3.2:3b" → 3, "phi3:3.8b" → 3.8
 */
function inferModelSize(model: string): number {
  const m = model.toLowerCase();
  const match = m.match(/[:\-_](\d+(?:\.\d+)?)\s*b/);
  if (match) return parseFloat(match[1]);
  if (m.includes("3b") || m.includes("3.8b") || m.includes("phi")) return 3;
  if (m.includes("7b") || m.includes("8b"))  return 7;
  if (m.includes("13b") || m.includes("14b")) return 14;
  if (m.includes("32b") || m.includes("34b")) return 32;
  if (m.includes("70b") || m.includes("72b")) return 70;
  return 0; // inconnu
}

/**
 * Seuils (tokens formContext) calibrés sur les num_ctx réels de ollama-client.ts :
 *   3B  → num_ctx 3072  → budget ~600
 *   7B  → num_ctx 6144  → budget ~1500
 *   14B → num_ctx 6144  → budget ~1800
 *   32B → num_ctx 8192  → budget ~3000
 *   inconnu → conservateur 900
 */
function getModelTokenThresholds(model: string): {
  ok: number; warning: number; max: number; ctxWindow: number;
} {
  const size = inferModelSize(model);
  if (size > 0  && size <= 4)  return { ok: 400,  warning: 600,  max: 800,  ctxWindow: 3072 };
  if (size > 4  && size <= 9)  return { ok: 800,  warning: 1500, max: 2000, ctxWindow: 6144 };
  if (size > 9  && size <= 20) return { ok: 1000, warning: 1800, max: 2400, ctxWindow: 6144 };
  if (size > 20)               return { ok: 1500, warning: 3000, max: 4000, ctxWindow: 8192 };
  return { ok: 600, warning: 900, max: 1200, ctxWindow: 4096 };
}

/** ~4 chars/token (tokenisation Qwen/Llama) */
function estimateTokens(text: string): number {
  return Math.ceil((text ?? "").length / 4);
}

export interface TokenBudgetResult {
  total: number;
  status: "ok" | "warning" | "danger";
  thresholds: { ok: number; warning: number; max: number; ctxWindow: number };
  breakdown: Record<string, number>;
}

function computeTokenBudget(
  formData: TestFormData,
  selectedScopeIds: string[],
  model: string,
): TokenBudgetResult {
  const thresholds = getModelTokenThresholds(model);
  const b: Record<string, number> = {
    scope: 0, fields: 0, values: 0, rules: 0, boundaries: 0,
    files: 0, errors: 0, flows: 0, steps: 0, payment: 0,
    auth: 0, crud: 0, db: 0,
  };

  // Scope
  for (const id of selectedScopeIds) {
    const feat = SCOPE_FEATURES.find(f => f.id === id);
    if (feat) b.scope += estimateTokens(`[SCOPE:${feat.title}] ${feat.examples}`);
  }

  // Fields
  if (formData.fields.length > 0) {
    const str = formData.fields.map(f => `${f.name}[${f.type}]${f.required ? "*" : ""}`).join(", ");
    b.fields = estimateTokens(`FIELDS: ${str}`);
  }

  // Valid / Invalid / Options
  for (const [k, v] of Object.entries(formData.validValues))
    b.values += estimateTokens(`[VALID:${k}] ${v.join(" | ")}`);
  for (const [k, v] of Object.entries(formData.invalidValues))
    b.values += estimateTokens(`[INVALID:${k}] ${v.join(" | ")}`);
  for (const [k, opts] of Object.entries(formData.fieldOptions ?? {}))
    if (opts.length > 0) b.values += estimateTokens(`[OPTIONS:${k}] ${opts.join(" | ")}`);

  // Business rules
  if (formData.businessRules.length > 0)
    b.rules = estimateTokens(`[RULES] ${formData.businessRules.join(" | ")}`);

  // Boundaries
  for (const field of formData.fields) {
    const min = formData.minBoundary[field.name] ?? "";
    const max = formData.maxBoundary[field.name] ?? "";
    const oob = formData.outOfBounds[field.name] ?? "";
    if (min) b.boundaries += estimateTokens(`MIN:${field.name}: ${min}`);
    if (max) b.boundaries += estimateTokens(`MAX:${field.name}: ${max}`);
    if (oob) b.boundaries += estimateTokens(`OUT_OF_BOUNDS:${field.name}: ${oob}`);
  }

  // File inputs
  for (const fi of (formData.fileInputs ?? []))
    b.files += estimateTokens(
      `[FILE:${fi.name}] ` +
      fi.acceptedFormats.join(",") + fi.rejectedFormats.join(",") +
      fi.maxSizeLabel + fi.minSizeLabel + fi.mimeNote
    );

  // Error messages
  for (const em of (formData.errorMessages ?? []))
    b.errors += estimateTokens(`[ERROR_MSG:${em.fieldName}:${em.position}] "${em.text}"`);

  // Conditional flows
  for (const cf of (formData.conditionalFlows ?? []))
    b.flows += estimateTokens(`[COND:${cf.id}] IF(${cf.condition}) → TRUE:${cf.trueBranch} | FALSE:${cf.falseBranch}`);

  // Steps
  for (const s of (formData.steps ?? []))
    b.steps += estimateTokens(`${s.id}(${s.label})[${s.requiredFields.join(",")}]`);

  // Payment gateways — les plus lourdes
  for (const pg of (formData.paymentGateways ?? []))
    b.payment += estimateTokens([
      `[PAYMENT:${pg.name}] mode:${pg.mode} method:${pg.paymentMethod}`,
      pg.scenarios.join("|"),
      (pg.fieldsToTest ?? []).join("|"),
      pg.notes,
    ].join(" "));

  // Auth context
  const auth = formData.authContext;
  if (auth) {
    b.auth = estimateTokens([
      auth.roles.join("|"),
      auth.passwordPolicy, auth.maxAttempts,
      auth.sessionDuration, auth.mfaType,
      auth.protectedResources.join("|"),
    ].join(" "));
  }

  // CRUD
  for (const cr of (formData.crudResources ?? []))
    b.crud += estimateTokens(`[CRUD:${cr.resource}] ${cr.baseEndpoint} ${cr.ops.join(",")} ${cr.queryParams}`);

  // DB constraints
  for (const dc of (formData.dbConstraints ?? []))
    b.db += estimateTokens(`[DB:${dc.column}] ${dc.notNull ? "NOT NULL" : ""} ${dc.unique ? "UNIQUE" : ""} ${dc.maxLength}`);

  const total = Object.values(b).reduce((a, v) => a + v, 0);
  const status: TokenBudgetResult["status"] =
    total <= thresholds.ok ? "ok" :
    total <= thresholds.warning ? "warning" :
    "danger";

  return { total, status, thresholds, breakdown: b };
}

// ─── useInlineTranslation ─────────────────────────────────────────────────────

function useInlineTranslation(text: string, targetLang: string, debounceMs = 800) {
  const [translated, setTranslated] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (accepted) { setAccepted(false); setTranslated(""); return; }
    if (!TRANSLATION_ENABLED) { setTranslated(""); setLoading(false); return; }
    if (!text.trim() || !targetLang) {
      if (timerRef.current) clearTimeout(timerRef.current);
      setTranslated("");
      setLoading(false);
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    setLoading(true);
    timerRef.current = setTimeout(async () => {
      try {
        const detectedSrc = await detectLanguage(text);
        if (detectedSrc === targetLang) {
          setTranslated("");
          setLoading(false);
          return;
        }
        const result = await translateText(text, targetLang);
        // si la traduction est identique au texte source, ne pas afficher
        if (result.trim().toLowerCase() === text.trim().toLowerCase()) {
          setTranslated("");
        } else {
          setTranslated(result);
        }
      } catch {
        setTranslated("");
      } finally {
        setLoading(false);
      }
    }, debounceMs);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [text, targetLang, debounceMs]);

  const accept = () => setAccepted(true);
  return { translated, loading, accept };
}

// ─── InlineTranslationHint ────────────────────────────────────────────────────

function InlineTranslationHint({ translated, loading, targetLang, onAccept, onRevert }: {
  translated: string; loading: boolean; targetLang: string; onAccept?: (value: string) => void; onRevert?: () => void;
}) {
  const langLabel = SUPPORTED_LANGUAGES.find(l => l.code === targetLang)?.label ?? targetLang;
  if (!loading && !translated && !onRevert) return null;
  return (
    <div style={{ fontSize: 10, color: "#1d4ed8", background: "#eff6ff", border: "1px solid #e9d5ff", borderRadius: 6, padding: "4px 9px", marginTop: 3, display: "flex", alignItems: "center", gap: 6 }}>
      {loading
        ? <><span style={{ animation: "qa-spin 0.7s linear infinite", display: "inline-block", width: 8, height: 8, border: "1.5px solid #1d4ed8", borderTopColor: "transparent", borderRadius: "50%" }} /><span style={{ color: "#60a5fa" }}>traduction…</span></>
        : onRevert
          ? <>
              <span>✦</span>
              <span style={{ color: "#60a5fa", flex: 1 }}>traduction appliquée → {langLabel}</span>
              <button onClick={onRevert} style={{ marginLeft: 4, padding: "2px 8px", border: "1px solid #93c5fd", borderRadius: 5, background: "#fff", color: "#1d4ed8", fontWeight: 800, fontSize: 10, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap", flexShrink: 0 }}>
                ✗ Annuler
              </button>
            </>
          : <>
              <span>✦</span>
              <span style={{ fontStyle: "italic", flex: 1 }}>{translated}</span>
              <span style={{ color: "#60a5fa" }}>→ {langLabel}</span>
              {onAccept && (
                <button onClick={() => onAccept(translated)} style={{ marginLeft: 4, padding: "2px 8px", border: "none", borderRadius: 5, background: "#1d4ed8", color: "#fff", fontWeight: 800, fontSize: 10, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap", flexShrink: 0 }}>
                  ✔ Utiliser
                </button>
              )}
            </>
      }
    </div>
  );
}

// ─── SanitizerInlineWarning ───────────────────────────────────────────────────

function SanitizerInlineWarning({ offending, category }: { offending: string; category: string }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 7, background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 8, padding: "7px 10px", marginTop: 2 }}>
      <span style={{ fontSize: 14, lineHeight: 1, flexShrink: 0 }}>⚠️</span>
      <span style={{ fontSize: 11, color: "#92400e", lineHeight: 1.5 }}>
        <strong style={{ color: "#c2410c" }}>"{offending}"</strong>{" "}ne peut pas être utilisé ({category}).{" "}Veuillez reformuler cette valeur — si elle n'est pas corrigée, elle sera automatiquement supprimée à l'enregistrement.
      </span>
    </div>
  );
}

// ─── TagInput ─────────────────────────────────────────────────────────────────

interface TagInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder: string;
  tagColor: "green" | "red" | "amber" | "indigo";
  id?: string;
  translated?: boolean;
  targetLang?: string;
  onSanitizerWarning?: (w: import("./useSanitizer").SanitizerWarning | null) => void;
}

function TagInput({ tags, onChange, placeholder, tagColor, id, translated, targetLang, onSanitizerWarning }: TagInputProps) {
  const cm = {
    green: { accent: "#0f766e", light: "#f0fdf4", border: "#86efac", text: "#166534" },
    red: { accent: "#ef4444", light: "#fef2f2", border: "#fca5a5", text: "#991b1b" },
    amber: { accent: "#f59e0b", light: "#fefce8", border: "#fde047", text: "#854d0e" },
    indigo: { accent: "#3b82f6", light: "#eff6ff", border: "#93c5fd", text: "#3730a3" },
  }[tagColor];

  const [raw, setRaw] = useState(tags.join("\n"));
  const prevKey = useRef(tags.join("||"));
  const { sanitizeOnChange } = useSanitizer();
  const [originalLine, setOriginalLine] = useState<string | null>(null);

  // dernière ligne en cours de frappe (non encore validée)
  const lastLine = raw.split("\n").pop()?.trim() ?? "";
  const { translated: lineTr, loading: lineLoading, accept: acceptLine } = useInlineTranslation(
    originalLine === null ? lastLine : "", targetLang ?? "", 800
  );

  useEffect(() => {
    const key = tags.join("||");
    if (prevKey.current !== key) {
      prevKey.current = key;
      setRaw(tags.join("\n"));
    }
  }, [tags]);

  const handleChange = (val: string) => {
    setRaw(val);
    setOriginalLine(null);
    const parsed = [...new Set(val.split("\n").map(l => l.trim()).filter(Boolean))];
    const { cleaned, warnings } = sanitizeOnChange(parsed);
    if (onSanitizerWarning) onSanitizerWarning(warnings[0] ?? null);
    onChange(cleaned);
  };

  return (
    <div style={{ position: "relative" }}>
      <textarea
        id={id}
        value={raw}
        rows={Math.max(tags.length + 1, 2)}
        onChange={e => handleChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: "100%", boxSizing: "border-box",
          border: `1.5px solid ${translated ? "#3b82f6" : tags.length > 0 ? cm.border : "#e2e8f0"}`,
          borderRadius: 9, padding: "8px 12px",
          fontSize: 12, fontFamily: "inherit", color: "#1a202c",
          background: translated ? "#eff6ff" : tags.length > 0 ? cm.light : "#fff",
          resize: "vertical", outline: "none", lineHeight: 1.8,
          transition: "border-color .15s, background .15s",
        }}
        onFocus={e => { e.currentTarget.style.borderColor = translated ? "#3b82f6" : cm.accent; }}
        onBlur={e => { e.currentTarget.style.borderColor = translated ? "#3b82f6" : tags.length > 0 ? cm.border : "#e2e8f0"; }}
      />
      <div style={{ display: "flex", gap: 4, position: "absolute", top: 7, right: 9 }}>
        {translated && (
          <span style={{ fontSize: 9, fontWeight: 800, background: "#3b82f620", color: "#1d4ed8", border: "1px solid #3b82f640", borderRadius: 10, padding: "1px 6px", pointerEvents: "none" }}>✦ traduit</span>
        )}
        {tags.length > 0 && (
          <span style={{ fontSize: 10, fontWeight: 600, background: cm.light, color: cm.text, border: `1px solid ${cm.border}`, borderRadius: 10, padding: "1px 7px", pointerEvents: "none" }}>{tags.length}</span>
        )}
      </div>
      {targetLang && (lastLine || originalLine !== null) && (
        <InlineTranslationHint
          translated={lineTr}
          loading={lineLoading}
          targetLang={targetLang}
          onAccept={v => {
            const orig = raw.split("\n").pop()?.trim() ?? "";
            setOriginalLine(orig);
            const lines = raw.split("\n");
            lines[lines.length - 1] = v;
            const newRaw = lines.join("\n");
            setRaw(newRaw);
            const parsed = [...new Set(newRaw.split("\n").map(l => l.trim()).filter(Boolean))];
            const { cleaned, warnings } = sanitizeOnChange(parsed);
            if (onSanitizerWarning) onSanitizerWarning(warnings[0] ?? null);
            onChange(cleaned);
            acceptLine();
          }}
          onRevert={originalLine !== null ? () => {
            const lines = raw.split("\n");
            lines[lines.length - 1] = originalLine;
            const newRaw = lines.join("\n");
            setRaw(newRaw);
            setOriginalLine(null);
            const parsed = [...new Set(newRaw.split("\n").map(l => l.trim()).filter(Boolean))];
            const { cleaned, warnings } = sanitizeOnChange(parsed);
            if (onSanitizerWarning) onSanitizerWarning(warnings[0] ?? null);
            onChange(cleaned);
          } : undefined}
        />
      )}
    </div>
  );
}

// ─── StructuredInput ──────────────────────────────────────────────────────────

function StructuredInput({ id, label, hint, placeholder, value, onChange, translated, targetLang }: {
  id: string; label: string; hint: string; placeholder: string; value: string; onChange: (v: string) => void; translated?: boolean; targetLang?: string;
}) {
  const hasValue = value.trim().length > 0;
  const { checkString } = useSanitizer();
  const [warning, setWarning] = useState<import("./useSanitizer").SanitizerWarning | null>(null);
  const [originalValue, setOriginalValue] = useState<string | null>(null);
  const { translated: inlineTr, loading: inlineLoading, accept: acceptInline } = useInlineTranslation(
    originalValue === null ? value : "", targetLang ?? "", 800
  );

  const handleChange = (v: string) => {
    setOriginalValue(null);
    const { warning: w } = checkString(v);
    setWarning(w);
    onChange(v);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <label htmlFor={id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.08em" }}>
        {label}
        {translated && <span style={{ fontSize: 9, fontWeight: 800, background: "#3b82f620", color: "#1d4ed8", border: "1px solid #3b82f640", borderRadius: 10, padding: "1px 6px", textTransform: "none", letterSpacing: 0 }}>✦ traduit</span>}
      </label>
      <input
        id={id} value={value} onChange={e => handleChange(e.target.value)} placeholder={placeholder}
        style={{
          padding: "9px 12px",
          border: `1.5px solid ${warning ? "#f97316" : translated ? "#3b82f6" : hasValue ? "#0f766e55" : "#e2e8f0"}`,
          borderRadius: 9, fontSize: 12, color: "#1a202c",
          background: warning ? "#fff7ed" : translated ? "#eff6ff" : hasValue ? "#f0fdf4" : "#fff",
          fontFamily: "inherit", outline: "none", transition: "all .15s",
        }}
        onFocus={e => { e.currentTarget.style.borderColor = warning ? "#f97316" : translated ? "#3b82f6" : "#0f766e"; e.currentTarget.style.boxShadow = `0 0 0 3px ${warning ? "#f9731615" : translated ? "#3b82f610" : "#0f766e10"}`; }}
        onBlur={e => { e.currentTarget.style.borderColor = warning ? "#f97316" : translated ? "#3b82f6" : hasValue ? "#0f766e55" : "#e2e8f0"; e.currentTarget.style.boxShadow = "none"; }}
      />
      {warning && <SanitizerInlineWarning offending={warning.offending} category={warning.category} />}
      {targetLang && (value || originalValue !== null) && (
        <InlineTranslationHint
          translated={inlineTr}
          loading={inlineLoading}
          targetLang={targetLang}
          onAccept={v => { setOriginalValue(value); onChange(v); acceptInline(); }}
          onRevert={originalValue !== null ? () => { onChange(originalValue); setOriginalValue(null); } : undefined}
        />
      )}
      <div style={{ fontSize: 10, color: "#94a3b8", lineHeight: 1.5 }}>{hint}</div>
    </div>
  );
}

// ─── QualityBar ───────────────────────────────────────────────────────────────

function QualityBar({ score }: { score: number }) {
  const color = score < 35 ? "#ef4444" : score < 65 ? "#f59e0b" : "#0d9488";
  const label =
    score < 35 ? "Commencez par déclarer les entrées testées (champs ou fichiers)" :
      score < 65 ? "Bien — ajoutez des valeurs valides et invalides" :
        score < 85 ? "Bon contexte — précisez les limites numériques si possible" :
          "Excellent — le modèle générera des TCs très précis";
  return (
    <div style={{ padding: "10px 14px", background: color + "10", border: `1px solid ${color}30`, borderRadius: 9 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, fontWeight: 700, color, marginBottom: 6 }}>
        <span>Qualité du contexte</span><span>{score}%</span>
      </div>
      <div style={{ height: 4, background: "#e2e8f0", borderRadius: 3, overflow: "hidden", marginBottom: 6 }}>
        <div style={{ height: "100%", width: `${score}%`, background: color, borderRadius: 3, transition: "width .4s ease, background .4s" }} />
      </div>
      <div style={{ fontSize: 10, color: "#64748b", lineHeight: 1.5 }}>{label}</div>
    </div>
  );
}

// ─── ConfirmRemoveButton ───────────────────────────────────────────────────────
// Bouton "×" qui exige une confirmation avant d'exécuter une suppression/réinitialisation.
// Premier clic → arme la confirmation (✓ / ✗). Deuxième clic sur ✓ → exécute onConfirm.

function ConfirmRemoveButton({ onConfirm, title }: { onConfirm: () => void; title?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={title || "Supprimer"}
        style={{
          width: 24, height: 24, border: "1px solid #fca5a5", borderRadius: 6,
          background: "#fef2f2", color: "#991b1b", cursor: "pointer", fontSize: 12,
          fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
        }}
      >×</button>
      <ConfirmDeleteModal
        open={open}
        title={title || "Supprimer ?"}
        message="Cette action est irréversible."
        onCancel={() => setOpen(false)}
        onConfirm={() => { onConfirm(); setOpen(false); }}
      />
    </>
  );
}

// ─── SectionDivider ───────────────────────────────────────────────────────────

function SectionDivider({ label, color, bg, border }: { label: string; color: string; bg: string; border: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <div style={{ flex: 1, height: 1, background: "#e2e8f0" }} />
      <span style={{ fontSize: 11, fontWeight: 800, color, background: bg, border: `1px solid ${border}`, borderRadius: 20, padding: "3px 12px", whiteSpace: "nowrap" }}>{label}</span>
      <div style={{ flex: 1, height: 1, background: "#e2e8f0" }} />
    </div>
  );
}

// ─── TranslationProgressBar ───────────────────────────────────────────────────

function TranslationProgressBar({ progress, status, targetLang }: { progress: number; status: TranslationStatus; targetLang: string }) {
  const langLabel = SUPPORTED_LANGUAGES.find(l => l.code === targetLang)?.label ?? targetLang;
  if (status === "idle") return null;
  const color = status === "error" ? "#ef4444" : status === "done" ? "#0d9488" : "#3b82f6";
  const bg = status === "error" ? "#fef2f2" : status === "done" ? "#f0fdf4" : "#eff6ff";
  const border = status === "error" ? "#fecaca" : status === "done" ? "#bbf7d0" : "#bfdbfe";
  return (
    <div style={{ padding: "8px 12px", background: bg, border: `1px solid ${border}`, borderRadius: 8, display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 11, fontWeight: 700, color }}>
          {status === "loading" && `✦ Traduction en cours → ${langLabel}…`}
          {status === "done" && `✔ Traduit en ${langLabel}`}
          {status === "error" && "✗ Erreur de traduction"}
        </span>
        <span style={{ fontSize: 10, color: "#64748b", fontWeight: 600 }}>{progress}%</span>
      </div>
      <div style={{ height: 3, background: "#e2e8f0", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${progress}%`, background: color, borderRadius: 3, transition: "width .3s ease" }} />
      </div>
    </div>
  );
}

// ─── SanitizerErrorBanner ─────────────────────────────────────────────────────
// ✅ MODIFIÉ : Affiche le token problématique extrait du message SanitizationError backend
// Le formulaire reste ouvert, les données saisies sont préservées

const CATEGORY_LABELS: Record<string, string> = {
  prompt_injection: "injection de prompt",
  role_playing_attacks: "usurpation de rôle",
  instruction_override: "override d'instruction",
  llm_delimiter_tokens: "token délimiteur LLM",
  data_exfiltration: "tentative d'exfiltration",
  srs_override: "contournement SRS",
  encoding_obfuscation: "obfuscation / encodage",
  output_format_manipulation: "manipulation de format",
  null_like_values: "valeur nulle",
};

function parseSanitizerError(message: string): { token: string | null; category: string | null; categoryLabel: string | null } {
  // Format backend : [InputSanitizer] Input rejeté — catégorie "X" : token "Y" détecté.
  const tokenMatch = message.match(/token\s+"([^"]+)"/i);
  const categoryMatch = message.match(/catégorie\s+"([^"]+)"/i);
  const token = tokenMatch?.[1] ?? null;
  const category = categoryMatch?.[1] ?? null;
  const categoryLabel = category ? (CATEGORY_LABELS[category] ?? category) : null;
  return { token, category, categoryLabel };
}

// ✅ NOUVEAU : état de génération pour le bouton Générer
type GenerationState = "idle" | "loading" | "error";

function SanitizerErrorBanner({ message, onClose }: { message: string; onClose: () => void }) {
  const { token, categoryLabel } = parseSanitizerError(message);

  // Choisir l'icône et le titre selon la catégorie
  const isSanitizerError = message.includes("InputSanitizer") || message.includes("rejeté") || message.includes("catégorie");

  return (
    <div style={{
      fontSize: 11, color: "#7c2d12", marginTop: 6, padding: "14px 16px",
      background: "#fff7ed", borderRadius: 10, border: "2px solid #fed7aa",
      width: "100%", display: "flex", alignItems: "flex-start", gap: 10,
      boxSizing: "border-box" as const,
      // ✅ Animation d'entrée légère pour attirer l'attention
      animation: "form-slide-in 0.25s ease-out",
    }}>
      <span style={{ fontSize: 20, flexShrink: 0, marginTop: 1 }}>🚫</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Titre */}
        <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 8, color: "#9a3412" }}>
          {isSanitizerError ? "Valeur rejetée par le filtre de sécurité" : "Erreur lors de la génération"}
        </div>

        {/* Token problématique — affiché uniquement si extrait avec succès */}
        {token && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" as const }}>
            <span style={{ fontSize: 11, color: "#92400e" }}>Mot / phrase problématique :</span>
            <code style={{
              fontSize: 13, fontWeight: 800, fontFamily: "monospace",
              background: "#fef3c7", color: "#b45309",
              border: "2px solid #fcd34d", borderRadius: 6,
              padding: "3px 12px", letterSpacing: "0.02em",
              // ✅ Mise en évidence renforcée
              boxShadow: "0 1px 4px rgba(180,83,9,0.15)",
            }}>
              {token}
            </code>
            {categoryLabel && (
              <span style={{
                fontSize: 10, fontWeight: 700,
                background: "#fee2e2", color: "#b91c1c",
                border: "1px solid #fca5a5", borderRadius: 4,
                padding: "2px 8px",
              }}>
                {categoryLabel}
              </span>
            )}
          </div>
        )}

        {/* Message d'action */}
        <div style={{ fontSize: 11, color: "#92400e", lineHeight: 1.7 }}>
          {isSanitizerError
            ? <>
              Retirez ou reformulez cette valeur dans le formulaire ci-dessous,
              puis cliquez à nouveau sur <strong>✦ Générer les cas de test</strong>.
              <br />
              <span style={{ color: "#b45309", fontWeight: 700 }}>Vos données sont préservées — aucune saisie n'a été perdue.</span>
            </>
            : <>
              {/* ✅ On affiche le vrai message d'erreur (timeout, backend hors ligne, etc.)
                  au lieu d'un texte générique qui masquait la cause réelle. */}
              {message}
              <br />
              <span style={{ color: "#b45309", fontWeight: 700 }}>Vos données sont préservées — vous pouvez réessayer.</span>
            </>
          }
        </div>
      </div>

      {/* Bouton fermer */}
      <button
        onClick={onClose}
        style={{
          marginLeft: "auto", background: "none", border: "none", cursor: "pointer",
          color: "#9a3412", fontSize: 20, lineHeight: 1, padding: "0 4px", flexShrink: 0,
          opacity: 0.7, transition: "opacity .15s",
        }}
        onMouseEnter={e => (e.currentTarget.style.opacity = "1")}
        onMouseLeave={e => (e.currentTarget.style.opacity = "0.7")}
        aria-label="Fermer"
      >×</button>
    </div>
  );
}

// ─── TokenLiveBar ─────────────────────────────────────────────────────────────
// Barre de tokenisation persistante, visible sur tous les onglets du formulaire.
// Se met à jour à chaque modification du formulaire (debounce géré par le parent).
// Affiche : progression animée, status (ok/warning/danger), breakdown top-3, spinner loading.

interface TokenLiveBarProps {
  tokenBudget: TokenBudgetResult;
  realTokenCount: number | null;
  tokenCountLoading: boolean;
  tokenCountEstimated: boolean;
  model: string;
}

function TokenLiveBar({ tokenBudget, realTokenCount, tokenCountLoading, tokenCountEstimated, model }: TokenLiveBarProps) {
  const { total, status, thresholds, breakdown } = tokenBudget;
  const displayTotal = realTokenCount ?? total;
  const isEstimate   = realTokenCount === null || tokenCountEstimated;

  const color  = status === "ok" ? "#0f766e" : status === "warning" ? "#b45309" : "#dc2626";
  const bg     = status === "ok" ? "#f0fdf9" : status === "warning" ? "#fffbeb" : "#fef2f2";
  const border = status === "ok" ? "#a7f3d0" : status === "warning" ? "#fde68a" : "#fecaca";
  const icon   = status === "ok" ? "✓" : status === "warning" ? "⚠" : "✗";

  const pct = Math.min(Math.round((displayTotal / thresholds.max) * 100), 100);

  // Top 3 composantes non-nulles triées par poids
  const topItems = Object.entries(breakdown)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3);

  // Label explicatif selon status
  const statusLabel =
    status === "ok"      ? "Budget OK" :
    status === "warning" ? "Contexte chargé — risque de troncature" :
                           `Trop lourd — max ${thresholds.max} tok`;

  return (
    <div
      style={{
        borderBottom: `1.5px solid ${border}`,
        background: bg,
        padding: "7px 22px",
        display: "flex",
        flexDirection: "column",
        gap: 5,
        // Pulsation douce quand danger pour attirer l'attention
        animation: status === "danger" ? "form-token-pulse 2s ease-in-out infinite" : "none",
      }}
    >
      {/* ── Ligne principale : barre + token count ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {/* Spinner si calcul en cours */}
        {tokenCountLoading && (
          <span style={{
            width: 10, height: 10, border: `1.5px solid ${color}`, borderTopColor: "transparent",
            borderRadius: "50%", animation: "qa-spin 0.7s linear infinite", display: "inline-block", flexShrink: 0,
          }} />
        )}

        {/* Icône status */}
        {!tokenCountLoading && (
          <span style={{ fontSize: 11, fontWeight: 800, color, flexShrink: 0 }}>{icon}</span>
        )}

        {/* Barre de progression */}
        <div style={{ flex: 1, height: 5, background: "#e2e8f0", borderRadius: 4, overflow: "hidden", position: "relative" }}>
          <div
            style={{
              height: "100%",
              width: tokenCountLoading ? "100%" : `${pct}%`,
              background: tokenCountLoading
                ? "linear-gradient(90deg, transparent 0%, " + color + "60 50%, transparent 100%)"
                : color,
              borderRadius: 4,
              transition: tokenCountLoading ? "none" : "width .4s ease, background .3s",
              backgroundSize: tokenCountLoading ? "200% 100%" : undefined,
              animation: tokenCountLoading ? "form-token-scan 1.2s linear infinite" : "none",
            }}
          />
        </div>

        {/* Token count */}
        <span style={{ fontSize: 11, fontWeight: 800, color, flexShrink: 0, minWidth: 72, textAlign: "right" }}>
          {tokenCountLoading
            ? <span style={{ color: "#94a3b8", fontWeight: 600 }}>calcul…</span>
            : <>{isEstimate ? "~" : ""}{displayTotal}<span style={{ fontWeight: 500, color: "#94a3b8", fontSize: 10 }}> / {thresholds.max} tok</span></>
          }
        </span>

        {/* Badge status */}
        <span style={{
          fontSize: 9, fontWeight: 800,
          background: color + "18", color, border: `1px solid ${border}`,
          borderRadius: 6, padding: "2px 7px", flexShrink: 0, whiteSpace: "nowrap",
        }}>
          {statusLabel}
        </span>
      </div>

      {/* ── Breakdown top-3 — affiché seulement si warning ou danger ── */}
      {(status === "warning" || status === "danger") && topItems.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 9, color: "#94a3b8", fontWeight: 600, flexShrink: 0 }}>Top composantes :</span>
          {topItems.map(([key, val]) => {
            const ratio = displayTotal > 0 ? val / displayTotal : 0;
            return (
              <span key={key} style={{
                fontSize: 9, fontWeight: 700,
                background: "#fff", color,
                border: `1px solid ${border}`,
                borderRadius: 4, padding: "1px 8px",
                display: "inline-flex", alignItems: "center", gap: 4,
              }}>
                {key}
                <span style={{ opacity: 0.7 }}>{val}tok</span>
                <span style={{
                  display: "inline-block", width: `${Math.round(ratio * 40)}px`, minWidth: 4,
                  height: 3, background: color, borderRadius: 2, opacity: 0.5,
                }} />
              </span>
            );
          })}
          {isEstimate && (
            <span style={{ fontSize: 9, color: "#94a3b8", fontStyle: "italic" }}>
              {realTokenCount === null ? "(estimation locale — Nest inaccessible)" : "(estimation — tokenizer Python down)"}
            </span>
          )}
        </div>
      )}

      {/* ── Conseil si danger ── */}
      {status === "danger" && (
        <div style={{ fontSize: 10, color: "#b91c1c", fontWeight: 600, lineHeight: 1.5 }}>
          💡 Réduisez les scopes, raccourcissez les règles métier ou diminuez le nombre de valeurs valides/invalides.
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function AssistTest({ requirement, model, projectId, apiBaseUrl, onTCsGenerated, onClose, docLanguage, onError, externalError, actorId, actorName, liveGenerationLock }: AssistTestProps) {
  type Tab = "scope" | "entries" | "valid" | "invalid" | "boundary" | "summary";
  const TAB_ORDER: Tab[] = ["scope", "entries", "valid", "invalid", "boundary", "summary"];

  // ── Présence temps réel — Mode Signature ──────────────────────────────────
  // Signale aux AUTRES utilisateurs, dès l'ouverture de ce formulaire, que
  // cette exigence est en cours de configuration (avant même que la
  // génération ne démarre) — best-effort, sans verrou (voir POST
  // /llm/generation-presence). Le signal est retiré à la fermeture du
  // formulaire ; s'il se ferme APRÈS une génération réussie, l'événement
  // 'testcases' a déjà pris le relais côté page.tsx (voir handleProjectRealtimeEvent),
  // donc ce nettoyage tardif est sans effet sur le bandeau des autres.
  useEffect(() => {
    const base = apiBaseUrl || "/api/backend";
    const reqUUID = requirement.reqUUID;
    if (!reqUUID) return;
    const notify = (active: boolean) => {
      fetch(`${base}/llm/generation-presence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requirementId: reqUUID, projectId, actorId, actorName, genMode: "explicit", step: "form", active }),
      }).catch(() => { /* best-effort, silencieux */ });
    };
    notify(true);
    return () => notify(false);
  }, [apiBaseUrl, projectId, requirement.reqUUID, actorId, actorName]);

  const [formData, setFormData] = useState<TestFormData>({
    fields: [],
    validValues: {},
    invalidValues: {},
    businessRules: [],
    minBoundary: {},
    maxBoundary: {},
    outOfBounds: {},
    fileInputs: [],
    errorMessages: [],
    conditionalFlows: [],
    steps: [],
    paymentGateways: [],
    dbConstraints: [],
    crudResources: [],
    authContext: {
      roles: [],
      passwordPolicy: "",
      maxAttempts: "",
      sessionDuration: "",
      mfaType: "",
      protectedResources: [],
    },
    fieldOptions: {},
  });

  const update = useCallback(<K extends keyof TestFormData>(key: K, value: TestFormData[K]) => {
    setFormData(prev => ({ ...prev, [key]: value }));
  }, []);

  const eligibleFields = useMemo(
    () => formData.fields.filter(f => !isChoiceField(f.type)),
    [formData.fields]
  );
  const choiceFields = useMemo(
    () => formData.fields.filter(f => isChoiceField(f.type)),
    [formData.fields]
  );
  const hasEligibleFields = eligibleFields.length > 0;
  // tabs valid/invalid/boundary visibles si champs éligibles OU fichiers
  const hasAnyTestableEntries = hasEligibleFields || (formData.fileInputs ?? []).length > 0;

  // ── Translation state ─────────────────────────────────────────────────────
  const [targetLang, setTargetLang] = useState<string>(docLanguage ?? "fr");
  const [translationStatus, setTranslationStatus] = useState<TranslationStatus>("idle");
  const [translationProgress, setTranslationProgress] = useState(0);
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [translatedData, setTranslatedData] = useState<TestFormData | null>(null);

  // ✅ MODIFIÉ : generationError stocke le message d'erreur sanitizer
  // Il est SET par externalError (venant de page.tsx) ET jamais effacé par fermeture du formulaire
  const [generationError, setGenerationError] = useState<string | null>(null);

  // ✅ MODIFIÉ : état du bouton Générer (idle / loading / error)
  const [generationState, setGenerationState] = useState<GenerationState>("idle");
  const [tokenWarningPending, setTokenWarningPending] = useState(false);
  const [realTokenCount, setRealTokenCount]   = useState<number | null>(null);
  const [tokenCountLoading, setTokenCountLoading] = useState(false);
  const [tokenCountEstimated, setTokenCountEstimated] = useState(false);

  // ✅ MODIFIÉ : sync depuis l'erreur externe (page.tsx → formulaire)
  // Dès que externalError change et est non-null, on l'affiche ET on reset l'état du bouton
  useEffect(() => {
    if (externalError) {
      setGenerationError(externalError);
      setGenerationState("error");
    }
  }, [externalError]);

  const [isTranslated, setIsTranslated] = useState(false);

  useEffect(() => {
    if (!TRANSLATION_ENABLED) return;
    if (!requirement.reqDesc?.trim()) return;
    const sample = requirement.reqDesc.slice(0, 300);
    fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(sample)}&langpair=autodetect|ar${MYMEMORY_EMAIL_PARAM}`)
      .then(r => r.json())
      .then(data => {
        const fromMatches = data?.matches?.[0]?.["source-lang"] as string | undefined;
        if (fromMatches && fromMatches !== "autodetect" && fromMatches !== "ar") {
          const lang = fromMatches.split("-")[0].toLowerCase();
          setTargetLang(lang);
          return;
        }
        const arabicScore = (sample.match(/[\u0600-\u06FF]/g) || []).length;
        if (arabicScore > 5) { setTargetLang("ar"); return; }
        const scores: Record<string, number> = { fr: 0, it: 0, es: 0, de: 0, pt: 0, en: 0 };
        const patterns: Record<string, RegExp[]> = {
          fr: [/\bles\b/gi, /\bpour\b/gi, /\bavec\b/gi, /\bsont\b/gi, /\bune\b/gi],
          it: [/\bche\b/gi, /\bdella\b/gi, /\bsono\b/gi, /\bquesto\b/gi],
          es: [/\blos\b/gi, /\bpara\b/gi, /\btambién\b/gi, /\bnosotros\b/gi],
          de: [/\bder\b/gi, /\bdie\b/gi, /\bdas\b/gi, /\bund\b/gi, /\bfür\b/gi],
          pt: [/\bpara\b/gi, /\buma\b/gi, /\btambém\b/gi, /\bnão\b/gi],
          en: [/\bthe\b/gi, /\bshall\b/gi, /\bshould\b/gi, /\buser\b/gi, /\bmust\b/gi],
        };
        for (const [lang, regexes] of Object.entries(patterns)) {
          for (const re of regexes) scores[lang] += (sample.match(re) || []).length;
        }
        const [best, bestScore] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
        if (bestScore > 0) setTargetLang(best);
      })
      .catch(() => { });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requirement.reqDesc]);

  const updateWithReset = useCallback(<K extends keyof TestFormData>(key: K, value: TestFormData[K]) => {
    setFormData(prev => ({ ...prev, [key]: value }));
  }, []);

  const handleApplyTranslation = () => {
    if (!translatedData) return;
    setFormData(translatedData); setTranslatedData(null);
    setIsTranslated(false); setTranslationStatus("idle"); setTranslationProgress(0);
  };

  const handleDiscardTranslation = () => {
    setTranslatedData(null); setIsTranslated(false);
    setTranslationStatus("idle"); setTranslationProgress(0);
  };

  const displayData = (isTranslated && translatedData) ? translatedData : formData;

  // ── Scope ────────────────────────────────────────────────────────────────
  const [selectedScope, setSelectedScope] = useState<Set<string>>(new Set());
  const [confirmClearScope, setConfirmClearScope] = useState(false);
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set(["functional_tests"]));
  const toggleScope = (id: string) =>
    setSelectedScope(prev => {
      const n = new Set(prev);
      if (n.has(id)) {
        n.delete(id);
      } else {
        n.add(id);
      }
      return n;
    });
  const toggleCat = (id: string) => setExpandedCats(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const showFields = useMemo(() => hasFormScope(selectedScope) || !hasFileScope(selectedScope), [selectedScope]);
  const showFiles = useMemo(() => hasFileScope(selectedScope), [selectedScope]);
  const showErrors = useMemo(() => selectedScope.has("form_error_messages"), [selectedScope]);
  const showCondFlows = useMemo(() => selectedScope.has("business_conditional_flows") || selectedScope.has("business_state_transitions"), [selectedScope]);
  const showSteps = useMemo(() => selectedScope.has("journey_multi_step") || selectedScope.has("journey_prev_next") || selectedScope.has("journey_redirections"), [selectedScope]);
  const showApiContracts = useMemo(() => selectedScope.has("integration_payment"), [selectedScope]);
  const showAuth = useMemo(() => (
    selectedScope.has("auth_password_policy") || selectedScope.has("auth_login") || selectedScope.has("auth_mfa") ||
    selectedScope.has("auth_session") || selectedScope.has("auth_rate_limiting") || selectedScope.has("auth_password_reset") || selectedScope.has("auth_permissions")
  ), [selectedScope]);
  const showDbSchema = useMemo(() => selectedScope.has("integration_db_schema"), [selectedScope]);

  const [activeTab, setActiveTab] = useState<Tab>("scope");
  const [fieldDraft, setFieldDraft] = useState<{ name: string; label: string; type: FieldType; required: boolean }>({ name: "", label: "", type: "text", required: false });
  const [fieldError, setFieldError] = useState<string>("");
  const [customTypes, setCustomTypes] = useState<{ value: FieldType; label: string; hint: string; emoji: string }[]>([]);
  const [showCustomTypeForm, setShowCustomTypeForm] = useState(false);
  const [customTypeDraft, setCustomTypeDraft] = useState<{ value: string; label: string; hint: string; emoji: string }>({ value: "", label: "", hint: "", emoji: "" });

  useEffect(() => {
    try {
      const raw = localStorage.getItem(CUSTOM_TYPES_STORAGE_KEY);
      if (raw) { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) setCustomTypes(parsed); }
    } catch { }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(CUSTOM_TYPES_STORAGE_KEY, JSON.stringify(customTypes)); } catch { }
  }, [customTypes]);

  const allFieldTypes = useMemo(() => [...FIELD_TYPES, ...customTypes], [customTypes]);

  const addCustomType = () => {
    const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    let value = customTypeDraft.value.trim();
    const label = customTypeDraft.label.trim() || value || "custom";
    if (!value) value = normalize(label);
    if (!value) value = "custom";
    if (allFieldTypes.find(t => t.value.toLowerCase() === value.toLowerCase())) { setShowCustomTypeForm(true); return; }
    setCustomTypes(prev => [...prev, { value, label: customTypeDraft.label || value, hint: customTypeDraft.hint || "", emoji: customTypeDraft.emoji || "" }]);
    setCustomTypeDraft({ value: "", label: "", hint: "", emoji: "" });
    setShowCustomTypeForm(false);
  };

  const addField = () => {
    const name = fieldDraft.name.trim();
    const label = fieldDraft.label.trim() || name;
    if (!name) { setFieldError("Le nom du champ est obligatoire."); return; }
    if (formData.fields.find(f => f.name.toLowerCase() === name.toLowerCase())) { setFieldError(`Un champ "${name}" existe déjà.`); return; }
    setFieldError("");
    update("fields", [...formData.fields, { name, label, type: fieldDraft.type, required: fieldDraft.required }]);
    setFieldDraft({ name: "", label: "", type: "text", required: false });
  };

  const [dragFieldIndex, setDragFieldIndex] = useState<number | null>(null);
  const [dragOverFieldIndex, setDragOverFieldIndex] = useState<number | null>(null);

  const handleFieldDragStart = (i: number) => setDragFieldIndex(i);
  const handleFieldDragOver = (e: React.DragEvent, i: number) => { e.preventDefault(); setDragOverFieldIndex(i); };
  const handleFieldDrop = (i: number) => {
    if (dragFieldIndex === null || dragFieldIndex === i) { setDragFieldIndex(null); setDragOverFieldIndex(null); return; }
    const next = [...formData.fields];
    const [moved] = next.splice(dragFieldIndex, 1);
    next.splice(i, 0, moved);
    update("fields", next);
    setDragFieldIndex(null);
    setDragOverFieldIndex(null);
  };
  const handleFieldDragEnd = () => { setDragFieldIndex(null); setDragOverFieldIndex(null); };

  const removeField = (i: number) => {
    const field = formData.fields[i];
    update("fields", formData.fields.filter((_, idx) => idx !== i));
    if (field && isChoiceField(field.type)) {
      const next = { ...(formData.fieldOptions ?? {}) };
      delete next[field.name];
      update("fieldOptions", next);
    }
  };
  const updateFieldType = (i: number, type: FieldType) => {
    const next = [...formData.fields]; next[i] = { ...next[i], type }; update("fields", next);
  };

  // ── File inputs ───────────────────────────────────────────────────────────
  const [fileDraft, setFileDraft] = useState<FileDefinition>({ name: "", acceptedFormats: [], rejectedFormats: [], maxSizeLabel: "", minSizeLabel: "", mimeNote: "" });
  const [fileError, setFileError] = useState<string>("");
  const [fileDraftAccepted, setFileDraftAccepted] = useState<string>("");
  const [fileDraftRejected, setFileDraftRejected] = useState<string>("");

  const addFileInput = () => {
    const name = fileDraft.name.trim();
    if (!name) { setFileError("Le nom de l'entrée fichier est obligatoire."); return; }
    if ((formData.fileInputs ?? []).find(f => f.name.toLowerCase() === name.toLowerCase())) { setFileError(`Une entrée "${name}" existe déjà.`); return; }
    setFileError("");
    const accepted = fileDraftAccepted.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    const rejected = fileDraftRejected.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    update("fileInputs", [...(formData.fileInputs ?? []), { ...fileDraft, name, acceptedFormats: accepted, rejectedFormats: rejected }]);
    setFileDraft({ name: "", acceptedFormats: [], rejectedFormats: [], maxSizeLabel: "", minSizeLabel: "", mimeNote: "" });
    setFileDraftAccepted(""); setFileDraftRejected("");
  };
  const removeFileInput = (i: number) => update("fileInputs", (formData.fileInputs ?? []).filter((_, idx) => idx !== i));

  // ── Error messages ────────────────────────────────────────────────────────
  const [emDraft, setEmDraft] = useState<ErrorMessageDefinition & { selectedKeys: string[] }>({ fieldName: "", fieldNames: [], selectedKeys: [], text: "", position: "inline" });
  const [emError, setEmError] = useState<string>("");
  const addErrorMessage = () => {
    if (!emDraft.text.trim()) { setEmError("Le texte du message est obligatoire."); return; }
    setEmError("");
    const keys = emDraft.selectedKeys.length > 0 ? emDraft.selectedKeys : ["__global__"];
    const newEntries = keys.map(k => ({ ...emDraft, fieldName: k, fieldNames: keys, selectedKeys: undefined }));
    update("errorMessages", [...(formData.errorMessages ?? []), ...newEntries]);
    setEmDraft({ fieldName: "", fieldNames: [], selectedKeys: [], text: "", position: "inline" });
  };
  const removeErrorMessage = (i: number) => update("errorMessages", (formData.errorMessages ?? []).filter((_, idx) => idx !== i));

  // ── Conditional flows ─────────────────────────────────────────────────────
  const [cfDraft, setCfDraft] = useState<ConditionalFlow>({ id: "", condition: "", trueBranch: "", falseBranch: "" });
  const [cfError, setCfError] = useState<string>("");
  const [cfIdCounter, setCfIdCounter] = useState(1);
  const addConditionalFlow = () => {
    if (!cfDraft.condition.trim()) { setCfError("La condition est obligatoire."); return; }
    if (!cfDraft.trueBranch.trim()) { setCfError("La branche vraie est obligatoire."); return; }
    setCfError("");
    const id = cfDraft.id.trim() || `CF${cfIdCounter}`;
    setCfIdCounter(c => c + 1);
    update("conditionalFlows", [...(formData.conditionalFlows ?? []), { ...cfDraft, id }]);
    setCfDraft({ id: "", condition: "", trueBranch: "", falseBranch: "" });
  };
  const removeConditionalFlow = (i: number) => update("conditionalFlows", (formData.conditionalFlows ?? []).filter((_, idx) => idx !== i));

  // ── Steps ─────────────────────────────────────────────────────────────────
  const [stepDraft, setStepDraft] = useState<{ label: string; requiredFields: string[] }>({ label: "", requiredFields: [] });
  const toggleStepField = (name: string) => setStepDraft(p => ({
    ...p,
    requiredFields: p.requiredFields.includes(name) ? p.requiredFields.filter(f => f !== name) : [...p.requiredFields, name]
  }));
  const [stepError, setStepError] = useState<string>("");
  const [stepIdCounter, setStepIdCounter] = useState(1);
  const addStep = () => {
    if (!stepDraft.label.trim()) { setStepError("Le label de l'étape est obligatoire."); return; }
    setStepError("");
    const id = `S${stepIdCounter}`; setStepIdCounter(c => c + 1);
    const requiredFields = stepDraft.requiredFields;
    update("steps", [...(formData.steps ?? []), { id, label: stepDraft.label.trim(), requiredFields }]);
    setStepDraft({ label: "", requiredFields: [] });
  };
  const removeStep = (i: number) => update("steps", (formData.steps ?? []).filter((_, idx) => idx !== i));

  // ── Payment gateways ──────────────────────────────────────────────────────
  const PAYMENT_SCENARIOS: { id: PaymentScenario; label: string }[] = [
    { id: "accepted",     label: "Paiement accepté" },
    { id: "refused",      label: "Paiement refusé" },
    { id: "cancelled",    label: "Paiement annulé" },
    { id: "timeout",      label: "Timeout fournisseur" },
    { id: "confirmation", label: "Confirmation de transaction" },
  ];

  const PAYMENT_FIELDS: { id: PaymentField; label: string; emoji: string }[] = [
    { id: "card_number", label: "Numéro de carte",      emoji: "💳" },
    { id: "card_expiry", label: "Date d'expiration",    emoji: "📅" },
    { id: "card_cvv",    label: "CVV / CVE",            emoji: "🔒" },
    { id: "card_holder", label: "Détenteur de la carte",emoji: "👤" },
    { id: "iban",        label: "IBAN / RIB",           emoji: "🏦" },
    { id: "amount",      label: "Montant",              emoji: "💰" },
    { id: "currency",    label: "Devise",               emoji: "🌍" },
  ];

  type PgDraftType = {
    name: string; scenarios: PaymentScenario[]; amount: string; currency: string;
    mode: "sandbox" | "production"; paymentMethod: "card" | "iban" | "both";
    fieldsToTest: PaymentField[];
    notes: string;
  };
  const PG_EMPTY: PgDraftType = {
    name: "", scenarios: [], amount: "", currency: "EUR", mode: "sandbox",
    paymentMethod: "card", fieldsToTest: ["card_number", "card_expiry", "card_cvv", "card_holder"],
    notes: "",
  };
  const [pgDraft, setPgDraft] = useState<PgDraftType>(PG_EMPTY);
  const [pgError, setPgError] = useState<string>("");
  const togglePgScenario = (s: PaymentScenario) =>
    setPgDraft(p => ({ ...p, scenarios: p.scenarios.includes(s) ? p.scenarios.filter(x => x !== s) : [...p.scenarios, s] }));
  const togglePgField = (f: PaymentField) =>
    setPgDraft(p => ({ ...p, fieldsToTest: p.fieldsToTest.includes(f) ? p.fieldsToTest.filter(x => x !== f) : [...p.fieldsToTest, f] }));
  const addPaymentGateway = () => {
    const name = pgDraft.name.trim();
    if (!name) { setPgError("Le nom de la passerelle est obligatoire."); return; }
    if ((formData.paymentGateways ?? []).find(g => g.name.toLowerCase() === name.toLowerCase())) { setPgError(`Passerelle "${name}" déjà déclarée.`); return; }
    if (pgDraft.fieldsToTest.length === 0) { setPgError("Sélectionnez au moins un champ à tester."); return; }
    setPgError("");

    // Champs virtuels créés pour que les onglets Cas valides/Invalides/Limites affichent
    // les champs de la passerelle (numéro de carte, IBAN, montant) — l'utilisateur y saisit
    // ensuite ses valeurs valides/invalides/limites directement dans ces onglets.
    const cardKey = `${name}_numero_carte`;
    const ibanKey = `${name}_iban`;
    const amountKey = `${name}_montant`;
    const newFields: FieldDefinition[] = [];
    const needCard = pgDraft.paymentMethod === "card" || pgDraft.paymentMethod === "both";
    const needIBAN = pgDraft.paymentMethod === "iban" || pgDraft.paymentMethod === "both";
    const existingFieldNames = new Set(formData.fields.map(f => f.name));
    if (needCard && pgDraft.fieldsToTest.includes("card_number") && !existingFieldNames.has(cardKey))
      newFields.push({ name: cardKey, label: `Numéro de carte — ${name}`, type: "text" });
    if (needIBAN && pgDraft.fieldsToTest.includes("iban") && !existingFieldNames.has(ibanKey))
      newFields.push({ name: ibanKey, label: `IBAN / RIB — ${name}`, type: "text" });
    if (pgDraft.fieldsToTest.includes("amount") && !existingFieldNames.has(amountKey))
      newFields.push({ name: amountKey, label: `Montant — ${name}`, type: "number" });

    const gw: PaymentGateway = { name, scenarios: pgDraft.scenarios, amount: pgDraft.amount, currency: pgDraft.currency, mode: pgDraft.mode, paymentMethod: pgDraft.paymentMethod, fieldsToTest: pgDraft.fieldsToTest, notes: pgDraft.notes };
    update("paymentGateways", [...(formData.paymentGateways ?? []), gw]);
    if (newFields.length > 0) update("fields", [...formData.fields, ...newFields]);
    setPgDraft(PG_EMPTY);
  };
  const removePaymentGateway = (i: number) => update("paymentGateways", (formData.paymentGateways ?? []).filter((_, idx) => idx !== i));

  // ── DB constraints ────────────────────────────────────────────────────────
  const [dcDraft, setDcDraft] = useState<DbConstraint>({ column: "", notNull: false, unique: false, maxLength: "" });
  const [dcError, setDcError] = useState<string>("");
  const addDbConstraint = () => {
    if (!dcDraft.column.trim()) { setDcError("Le nom de la colonne est obligatoire."); return; }
    if ((formData.dbConstraints ?? []).find(d => d.column.toLowerCase() === dcDraft.column.toLowerCase())) { setDcError(`Colonne "${dcDraft.column}" déjà déclarée.`); return; }
    setDcError("");
    update("dbConstraints", [...(formData.dbConstraints ?? []), { ...dcDraft, column: dcDraft.column.trim() }]);
    setDcDraft({ column: "", notNull: false, unique: false, maxLength: "" });
  };
  const removeDbConstraint = (i: number) => update("dbConstraints", (formData.dbConstraints ?? []).filter((_, idx) => idx !== i));

  // ── Auth context draft ────────────────────────────────────────────────────
  const EMPTY_AUTH_DRAFT = { roles: [] as string[], passwordPolicy: "", maxAttempts: "", sessionDuration: "", mfaType: "", protectedResources: [] as string[] };
  const [authDraft, setAuthDraft] = useState(EMPTY_AUTH_DRAFT);
  const [authError, setAuthError] = useState<string>("");
  const [authDraftRolesWarning, setAuthDraftRolesWarning] = useState<import("./useSanitizer").SanitizerWarning | null>(null);
  const [authDraftProtectedWarning, setAuthDraftProtectedWarning] = useState<import("./useSanitizer").SanitizerWarning | null>(null);
  const addAuth = () => {
    const hasData = authDraft.roles.length > 0 || authDraft.passwordPolicy.trim() ||
      authDraft.maxAttempts.trim() || authDraft.sessionDuration.trim() ||
      authDraft.mfaType.trim() || authDraft.protectedResources.length > 0;
    if (!hasData) { setAuthError("Remplissez au moins un champ."); return; }
    setAuthError("");
    update("authContext", {
      roles: authDraft.roles,
      passwordPolicy: authDraft.passwordPolicy,
      maxAttempts: authDraft.maxAttempts,
      sessionDuration: authDraft.sessionDuration,
      mfaType: authDraft.mfaType,
      protectedResources: authDraft.protectedResources,
    } as AuthContext);
    setAuthDraft(EMPTY_AUTH_DRAFT);
  };
  const resetAuth = () => { update("authContext", { roles: [], passwordPolicy: "", maxAttempts: "", sessionDuration: "", mfaType: "", protectedResources: [] } as AuthContext); };

  // ── Draft inline translations ─────────────────────────────────────────────
  const { translated: fieldNameTr, loading: fieldNameLoading, accept: acceptFieldName } = useInlineTranslation(fieldDraft.name, targetLang);
  const { translated: fileNameTr, loading: fileNameLoading, accept: acceptFileName } = useInlineTranslation(fileDraft.name, targetLang);
  const { translated: mimeNoteTr, loading: mimNoteLoading, accept: acceptMimeNote } = useInlineTranslation(fileDraft.mimeNote, targetLang);
  const { translated: maxSizeTr, loading: maxSizeLoading, accept: acceptMaxSize } = useInlineTranslation(fileDraft.maxSizeLabel, targetLang);
  const { translated: minSizeTr, loading: minSizeLoading, accept: acceptMinSize } = useInlineTranslation(fileDraft.minSizeLabel, targetLang);
  const { translated: emTextTr, loading: emTextLoading, accept: acceptEmText } = useInlineTranslation(emDraft.text, targetLang);
  const { translated: cfConditionTr, loading: cfCondLoading, accept: acceptCfCond } = useInlineTranslation(cfDraft.condition, targetLang);
  const { translated: cfTrueTr, loading: cfTrueLoading, accept: acceptCfTrue } = useInlineTranslation(cfDraft.trueBranch, targetLang);
  const { translated: cfFalseTr, loading: cfFalseLoading, accept: acceptCfFalse } = useInlineTranslation(cfDraft.falseBranch, targetLang);
  const { translated: stepLabelTr, loading: stepLabelLoading, accept: acceptStepLabel } = useInlineTranslation(stepDraft.label, targetLang);

  // ── Quality & token budget ─────────────────────────────────────────────────
  const qualityScore = useMemo(() => computeQualityScore(formData, selectedScope.size), [formData, selectedScope.size]);
  const tokenBudget  = useMemo(() => computeTokenBudget(formData, Array.from(selectedScope), model), [formData, selectedScope, model]);
  const canGenerate = selectedScope.size > 0;

  // ── Compte réel de tokens via Ollama /api/tokenize (debounce 800ms) ────────
  useEffect(() => {
    if (selectedScope.size === 0) {
      setRealTokenCount(null);
      return;
    }
    const compiled = compileFormContext(formData, Array.from(selectedScope));
    if (!compiled.trim()) { setRealTokenCount(null); return; }

    setTokenCountLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/backend/llm/token-count', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: compiled }),
        });
        if (!res.ok) throw new Error('fetch failed');
        const data = await res.json() as { count: number; estimated?: boolean };
        setRealTokenCount(data.count);
        setTokenCountEstimated(data.estimated ?? false);
      } catch {
        // Ollama down — on garde l'estimation locale
        setRealTokenCount(null);
        setTokenCountEstimated(true);
      } finally {
        setTokenCountLoading(false);
      }
    }, 800);

    return () => { clearTimeout(timer); setTokenCountLoading(false); };
  }, [formData, selectedScope, model]);

  // ── Sanitization ─────────────────────────────────────────────────────────
  const { sanitizeAll } = useSanitizer();
  const [fieldWarnings, setFieldWarnings] = useState<Record<string, import("./useSanitizer").SanitizerWarning | null>>({});
  const setFieldWarning = (fieldId: string, w: import("./useSanitizer").SanitizerWarning | null) =>
    setFieldWarnings(prev => ({ ...prev, [fieldId]: w }));

  // ✅ MODIFIÉ : handleConfirm — reset generationState à "loading" avant d'appeler onTCsGenerated
  // Cela permet au bouton d'afficher "Génération..." pendant l'appel réseau
  const handleConfirm = () => {
    // ✅ Effacer l'erreur précédente quand l'utilisateur retente
    setGenerationError(null);

    // ── Vérification du budget tokens ────────────────────────────────────
    const budget = computeTokenBudget(formData, Array.from(selectedScope), model);
    // Utilise le vrai compte Ollama si disponible, sinon l'estimation locale
    const effectiveCount = realTokenCount ?? budget.total;
    const effectiveStatus: TokenBudgetResult["status"] =
      effectiveCount <= budget.thresholds.ok ? "ok" :
      effectiveCount <= budget.thresholds.warning ? "warning" :
      "danger";
    const modelSize = inferModelSize(model);
    const modelLabel = modelSize > 0 ? `${model} (${modelSize}B, ctx ${budget.thresholds.ctxWindow})` : model;
    if (effectiveStatus === "danger") {
      setGenerationError(
        `[TokenBudget] Contexte trop volumineux — ~${budget.total} tokens estimés pour ${modelLabel}. ` +
        `Seuil max : ${budget.thresholds.max} tokens. ` +
        `Réduisez les scopes sélectionnés ou les valeurs saisies.`
      );
      setGenerationState("error");
      return;
    }
    if (effectiveStatus === "warning") {
      setTokenWarningPending(true);
      return;
    }

    setGenerationState("loading");
    const dataToUse = (isTranslated && translatedData) ? translatedData : formData;
    const cleanData = sanitizeAll(dataToUse);
    const formContext = compileFormContext(cleanData, Array.from(selectedScope));
    onTCsGenerated({ formContext, formData: cleanData, selectedScope: Array.from(selectedScope) });
  };

  const handleConfirmForce = () => {
    setTokenWarningPending(false);
    setGenerationState("loading");
    const dataToUse = (isTranslated && translatedData) ? translatedData : formData;
    const cleanData = sanitizeAll(dataToUse);
    const formContext = compileFormContext(cleanData, Array.from(selectedScope));
    onTCsGenerated({ formContext, formData: cleanData, selectedScope: Array.from(selectedScope) });
  };

  const activeTabIndex = TAB_ORDER.indexOf(activeTab);
  const goPrev = () => setActiveTab(TAB_ORDER[Math.max(activeTabIndex - 1, 0)]);
  const goNext = () => setActiveTab(TAB_ORDER[Math.min(activeTabIndex + 1, TAB_ORDER.length - 1)]);
  const isFirstTab = activeTabIndex <= 0;
  const isLastTab = activeTabIndex >= TAB_ORDER.length - 1;

  // ── Styles ───────────────────────────────────────────────────────────────
  const S = {
    tab: (key: Tab): React.CSSProperties => ({
      flex: 1, padding: "10px 6px", background: "none", border: "none",
      borderBottom: `2.5px solid ${activeTab === key ? "#0f766e" : "transparent"}`,
      color: activeTab === key ? "#0f766e" : "#94a3b8",
      fontSize: 11, fontWeight: activeTab === key ? 800 : 600, cursor: "pointer",
      fontFamily: "inherit", whiteSpace: "nowrap", transition: "all .15s", letterSpacing: "0.03em",
    }),
    label: { fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase" as const, letterSpacing: "0.08em" } as React.CSSProperties,
    badge: (n: number, color = "#0f766e") => n > 0 ? (
      <span style={{ fontSize: 9, fontWeight: 800, background: color + "20", color, border: `1px solid ${color}40`, borderRadius: 10, padding: "1px 6px", marginLeft: 4 }}>{n}</span>
    ) : null,
    annotation: (color: string): React.CSSProperties => ({
      background: color + "10", border: `1px solid ${color}30`, borderRadius: 9, padding: "10px 14px", fontSize: 12, lineHeight: 1.6, color: color,
    }),
    inp: (hasVal: boolean, translated?: boolean): React.CSSProperties => ({
      padding: "9px 12px",
      border: `1.5px solid ${translated ? "#3b82f6" : hasVal ? "#0f766e55" : "#e2e8f0"}`,
      borderRadius: 9, fontSize: 12, color: "#1a202c",
      background: translated ? "#eff6ff" : hasVal ? "#f0fdf4" : "#fff",
      fontFamily: "inherit", outline: "none", width: "100%", boxSizing: "border-box" as const,
    }),
    card: (borderColor: string, bg: string): React.CSSProperties => ({
      display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 13px",
      border: `1.5px solid ${borderColor}`, borderRadius: 9, background: bg,
    }),
    addBtn: (color: string, bgColor: string, border: string): React.CSSProperties => ({
      padding: "9px 18px", border: `1.5px solid ${border}`, borderRadius: 9,
      background: bgColor, color, fontWeight: 800, cursor: "pointer",
      fontFamily: "inherit", fontSize: 12, alignSelf: "flex-start", transition: "all .15s",
    }),
    draftBox: (borderColor: string, bg: string): React.CSSProperties => ({
      border: `1.5px dashed ${borderColor}`, borderRadius: 12, padding: "16px",
      display: "flex", flexDirection: "column", gap: 12, background: bg,
    }),
    removeBtn: (): React.CSSProperties => ({
      width: 24, height: 24, border: "1px solid #fca5a5", borderRadius: 6,
      background: "#fef2f2", color: "#991b1b", cursor: "pointer", fontSize: 12,
      fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
    }),
    errBox: (): React.CSSProperties => ({
      fontSize: 11, color: "#991b1b", background: "#fef2f2",
      border: "1px solid #fca5a5", borderRadius: 6, padding: "6px 10px",
    }),
    checkRow: (): React.CSSProperties => ({
      display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none",
    }),
    sectionLabel: (color: string): React.CSSProperties => ({
      fontSize: 11, fontWeight: 700, color, textTransform: "uppercase", letterSpacing: "0.08em", margin: "4px 0 2px",
    }),
  };

  const scopeCount = selectedScope.size;
  const fieldsCount = formData.fields.length;
  const extraEntriesCount = (formData.errorMessages ?? []).length
    + (formData.conditionalFlows ?? []).length
    + (formData.steps ?? []).length
    + (formData.paymentGateways ?? []).length
    + (formData.dbConstraints ?? []).length;

  // ✅ NOUVEAU : label et style du bouton Générer selon l'état
  const generateBtnLabel = () => {
    if (generationState === "loading") {
      return <><span style={{ display: "inline-block", width: 12, height: 12, border: "2px solid #fff", borderTopColor: "transparent", borderRadius: "50%", animation: "qa-spin 0.7s linear infinite", marginRight: 6, verticalAlign: "middle" }} />Génération en cours…</>;
    }
    if (generationState === "error") return "✦ Réessayer la génération";
    return "✦ Générer les cas de test";
  };

  const generateBtnBg = () => {
    if (!canGenerate || generationState === "loading") return "#94a3b8";
    if (generationState === "error") return "linear-gradient(135deg,#dc2626,#ef4444)";
    return "linear-gradient(135deg,#0f766e,#0d9488)";
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(2,6,23,.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000, padding: "clamp(10px,2vw,24px)" }}
      onClick={onClose}
    >
      {/* ✅ Keyframe pour l'animation du banner d'erreur */}
      <style>{`
        @keyframes form-slide-in {
          from { opacity: 0; transform: translateY(-6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes form-token-scan {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(300%); }
        }
        @keyframes form-token-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(220,38,38,0); }
          50%       { box-shadow: 0 0 0 3px rgba(220,38,38,0.12); }
        }
      `}</style>

      <div
        onClick={e => e.stopPropagation()}
        style={{ width: "100%", maxWidth: "clamp(320px,92vw,920px)", maxHeight: "92vh", background: "#fff", borderRadius: 18, border: "1.5px solid #e2e8f0", boxShadow: "0 30px 80px rgba(2,6,23,.32)", overflow: "hidden", display: "flex", flexDirection: "column", fontFamily: "'JetBrains Mono', monospace" }}
      >
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div style={{ padding: "16px 22px", borderBottom: "1.5px solid #e2e8f0", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, background: "linear-gradient(135deg,#fff,#f8fafc)" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <div style={{ width: 32, height: 32, background: "linear-gradient(135deg,#0f766e,#0d9488)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, color: "#fff", flexShrink: 0 }}>⟡</div>
              <div>
                <div style={{ fontSize: 15, color: "#0f172a", fontWeight: 900 }}>{requirement.reqId}</div>
                <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>{requirement.module}</div>
              </div>
            </div>
            <div style={{ fontSize: 12, color: "#475569", lineHeight: 1.6, maxWidth: 600, borderLeft: "3px solid #0f766e30", paddingLeft: 10, marginLeft: 2 }}>{requirement.reqDesc}</div>
            <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
              {[`Modèle : ${model}`].map(t => (
                <span key={t} style={{ fontSize: 10, color: "#64748b", background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 5, padding: "2px 8px", fontWeight: 600 }}>{t}</span>
              ))}
              <span style={{ fontSize: 10, color: "#60a5fa", background: "#60a5fa10", border: "1px solid #60a5fa30", borderRadius: 5, padding: "2px 8px", fontWeight: 700 }}>
                {scopeCount} scope · {fieldsCount} champs · {(formData.fileInputs ?? []).length} fichiers · {qualityScore}% · <span style={{ color: tokenBudget.status === "ok" ? "#0f766e" : tokenBudget.status === "warning" ? "#b45309" : "#dc2626", fontWeight: 700 }}>
                    {tokenCountLoading ? "..." : `${(realTokenCount === null || tokenCountEstimated) ? "~" : ""}${realTokenCount ?? tokenBudget.total}tok`}
                  </span>
                  {" · "}
                  <span
                    title={`ctx ${tokenBudget.thresholds.ctxWindow} · max ${tokenBudget.thresholds.max} tok`}
                    style={{
                      color: tokenBudget.status === "ok" ? "#0f766e" : tokenBudget.status === "warning" ? "#b45309" : "#dc2626",
                      background: tokenBudget.status === "ok" ? "#f0fdf4" : tokenBudget.status === "warning" ? "#fffbeb" : "#fef2f2",
                      border: `1px solid ${tokenBudget.status === "ok" ? "#bbf7d0" : tokenBudget.status === "warning" ? "#fde68a" : "#fecaca"}`,
                      borderRadius: 5, padding: "2px 8px", fontWeight: 800, fontSize: 10,
                    }}>
                    {tokenBudget.status === "ok" ? "✓" : tokenBudget.status === "warning" ? "⚠" : "✗"}{" "}
                    {tokenCountLoading
                      ? "..."
                      : `${realTokenCount === null ? "~" : ""}${realTokenCount ?? tokenBudget.total}${tokenCountEstimated ? "~" : ""} tok`}
                  </span>
              </span>
              {isTranslated && (
                <span style={{ fontSize: 10, color: "#1d4ed8", background: "#3b82f610", border: "1px solid #3b82f640", borderRadius: 5, padding: "2px 8px", fontWeight: 700 }}>
                  ✦ Aperçu traduit · {SUPPORTED_LANGUAGES.find(l => l.code === targetLang)?.label}
                </span>
              )}
            </div>
          </div>
          <button onClick={onClose} style={{ border: "1.5px solid #e2e8f0", background: "#f8fafc", color: "#64748b", borderRadius: 8, width: 32, height: 32, cursor: "pointer", fontWeight: 700, fontSize: 16, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
        </div>

        {/* ── Verrou temps réel : quelqu'un d'autre génère déjà sur cette
            exigence (n'importe quel mode). Persiste tant que le verrou est
            actif — même si la génération démarre après ouverture du formulaire —
            et désactive le bouton Générer pour éviter un envoi voué à l'échec. */}
        {liveGenerationLock && (
          <div style={{ padding: "9px 22px", background: "#fffbeb", borderBottom: "1.5px solid #fde68a", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#d97706", flexShrink: 0, animation: "form-token-pulse 1.4s infinite" }} />
            <span style={{ fontSize: 11.5, fontWeight: 700, color: "#92400e" }}>
              {formatLockStatus(liveGenerationLock)} pour <span style={{ fontFamily: "inherit" }}>{requirement.reqId}</span>… vous pourrez générer une fois terminé.
            </span>
          </div>
        )}

        {/* ── Status bar ───────────────────────────────────────────────────── */}
        {(translationStatus === "loading" || translationStatus === "done" || translationStatus === "error" || isTranslated || generationError) && (
          <div style={{ padding: "8px 22px", borderBottom: "1.5px solid #e2e8f0", background: "#fafbfc", display: "flex", flexDirection: "column", gap: 8 }}>
            {(translationStatus === "loading" || translationStatus === "done" || translationStatus === "error") && (
              <TranslationProgressBar progress={translationProgress} status={translationStatus} targetLang={targetLang} />
            )}
            {translationStatus === "error" && translationError && (
              <div style={{ fontSize: 10, color: "#dc2626", padding: "5px 10px", background: "#fef2f2", borderRadius: 6, border: "1px solid #fecaca" }}>
                {translationError} — Impossible de joindre MyMemory, réessayez plus tard.
              </div>
            )}

            {/* ✅ MODIFIÉ : Bannière d'erreur sanitizer — plus visible, avec token en évidence */}
            {generationError && (
              <SanitizerErrorBanner
                message={generationError}
                onClose={() => {
                  setGenerationError(null);
                  setGenerationState("idle");
                }}
              />
            )}

            {isTranslated && translatedData && (
              <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                <button onClick={handleApplyTranslation} style={{ padding: "7px 14px", border: "none", borderRadius: 8, background: "#0f766e", color: "#fff", fontWeight: 800, cursor: "pointer", fontFamily: "inherit", fontSize: 12, whiteSpace: "nowrap" }}>✔ Appliquer</button>
                <button onClick={handleDiscardTranslation} style={{ padding: "7px 14px", border: "1.5px solid #e2e8f0", borderRadius: 8, background: "#fff", color: "#64748b", fontWeight: 700, cursor: "pointer", fontFamily: "inherit", fontSize: 12, whiteSpace: "nowrap" }}>✗ Annuler</button>
              </div>
            )}
          </div>
        )}

        {/* ── Tabs ───────────────────────────────────────────────────────── */}
        <div style={{ display: "flex", borderBottom: "1.5px solid #e2e8f0", padding: "0 8px", background: "#fafbfc", overflowX: "auto" }}>
          <button style={S.tab("scope")} onClick={() => setActiveTab("scope")}>
            Scope{S.badge(selectedScope.size, "#60a5fa")}
          </button>
          <button style={S.tab("entries")} onClick={() => setActiveTab("entries")}>
            {(() => {
              const total = formData.fields.length + (formData.fileInputs ?? []).length + extraEntriesCount;
              return <>Entrées{S.badge(total, total === 0 ? "#ef4444" : "#0f766e")}</>;
            })()}
          </button>
          {hasAnyTestableEntries && (
            <button style={S.tab("valid")} onClick={() => setActiveTab("valid")}>
              {(() => { const n = Object.values(formData.validValues).flat().length; return <>Cas valides{S.badge(n)}</>; })()}
            </button>
          )}
          {hasAnyTestableEntries && (
            <button style={S.tab("invalid")} onClick={() => setActiveTab("invalid")}>
              {(() => { const n = Object.values(formData.invalidValues).flat().length; return <>Cas invalides{S.badge(n, "#ef4444")}</>; })()}
            </button>
          )}
          {hasAnyTestableEntries && (
            <button style={S.tab("boundary")} onClick={() => setActiveTab("boundary")}>
              {(() => {
                const hasB = Object.values(formData.minBoundary).some(v => v.trim()) || Object.values(formData.maxBoundary).some(v => v.trim())
                  || (formData.fileInputs ?? []).some(f => f.minSizeLabel.trim() || f.maxSizeLabel.trim());
                return <>Limites{hasB ? S.badge(1, "#f59e0b") : null}</>;
              })()}
            </button>
          )}
          <button style={S.tab("summary")} onClick={() => setActiveTab("summary")}>Résumé</button>
        </div>

        {/* ── Token Live Bar — visible dès qu'un scope est sélectionné ─── */}
        {selectedScope.size > 0 && (
          <TokenLiveBar
            tokenBudget={tokenBudget}
            realTokenCount={realTokenCount}
            tokenCountLoading={tokenCountLoading}
            tokenCountEstimated={tokenCountEstimated}
            model={model}
          />
        )}

        {/* ── Body ───────────────────────────────────────────────────────── */}
        <div style={{ flex: 1, overflowY: "auto", padding: "18px 22px" }}>

          {/* ══════════════════ SCOPE ══════════════════════════════════════ */}
          {activeTab === "scope" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 2, alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <button
                    onClick={() => setSelectedScope(new Set(SCOPE_FEATURES.map(f => f.id)))}
                    style={{ padding: "4px 12px", border: "1px solid #e2e8f0", borderRadius: 20, background: "transparent", color: "#64748b", fontSize: 10, cursor: "pointer", fontFamily: "inherit", fontWeight: 600, transition: "all .15s" }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "#0f766e"; (e.currentTarget as HTMLElement).style.color = "#0f766e"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "#e2e8f0"; (e.currentTarget as HTMLElement).style.color = "#64748b"; }}
                  >
                    Tout sélectionner
                  </button>
                  {confirmClearScope ? (
                    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: "#dc2626" }}>Tout effacer ?</span>
                      <button
                        onClick={() => { setSelectedScope(new Set()); setConfirmClearScope(false); }}
                        style={{ padding: "4px 10px", border: "1px solid #dc2626", borderRadius: 20, background: "#dc2626", color: "#fff", fontSize: 10, cursor: "pointer", fontFamily: "inherit", fontWeight: 700 }}
                      >
                        Oui
                      </button>
                      <button
                        onClick={() => setConfirmClearScope(false)}
                        style={{ padding: "4px 10px", border: "1px solid #e2e8f0", borderRadius: 20, background: "transparent", color: "#64748b", fontSize: 10, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}
                      >
                        Non
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmClearScope(true)}
                      style={{ padding: "4px 12px", border: "1px solid #e2e8f0", borderRadius: 20, background: "transparent", color: "#64748b", fontSize: 10, cursor: "pointer", fontFamily: "inherit", fontWeight: 600, transition: "all .15s" }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "#0f766e"; (e.currentTarget as HTMLElement).style.color = "#0f766e"; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "#e2e8f0"; (e.currentTarget as HTMLElement).style.color = "#64748b"; }}
                    >
                      Tout effacer
                    </button>
                  )}
                </div>
                <span style={{ fontSize: 10, color: "#94a3b8", fontWeight: 600 }}>{SCOPE_FEATURES.length} features disponibles</span>
              </div>
              {SCOPE_CATEGORIES.map(cat => {
                const features = SCOPE_FEATURES.filter(f => f.category === cat.id);
                const checkedCount = features.filter(f => selectedScope.has(f.id)).length;
                const isOpen = expandedCats.has(cat.id);
                return (
                  <div key={cat.id} style={{ border: "1.5px solid #e2e8f0", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", background: isOpen ? "#f0fdf4" : "#f8fafc", cursor: "pointer", borderBottom: isOpen ? "1px solid #d1fae5" : "none", transition: "background .15s" }} onClick={() => toggleCat(cat.id)}>
                      <span style={{ flex: 1, fontWeight: 800, fontSize: 13, color: "#0f172a" }}>{cat.label}</span>
                      <span style={{ fontSize: 10, color: checkedCount > 0 ? "#0f766e" : "#94a3b8", fontWeight: 800, background: checkedCount > 0 ? "#0f766e15" : "#f1f5f9", border: `1px solid ${checkedCount > 0 ? "#0f766e40" : "#e2e8f0"}`, borderRadius: 10, padding: "1px 8px" }}>{checkedCount}/{features.length}</span>
                      <span style={{ color: "#94a3b8", fontSize: 11 }}>{isOpen ? "▲" : "▼"}</span>
                    </div>
                    {isOpen && (
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 6, padding: "12px 14px 14px" }}>
                        {features.map(feat => {
                          const checked = selectedScope.has(feat.id);

                          const isSuggested = !checked &&
                            Object.entries(SCOPE_SUGGESTIONS).some(
                              ([src, targets]) => selectedScope.has(src) && targets.includes(feat.id)
                            );

                          return (
                            <div
                              key={feat.id}
                              onClick={() => toggleScope(feat.id)}
                              style={{
                                display: "flex", gap: 8, alignItems: "flex-start",
                                padding: "9px 11px", borderRadius: 9,
                                border: `1.5px solid ${
                                  checked       ? "#0f766e50" :
                                  isSuggested   ? "#f59e0b60" :
                                                  "#e2e8f0"
                                }`,
                                background: checked
                                  ? "#f0fdf4"
                                  : isSuggested
                                    ? "#fffbeb"
                                    : "#fff",
                                cursor: "pointer", transition: "all .15s",
                                boxShadow: checked ? "0 2px 8px rgba(15,118,110,0.08)" : "none",
                              }}
                            >
                              <div style={{
                                width: 16, height: 16, borderRadius: 4, flexShrink: 0, marginTop: 1,
                                border: `2px solid ${checked ? "#0f766e" : isSuggested ? "#f59e0b" : "#cbd5e1"}`,
                                background: checked ? "#0f766e" : "transparent",
                                display: "flex", alignItems: "center", justifyContent: "center",
                                fontSize: 10, color: "#fff", fontWeight: 900,
                              }}>
                                {checked ? "✓" : ""}
                              </div>
                              <div style={{ flex: 1 }}>
                                <div style={{
                                  display: "flex", alignItems: "center", gap: 6,
                                  fontSize: 12, fontWeight: 700,
                                  color: checked ? "#0f766e" : "#0f172a",
                                  marginBottom: 2,
                                }}>
                                  {feat.title}
                                  {isSuggested && (
                                    <span style={{
                                      fontSize: 9, fontWeight: 800,
                                      background: "#f59e0b15", color: "#b45309",
                                      border: "1px solid #f59e0b40",
                                      borderRadius: 10, padding: "1px 6px",
                                    }}>
                                      ✦ suggéré
                                    </span>
                                  )}
                                </div>
                                <div style={{ fontSize: 10, color: "#64748b", lineHeight: 1.4 }}>
                                  {feat.examples}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* ══════════════════ ENTRIES ════════════════════════════════════ */}
          {activeTab === "entries" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              {showFields && (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {(showFiles || showErrors || showCondFlows || showSteps || showApiContracts || showAuth || showDbSchema) && (
                    <SectionDivider label="▤ Champs du formulaire" color="#0f766e" bg="#f0fdf4" border="#bbf7d0" />
                  )}
                  <div style={S.annotation("#0f766e")}>Déclarez les <strong>champs du formulaire</strong> que cette exigence implique.</div>
                  {formData.fields.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {formData.fields.length > 1 && (
                        <div style={{ fontSize: 10, color: "#94a3b8", display: "flex", alignItems: "center", gap: 5, marginBottom: 2 }}>
                          <span>⠿</span> Glissez-déposez les lignes pour réordonner les champs
                        </div>
                      )}
                      {formData.fields.map((f, i) => {
                        const typeDef = allFieldTypes.find(t => t.value === f.type) || FIELD_TYPES[0];
                        const isChoice = isChoiceField(f.type);
                        return (
                          <div key={i}
                            draggable
                            onDragStart={() => handleFieldDragStart(i)}
                            onDragOver={e => handleFieldDragOver(e, i)}
                            onDrop={() => handleFieldDrop(i)}
                            onDragEnd={handleFieldDragEnd}
                            style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 13px", border: `1.5px solid ${dragOverFieldIndex === i ? "#0f766e" : isChoice ? "#93c5fd" : "#e2e8f0"}`, borderRadius: 9, background: dragFieldIndex === i ? "#e0fdf4" : isChoice ? "#eff6ff" : "#f8fafc", transition: "all .15s", opacity: dragFieldIndex === i ? 0.5 : 1 }}
                            onMouseEnter={e => { if (dragFieldIndex === null) { (e.currentTarget as HTMLElement).style.borderColor = isChoice ? "#3b82f6" : "#0f766e30"; (e.currentTarget as HTMLElement).style.background = isChoice ? "#e0e7ff" : "#f0fdf4"; } }}
                            onMouseLeave={e => { if (dragFieldIndex === null) { (e.currentTarget as HTMLElement).style.borderColor = dragOverFieldIndex === i ? "#0f766e" : isChoice ? "#93c5fd" : "#e2e8f0"; (e.currentTarget as HTMLElement).style.background = isChoice ? "#eff6ff" : "#f8fafc"; } }}>
                            {/* ── Poignée drag & drop ── */}
                            <div title="Glisser pour réordonner" style={{ display: "flex", flexDirection: "column", gap: 2.5, flexShrink: 0, cursor: "grab", padding: "2px 3px", borderRadius: 4, color: "#94a3b8", userSelect: "none" }}>
                              <div style={{ display: "flex", gap: 2 }}><div style={{ width: 3, height: 3, borderRadius: "50%", background: "currentColor" }} /><div style={{ width: 3, height: 3, borderRadius: "50%", background: "currentColor" }} /></div>
                              <div style={{ display: "flex", gap: 2 }}><div style={{ width: 3, height: 3, borderRadius: "50%", background: "currentColor" }} /><div style={{ width: 3, height: 3, borderRadius: "50%", background: "currentColor" }} /></div>
                              <div style={{ display: "flex", gap: 2 }}><div style={{ width: 3, height: 3, borderRadius: "50%", background: "currentColor" }} /><div style={{ width: 3, height: 3, borderRadius: "50%", background: "currentColor" }} /></div>
                            </div>
                            <span style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", background: isChoice ? "#3b82f620" : "#0f766e15", border: `1px solid ${isChoice ? "#3b82f640" : "#0f766e30"}`, borderRadius: 6, fontSize: 11, fontWeight: 900, color: isChoice ? "#2563eb" : "#0f766e", flexShrink: 0 }}>{typeDef.emoji}</span>
                            <div style={{ flex: 1 }}>
                              <span style={{ fontSize: 12, fontWeight: 800, color: "#0f172a" }}>{f.name}</span>
                              {f.label !== f.name && <span style={{ fontSize: 11, color: "#64748b", marginLeft: 6 }}>— {f.label}</span>}
                              {isChoice && (
                                <span style={{ marginLeft: 8, fontSize: 9, fontWeight: 800, background: "#3b82f620", color: "#2563eb", border: "1px solid #3b82f640", borderRadius: 4, padding: "1px 6px" }}>
                                  options →
                                </span>
                              )}
                            </div>
                            {/* ── Toggle obligatoire / optionnel ── */}
                            <button
                              onClick={() => {
                                const next = [...formData.fields];
                                next[i] = { ...next[i], required: !next[i].required };
                                update("fields", next);
                              }}
                              title={f.required ? "Champ obligatoire — cliquer pour rendre optionnel" : "Champ optionnel — cliquer pour rendre obligatoire"}
                              style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, fontWeight: 700, padding: "4px 10px", border: `1.5px solid ${f.required ? "#dc2626" : "#cbd5e1"}`, borderRadius: 20, background: f.required ? "#dc2626" : "#f1f5f9", color: f.required ? "#fff" : "#64748b", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0, fontFamily: "inherit", transition: "all .15s" }}>
                              <span style={{ fontSize: 12, lineHeight: 1 }}>{f.required ? "✱" : "○"}</span>
                              {f.required ? "Obligatoire" : "Optionnel"}
                            </button>
                            <select value={f.type} onChange={e => updateFieldType(i, e.target.value as FieldType)}
                              style={{ fontSize: 10, border: "1px solid #e2e8f0", borderRadius: 6, padding: "3px 6px", background: "#fff", color: "#475569", fontFamily: "inherit", cursor: "pointer" }}>
                              {allFieldTypes.map(t => <option key={t.value} value={t.value}>{t.emoji ? `${t.emoji} ${t.label}` : t.label}</option>)}
                            </select>
                            <ConfirmRemoveButton onConfirm={() => removeField(i)} title="Supprimer ce champ" />
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div style={S.draftBox("#e2e8f0", "#fafbfc")}>
                    <div style={S.label}>Ajouter un champ</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        <label style={{ fontSize: 11, color: "#64748b", fontWeight: 700, display: "flex", alignItems: "center", gap: 4 }}>
                          <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#ef4444", display: "inline-block" }} />Nom du champ
                        </label>
                        <input value={fieldDraft.name} onChange={e => { setFieldDraft(p => ({ ...p, name: e.target.value })); setFieldError(""); }} onKeyDown={e => e.key === "Enter" && addField()} placeholder="ex: email, montant" style={S.inp(!!fieldDraft.name)} />
                        <InlineTranslationHint translated={fieldNameTr} loading={fieldNameLoading} targetLang={targetLang} onAccept={v => { setFieldDraft(p => ({ ...p, name: v })); acceptFieldName(); }} />
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <label style={{ fontSize: 11, color: "#64748b", fontWeight: 700 }}>Type du champ</label>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 6 }}>
                        {allFieldTypes.map(ft => {
                          const sel = fieldDraft.type === ft.value;
                          const isChoice = isChoiceField(ft.value);
                          return (
                            <div key={ft.value} onClick={() => setFieldDraft(p => ({ ...p, type: ft.value }))} title={ft.hint}
                              style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", border: `1.5px solid ${sel ? (isChoice ? "#3b82f6" : "#0f766e") : "#e2e8f0"}`, borderRadius: 8, cursor: "pointer", background: sel ? (isChoice ? "#eff6ff" : "#f0fdf4") : "#fff", transition: "all .15s" }}>
                              {ft.emoji ? <span style={{ fontSize: 13, width: 20, textAlign: "center", flexShrink: 0 }}>{ft.emoji}</span> : null}
                              <div style={{ fontSize: 11, fontWeight: 700, color: sel ? (isChoice ? "#2563eb" : "#0f766e") : "#0f172a" }}>{ft.label}</div>
                              {sel && <div style={{ marginLeft: "auto", fontSize: 10, color: isChoice ? "#2563eb" : "#0f766e", fontWeight: 900 }}>✓</div>}
                            </div>
                          );
                        })}
                      </div>
                      {isChoiceField(fieldDraft.type) && (
                        <div style={{ fontSize: 10, color: "#2563eb", background: "#eff6ff", border: "1px solid #93c5fd", borderRadius: 6, padding: "5px 10px" }}>
                          💡 Ce type utilise des <strong>options prédéfinies</strong> — vous les saisirez dans la section ci-dessous.
                        </div>
                      )}
                      {!isChoiceField(fieldDraft.type) && (
                        <div style={{ fontSize: 10, color: "#0f766e", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 6, padding: "5px 10px" }}>
                          💡 {allFieldTypes.find(t => t.value === fieldDraft.type)?.hint}
                        </div>
                      )}
                      <button onClick={() => setShowCustomTypeForm(s => !s)} style={{ padding: "6px 10px", border: "1px solid #e2e8f0", borderRadius: 8, background: "#fff", cursor: "pointer", fontFamily: "inherit", fontSize: 12, alignSelf: "flex-start" }}>
                        {showCustomTypeForm ? "Annuler" : "+ Type personnalisé"}
                      </button>
                      {showCustomTypeForm && (
                        <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 8 }}>
                          <input placeholder="label (ex: Devise)" value={customTypeDraft.label} onChange={e => setCustomTypeDraft(d => ({ ...d, label: e.target.value }))} style={{ padding: 8, border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 12, fontFamily: "inherit" }} />
                          <input placeholder="hint (optionnel)" value={customTypeDraft.hint} onChange={e => setCustomTypeDraft(d => ({ ...d, hint: e.target.value }))} style={{ padding: 8, border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 12, fontFamily: "inherit" }} />
                          <input placeholder="emoji (optionnel)" value={customTypeDraft.emoji} onChange={e => setCustomTypeDraft(d => ({ ...d, emoji: e.target.value }))} style={{ padding: 8, border: "1px solid #e2e8f0", borderRadius: 8, maxWidth: 120, fontSize: 12, fontFamily: "inherit" }} />
                          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                            <button onClick={() => setShowCustomTypeForm(false)} style={{ padding: "6px 10px", border: "1px solid #e2e8f0", borderRadius: 8, background: "#fff", cursor: "pointer", fontFamily: "inherit" }}>Annuler</button>
                            <button onClick={addCustomType} style={{ padding: "6px 10px", borderRadius: 8, background: "#0f766e", color: "#fff", cursor: "pointer", border: "none", fontFamily: "inherit" }}>Enregistrer</button>
                          </div>
                        </div>
                      )}
                    </div>
                    {/* ── Obligatoire toggle dans le formulaire d'ajout ── */}
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: 11, color: "#64748b", fontWeight: 700 }}>Ce champ est :</span>
                      <button
                        onClick={() => setFieldDraft(p => ({ ...p, required: !p.required }))}
                        style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 700, padding: "5px 14px", border: `1.5px solid ${fieldDraft.required ? "#dc2626" : "#cbd5e1"}`, borderRadius: 20, background: fieldDraft.required ? "#dc2626" : "#f1f5f9", color: fieldDraft.required ? "#fff" : "#64748b", cursor: "pointer", fontFamily: "inherit", transition: "all .15s" }}>
                        <span style={{ fontSize: 13, lineHeight: 1 }}>{fieldDraft.required ? "✱" : "○"}</span>
                        {fieldDraft.required ? "Obligatoire" : "Optionnel"}
                      </button>
                      <span style={{ fontSize: 10, color: "#94a3b8" }}>(cliquer pour changer)</span>
                    </div>
                    {fieldError && <div style={S.errBox()}>{fieldError}</div>}
                    <button onClick={addField} style={S.addBtn("#0f766e", "#f0fdf4", "#0f766e")}
                      onMouseEnter={e => { e.currentTarget.style.background = "#0f766e"; e.currentTarget.style.color = "#fff"; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "#f0fdf4"; e.currentTarget.style.color = "#0f766e"; }}>
                      + Ajouter ce champ
                    </button>
                  </div>
                </div>
              )}

              {/* ── Options pour select/checkbox ───────────────────────────── */}
              {choiceFields.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <SectionDivider label="▾ Options des listes et cases à cocher" color="#2563eb" bg="#eff6ff" border="#93c5fd" />
                  <div style={{ ...S.annotation("#2563eb") }}>
                    Déclarez les <strong>propositions</strong> de chaque liste déroulante ou case à cocher — une option par ligne.
                  </div>
                  {choiceFields.map(field => {
                    const typeDef = allFieldTypes.find(t => t.value === field.type) || FIELD_TYPES[0];
                    const opts = (formData.fieldOptions ?? {})[field.name] ?? [];
                    const isSelect = field.type === "select";
                    const accentColor = isSelect ? "#3b82f6" : "#1d4ed8";
                    const lightBg = isSelect ? "#eff6ff" : "#eff6ff";
                    const borderColor = isSelect ? "#93c5fd" : "#93c5fd";
                    return (
                      <div key={field.name} style={{ display: "flex", flexDirection: "column", gap: 8, border: `1.5px solid ${borderColor}`, borderRadius: 10, padding: "12px 14px", background: lightBg }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", background: accentColor + "20", border: `1px solid ${accentColor}30`, borderRadius: 6, fontSize: 11, fontWeight: 900, color: accentColor, flexShrink: 0 }}>
                            {typeDef.emoji}
                          </span>
                          <span style={{ fontSize: 12, fontWeight: 800, color: "#0f172a" }}>{field.name}</span>
                          {field.label !== field.name && <span style={{ fontSize: 11, color: "#64748b" }}>— {field.label}</span>}
                          <span style={{ fontSize: 10, color: "#64748b", background: "#e2e8f0", borderRadius: 5, padding: "1px 7px", marginLeft: "auto" }}>
                            {isSelect ? "liste déroulante" : "cases à cocher"}
                          </span>
                        </div>
                        <TagInput
                          tags={opts}
                          onChange={v => update("fieldOptions", { ...(formData.fieldOptions ?? {}), [field.name]: v })}
                          placeholder={isSelect ? `Options disponibles…\nex: Actif\nInactif\nEn attente` : `Cases proposées…\nex: Accepter les CGU\nRecevoir la newsletter`}
                          tagColor="indigo"
                          id={`opts-${field.name}`}
                          onSanitizerWarning={w => setFieldWarning(`opts-${field.name}`, w)}
                        />
                        {fieldWarnings[`opts-${field.name}`] && (
                          <SanitizerInlineWarning
                            offending={fieldWarnings[`opts-${field.name}`]!.offending}
                            category={fieldWarnings[`opts-${field.name}`]!.category}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {showFiles && (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {showFields && <SectionDivider label="📎 Entrées fichier" color="#0369a1" bg="#eff6ff" border="#bfdbfe" />}
                  <div style={S.annotation("#0369a1")}>Déclarez les <strong>entrées fichier</strong> : formats, tailles, contraintes MIME.</div>
                  {(formData.fileInputs ?? []).length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {(formData.fileInputs ?? []).map((fi, i) => {
                        return (
                          <div key={i} style={S.card("#bfdbfe", "#eff6ff")}>
                            <span style={{ fontSize: 16, flexShrink: 0, marginTop: 2 }}>📎</span>
                            <div style={{ flex: 1 }}>
                              <span style={{ fontSize: 12, fontWeight: 800, color: "#0f172a" }}>{fi.name}</span>
                              {fi.acceptedFormats.length > 0 && <div style={{ fontSize: 10, color: "#0f766e", marginTop: 2 }}>✓ {fi.acceptedFormats.join(", ")}</div>}
                              {fi.rejectedFormats.length > 0 && <div style={{ fontSize: 10, color: "#ef4444", marginTop: 1 }}>✗ {fi.rejectedFormats.join(", ")}</div>}
                              {(fi.maxSizeLabel || fi.minSizeLabel) && <div style={{ fontSize: 10, color: "#64748b", marginTop: 1 }}>Taille : {fi.minSizeLabel || "—"} → {fi.maxSizeLabel || "—"}</div>}
                              {fi.mimeNote && <div style={{ fontSize: 10, color: "#64748b", marginTop: 1 }}>{fi.mimeNote}</div>}
                            </div>
                            <ConfirmRemoveButton onConfirm={() => removeFileInput(i)} title="Supprimer cette entrée fichier" />
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div style={S.draftBox("#bfdbfe", "#f8fbff")}>
                    <div style={S.label}>Ajouter une entrée fichier</div>
                    <div style={{ fontSize: 10, color: "#0369a1", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 6, padding: "5px 10px" }}>
                      💡 Déclarez le nom ici. Les <strong>formats</strong>, <strong>tailles</strong> et <strong>MIME</strong> se renseignent dans les onglets <strong>Cas valides</strong>, <strong>Cas invalides</strong> et <strong>Limites</strong>.
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <label style={{ fontSize: 11, color: "#0369a1", fontWeight: 700 }}>Nom *</label>
                      <input value={fileDraft.name} onChange={e => { setFileDraft(p => ({ ...p, name: e.target.value })); setFileError(""); }} onKeyDown={e => e.key === "Enter" && addFileInput()} placeholder="ex: avatar, contrat" style={S.inp(!!fileDraft.name)} />
                      <InlineTranslationHint translated={fileNameTr} loading={fileNameLoading} targetLang={targetLang} onAccept={v => { setFileDraft(p => ({ ...p, name: v })); acceptFileName(); }} />
                    </div>
                    {fileError && <div style={S.errBox()}>{fileError}</div>}
                    <button onClick={addFileInput} style={S.addBtn("#0369a1", "#eff6ff", "#0369a1")}
                      onMouseEnter={e => { e.currentTarget.style.background = "#0369a1"; e.currentTarget.style.color = "#fff"; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "#eff6ff"; e.currentTarget.style.color = "#0369a1"; }}>
                      + Ajouter cette entrée fichier
                    </button>
                  </div>
                </div>
              )}

              {showErrors && (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <SectionDivider label="⚠ Alertes & messages" color="#dc2626" bg="#fef2f2" border="#fecaca" />
                  <div style={S.annotation("#dc2626")}>Déclarez les <strong>textes exacts</strong> des alertes et messages attendus (erreurs, succès, avertissements…).</div>
                  {(displayData.errorMessages ?? []).length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {(displayData.errorMessages ?? []).map((em, i) => (
                        <div key={i} style={S.card("#fecaca", "#fef2f2")}>
                            <span style={{ fontSize: 14, flexShrink: 0 }}>{em.fieldName?.startsWith("file__") ? "📎" : "⚠"}</span>
                          <div style={{ flex: 1 }}>
                            <span style={{ fontSize: 11, fontWeight: 800, color: "#0f172a" }}>
                              {!em.fieldName || em.fieldName === "__global__"
                                ? "Global"
                                : em.fieldName.startsWith("file__")
                                  ? em.fieldName.replace("file__", "")
                                  : em.fieldName}
                            </span>
                            {em.fieldName?.startsWith("file__") && (
                              <span style={{ fontSize: 9, fontWeight: 800, background: "#eff6ff", color: "#0369a1", border: "1px solid #bfdbfe", borderRadius: 4, padding: "1px 6px", marginLeft: 6 }}>fichier</span>
                            )}
                            <span style={{ fontSize: 10, color: "#64748b", marginLeft: 8, background: "#f1f5f9", borderRadius: 4, padding: "1px 6px" }}>{em.position}</span>
                            <div style={{ fontSize: 12, color: "#dc2626", marginTop: 3, fontStyle: "italic" }}>"{em.text}"</div>
                          </div>
                          <ConfirmRemoveButton onConfirm={() => removeErrorMessage(i)} title="Supprimer ce message" />
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={S.draftBox("#fecaca", "#fff5f5")}>
                    <div style={S.label}>Ajouter une alerte / un message</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        <label style={{ fontSize: 11, color: "#64748b", fontWeight: 700 }}>Élément associé</label>
                        <select value={emDraft.fieldName} onChange={e => setEmDraft(p => ({ ...p, fieldName: e.target.value, selectedKeys: e.target.value ? [e.target.value] : [] }))} style={{ ...S.inp(!!emDraft.fieldName), cursor: "pointer" }}>
                          <option value="">— Global</option>
                          {formData.fields.length > 0 && (
                            <optgroup label="Champs">
                              {formData.fields.map(f => <option key={f.name} value={f.name}>{f.name}{f.required ? " ✱" : ""}</option>)}
                            </optgroup>
                          )}
                          {(formData.fileInputs ?? []).length > 0 && (
                            <optgroup label="Fichiers">
                              {(formData.fileInputs ?? []).map(fi => <option key={"file__" + fi.name} value={"file__" + fi.name}>📎 {fi.name}</option>)}
                            </optgroup>
                          )}
                        </select>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        <label style={{ fontSize: 11, color: "#64748b", fontWeight: 700 }}>Position</label>
                        <select value={emDraft.position} onChange={e => setEmDraft(p => ({ ...p, position: e.target.value as ErrorMessageDefinition["position"] }))} style={{ ...S.inp(true), cursor: "pointer" }}>
                          <option value="inline">Inline</option>
                          <option value="toast">Toast</option>
                          <option value="banner">Bandeau</option>
                          <option value="modal">Modal</option>
                        </select>
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <label style={{ fontSize: 11, color: "#dc2626", fontWeight: 700 }}>Texte exact *</label>
                      <input value={emDraft.text} onChange={e => { setEmDraft(p => ({ ...p, text: e.target.value })); setEmError(""); }} placeholder='"Ce champ est obligatoire"' style={S.inp(!!emDraft.text)} />
                      <InlineTranslationHint translated={emTextTr} loading={emTextLoading} targetLang={targetLang} onAccept={v => { setEmDraft(p => ({ ...p, text: v })); acceptEmText(); }} />
                    </div>
                    {emError && <div style={S.errBox()}>{emError}</div>}
                    <button onClick={addErrorMessage} style={S.addBtn("#dc2626", "#fef2f2", "#dc2626")}
                      onMouseEnter={e => { e.currentTarget.style.background = "#dc2626"; e.currentTarget.style.color = "#fff"; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "#fef2f2"; e.currentTarget.style.color = "#dc2626"; }}>
                      + Ajouter cette alerte
                    </button>
                  </div>
                </div>
              )}

              {showCondFlows && (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <SectionDivider label="⇄ Flux conditionnels" color="#1d4ed8" bg="#eff6ff" border="#bfdbfe" />
                  <div style={S.annotation("#1d4ed8")}>Déclarez chaque branche <strong>if/else</strong>.</div>
                  {(displayData.conditionalFlows ?? []).length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {(displayData.conditionalFlows ?? []).map((cf, i) => (
                        <div key={i} style={S.card("#bfdbfe", "#eff6ff")}>
                          <span style={{ fontSize: 14, flexShrink: 0 }}>⇄</span>
                          <div style={{ flex: 1 }}>
                            <span style={{ fontSize: 11, fontWeight: 800, color: "#1d4ed8" }}>[{cf.id}]</span>
                            <span style={{ fontSize: 11, color: "#0f172a", marginLeft: 6 }}>IF {cf.condition}</span>
                            <div style={{ fontSize: 10, color: "#64748b", marginTop: 3 }}>✓ {cf.trueBranch}</div>
                            {cf.falseBranch && <div style={{ fontSize: 10, color: "#64748b" }}>✗ {cf.falseBranch}</div>}
                          </div>
                          <ConfirmRemoveButton onConfirm={() => removeConditionalFlow(i)} title="Supprimer ce flux" />
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={S.draftBox("#bfdbfe", "#eff6ff")}>
                    <div style={S.label}>Ajouter un flux conditionnel</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <label style={{ fontSize: 11, color: "#1d4ed8", fontWeight: 700 }}>Condition *</label>
                      <input value={cfDraft.condition} onChange={e => { setCfDraft(p => ({ ...p, condition: e.target.value })); setCfError(""); }} placeholder="ex: age >= 18" style={S.inp(!!cfDraft.condition)} />
                      <InlineTranslationHint translated={cfConditionTr} loading={cfCondLoading} targetLang={targetLang} onAccept={v => { setCfDraft(p => ({ ...p, condition: v })); acceptCfCond(); }} />
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        <label style={{ fontSize: 11, color: "#0f766e", fontWeight: 700 }}>Branche vraie *</label>
                        <input value={cfDraft.trueBranch} onChange={e => { setCfDraft(p => ({ ...p, trueBranch: e.target.value })); setCfError(""); }} placeholder="ex: redirection /dashboard" style={S.inp(!!cfDraft.trueBranch)} />
                        <InlineTranslationHint translated={cfTrueTr} loading={cfTrueLoading} targetLang={targetLang} onAccept={v => { setCfDraft(p => ({ ...p, trueBranch: v })); acceptCfTrue(); }} />
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        <label style={{ fontSize: 11, color: "#dc2626", fontWeight: 700 }}>Branche fausse</label>
                        <input value={cfDraft.falseBranch} onChange={e => setCfDraft(p => ({ ...p, falseBranch: e.target.value }))} placeholder="ex: affichage erreur 403" style={S.inp(!!cfDraft.falseBranch)} />
                        <InlineTranslationHint translated={cfFalseTr} loading={cfFalseLoading} targetLang={targetLang} onAccept={v => { setCfDraft(p => ({ ...p, falseBranch: v })); acceptCfFalse(); }} />
                      </div>
                    </div>
                    {cfError && <div style={S.errBox()}>{cfError}</div>}
                    <button onClick={addConditionalFlow} style={S.addBtn("#1d4ed8", "#eff6ff", "#1d4ed8")}
                      onMouseEnter={e => { e.currentTarget.style.background = "#1d4ed8"; e.currentTarget.style.color = "#fff"; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "#eff6ff"; e.currentTarget.style.color = "#1d4ed8"; }}>
                      + Ajouter ce flux
                    </button>
                  </div>
                </div>
              )}

              {showSteps && (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <SectionDivider label="↔ Étapes du parcours" color="#0891b2" bg="#ecfeff" border="#a5f3fc" />
                  <div style={S.annotation("#0891b2")}>Déclarez l'ordre et les champs obligatoires de <strong>chaque étape</strong>.</div>
                  {(displayData.steps ?? []).length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {(displayData.steps ?? []).map((step, i) => (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 13px", border: "1.5px solid #a5f3fc", borderRadius: 9, background: "#ecfeff" }}>
                          <span style={{ fontSize: 12, fontWeight: 900, color: "#0891b2", background: "#cffafe", border: "1px solid #67e8f9", borderRadius: 6, padding: "2px 8px", flexShrink: 0 }}>{step.id}</span>
                          <div style={{ flex: 1 }}>
                            <span style={{ fontSize: 12, fontWeight: 700, color: "#0f172a" }}>{step.label}</span>
                            {step.requiredFields.length > 0 && <div style={{ fontSize: 10, color: "#64748b", marginTop: 2 }}>Champs : {step.requiredFields.join(", ")}</div>}
                          </div>
                          <ConfirmRemoveButton onConfirm={() => removeStep(i)} title="Supprimer cette étape" />
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={S.draftBox("#a5f3fc", "#f0fdff")}>
                    <div style={S.label}>Ajouter une étape</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <label style={{ fontSize: 11, color: "#0891b2", fontWeight: 700 }}>Libellé *</label>
                      <input value={stepDraft.label} onChange={e => { setStepDraft(p => ({ ...p, label: e.target.value })); setStepError(""); }} onKeyDown={e => e.key === "Enter" && addStep()} placeholder="ex: Informations personnelles" style={S.inp(!!stepDraft.label)} />
                      <InlineTranslationHint translated={stepLabelTr} loading={stepLabelLoading} targetLang={targetLang} onAccept={v => { setStepDraft(p => ({ ...p, label: v })); acceptStepLabel(); }} />
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <label style={{ fontSize: 11, color: "#64748b", fontWeight: 700 }}>
                        Champs obligatoires
                        {stepDraft.requiredFields.length > 0 && (
                          <span style={{ marginLeft: 7, background: "#0891b2", color: "#fff", borderRadius: 10, padding: "1px 8px", fontSize: 10 }}>
                            {stepDraft.requiredFields.length} sélectionné{stepDraft.requiredFields.length > 1 ? "s" : ""}
                          </span>
                        )}
                      </label>
                      {(() => {
                        const requiredFields = formData.fields.filter(f => f.required);
                        if (requiredFields.length === 0) return (
                          <div style={{ fontSize: 11, color: "#94a3b8", background: "#f8fafc", border: "1px dashed #cbd5e1", borderRadius: 8, padding: "10px 14px", fontStyle: "italic" }}>
                            Aucun champ obligatoire défini — marquez des champs comme obligatoires (✱) dans la section "Champs du formulaire".
                          </div>
                        );
                        return (
                          <div style={{ border: "1px solid #a5f3fc", borderRadius: 9, background: "#fff", overflow: "hidden" }}>
                            {requiredFields.map((f, fi) => {
                              const checked = stepDraft.requiredFields.includes(f.name);
                              return (
                                <div key={f.name}
                                  onClick={() => toggleStepField(f.name)}
                                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 13px", cursor: "pointer", borderBottom: fi < requiredFields.length - 1 ? "1px solid #e0f9fc" : "none", background: checked ? "#ecfeff" : "#fff", transition: "background .1s", userSelect: "none" }}
                                  onMouseEnter={e => { if (!checked) (e.currentTarget as HTMLElement).style.background = "#f0fdff"; }}
                                  onMouseLeave={e => { if (!checked) (e.currentTarget as HTMLElement).style.background = "#fff"; }}>
                                  <div style={{ width: 16, height: 16, borderRadius: 4, border: `2px solid ${checked ? "#0891b2" : "#cbd5e1"}`, background: checked ? "#0891b2" : "#fff", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", transition: "all .1s" }}>
                                    {checked && <span style={{ color: "#fff", fontSize: 10, fontWeight: 900, lineHeight: 1 }}>✓</span>}
                                  </div>
                                  <span style={{ fontSize: 11, color: checked ? "#0891b2" : "#0f172a", fontWeight: checked ? 700 : 400, flex: 1 }}>{f.name}</span>
                                  <span style={{ fontSize: 9, color: "#94a3b8", background: "#f1f5f9", borderRadius: 4, padding: "1px 6px" }}>{f.type}</span>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })()}
                    </div>
                    {stepError && <div style={S.errBox()}>{stepError}</div>}
                    <button onClick={addStep} style={S.addBtn("#0891b2", "#ecfeff", "#0891b2")}
                      onMouseEnter={e => { e.currentTarget.style.background = "#0891b2"; e.currentTarget.style.color = "#fff"; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "#ecfeff"; e.currentTarget.style.color = "#0891b2"; }}>
                      + Ajouter cette étape
                    </button>
                  </div>
                </div>
              )}

              {showApiContracts && (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <SectionDivider label="💳 Passerelles de paiement" color="#b45309" bg="#fffbeb" border="#fde68a" />
                  <div style={S.annotation("#b45309")}>Configurez la passerelle et les <strong>paramètres de génération de cas de test</strong> : champs à couvrir, données valides/invalides de référence et scénarios fonctionnels.</div>

                  {/* Liste des passerelles déclarées */}
                  {(formData.paymentGateways ?? []).length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {(formData.paymentGateways ?? []).map((pg, i) => (
                        <div key={i} style={S.card("#fde68a", "#fffbeb")}>
                          <span style={{ fontSize: 14, flexShrink: 0 }}>💳</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                              <span style={{ fontSize: 12, fontWeight: 800, color: "#0f172a" }}>{pg.name}</span>
                              <span style={{ fontSize: 9, background: "#b4530920", color: "#b45309", border: "1px solid #b4530940", borderRadius: 4, padding: "1px 6px", fontWeight: 700 }}>{pg.mode}</span>
                              <span style={{ fontSize: 9, background: "#0f766e20", color: "#0f766e", border: "1px solid #0f766e40", borderRadius: 4, padding: "1px 6px", fontWeight: 700 }}>
                                {pg.paymentMethod === "card" ? "💳 Carte" : pg.paymentMethod === "iban" ? "🏦 IBAN" : "💳 + 🏦"}
                              </span>
                              {pg.amount && <span style={{ fontSize: 9, color: "#0f766e", fontWeight: 700 }}>{pg.amount} {pg.currency}</span>}
                            </div>
                            {/* Champs à tester */}
                            {pg.fieldsToTest?.length > 0 && (
                              <div style={{ display: "flex", gap: 4, marginTop: 5, flexWrap: "wrap" }}>
                                {pg.fieldsToTest.map(f => (
                                  <span key={f} style={{ fontSize: 9, fontWeight: 700, background: "#60a5fa20", color: "#2563eb", border: "1px solid #60a5fa40", borderRadius: 4, padding: "1px 6px" }}>{f.replace("_", " ")}</span>
                                ))}
                              </div>
                            )}
                            {/* Scénarios */}
                            {pg.scenarios.length > 0 && (
                              <div style={{ display: "flex", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
                                {pg.scenarios.map(s => (
                                  <span key={s} style={{ fontSize: 9, fontWeight: 700, background: "#b4530920", color: "#b45309", border: "1px solid #b4530940", borderRadius: 4, padding: "1px 6px" }}>
                                    {PAYMENT_SCENARIOS.find(x => x.id === s)?.label ?? s}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                          <ConfirmRemoveButton onConfirm={() => removePaymentGateway(i)} title="Supprimer cette passerelle" />
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Formulaire */}
                  <div style={S.draftBox("#fde68a", "#fffdf0")}>
                    <div style={S.label}>Ajouter une passerelle</div>

                    {/* Nom */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <label style={{ fontSize: 11, color: "#b45309", fontWeight: 700 }}>Nom *</label>
                      <input value={pgDraft.name} onChange={e => { setPgDraft(p => ({ ...p, name: e.target.value })); setPgError(""); }} placeholder="ex: Stripe, PayPal, CMI" style={S.inp(!!pgDraft.name)} />
                    </div>

                    {/* Méthode de paiement */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <label style={S.label}>Méthode de paiement</label>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {(["card", "iban", "both"] as const).map(m => (
                          <div key={m} onClick={() => {
                            const method = m;
                            const defaultFields: PaymentField[] = method === "card"
                              ? ["card_number", "card_expiry", "card_cvv", "card_holder"]
                              : method === "iban" ? ["iban", "amount"] : ["card_number", "card_expiry", "card_cvv", "card_holder", "iban"];
                            setPgDraft(p => ({ ...p, paymentMethod: method, fieldsToTest: defaultFields }));
                          }} style={{
                            padding: "6px 14px", borderRadius: 8, cursor: "pointer", fontSize: 11,
                            fontWeight: pgDraft.paymentMethod === m ? 800 : 500,
                            border: `1.5px solid ${pgDraft.paymentMethod === m ? "#b45309" : "#e2e8f0"}`,
                            background: pgDraft.paymentMethod === m ? "#fffbeb" : "#fff",
                            color: pgDraft.paymentMethod === m ? "#b45309" : "#64748b",
                          }}>
                            {m === "card" ? "💳 Carte" : m === "iban" ? "🏦 IBAN / RIB" : "💳 + 🏦 Les deux"}
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Champs à tester */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <label style={S.label}>Champs à couvrir par les TC</label>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {PAYMENT_FIELDS.filter(f =>
                          pgDraft.paymentMethod === "card" ? !f.id.startsWith("iban") :
                          pgDraft.paymentMethod === "iban" ? !["card_number","card_expiry","card_cvv","card_holder"].includes(f.id) : true
                        ).map(({ id, label, emoji }) => {
                          const checked = pgDraft.fieldsToTest.includes(id);
                          return (
                            <div key={id} onClick={() => togglePgField(id)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 8, cursor: "pointer", border: `1.5px solid ${checked ? "#2563eb" : "#e2e8f0"}`, background: checked ? "#eff6ff" : "#fff", fontSize: 11, fontWeight: checked ? 700 : 400, color: checked ? "#2563eb" : "#64748b" }}>
                              <div style={{ width: 14, height: 14, borderRadius: 3, flexShrink: 0, border: `2px solid ${checked ? "#2563eb" : "#cbd5e1"}`, background: checked ? "#2563eb" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "#fff", fontWeight: 900 }}>{checked ? "✓" : ""}</div>
                              {emoji} {label}
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Contraintes spécifiques */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <label style={{ fontSize: 11, color: "#64748b", fontWeight: 700 }}>📝 Contraintes spécifiques</label>
                      <input value={pgDraft.notes} onChange={e => setPgDraft(p => ({ ...p, notes: e.target.value }))} placeholder="ex: plafond 5000€/j, 3D Secure obligatoire, retry max 3 fois" style={S.inp(!!pgDraft.notes)} />
                    </div>

                    {/* Scénarios fonctionnels */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <label style={S.label}>Scénarios fonctionnels</label>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {PAYMENT_SCENARIOS.map(({ id, label }) => {
                          const checked = pgDraft.scenarios.includes(id);
                          return (
                            <div key={id} onClick={() => togglePgScenario(id)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 8, cursor: "pointer", border: `1.5px solid ${checked ? "#b45309" : "#e2e8f0"}`, background: checked ? "#fffbeb" : "#fff", fontSize: 11, fontWeight: checked ? 700 : 400, color: checked ? "#b45309" : "#64748b" }}>
                              <div style={{ width: 14, height: 14, borderRadius: 3, flexShrink: 0, border: `2px solid ${checked ? "#b45309" : "#cbd5e1"}`, background: checked ? "#b45309" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "#fff", fontWeight: 900 }}>{checked ? "✓" : ""}</div>
                              {label}
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {pgError && <div style={S.errBox()}>{pgError}</div>}
                    <button onClick={addPaymentGateway} style={S.addBtn("#b45309", "#fffbeb", "#b45309")}
                      onMouseEnter={e => { e.currentTarget.style.background = "#b45309"; e.currentTarget.style.color = "#fff"; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "#fffbeb"; e.currentTarget.style.color = "#b45309"; }}>
                      + Ajouter cette passerelle
                    </button>
                  </div>
                </div>
              )}

              {showDbSchema && (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <SectionDivider label="🗄 Contraintes DB" color="#1e40af" bg="#eff6ff" border="#bfdbfe" />
                  <div style={S.annotation("#1e40af")}>Déclarez les <strong>contraintes de colonnes</strong>.</div>
                  {(formData.dbConstraints ?? []).length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {(formData.dbConstraints ?? []).map((dc, i) => (
                        <div key={i} style={S.card("#bfdbfe", "#eff6ff")}>
                          <span style={{ fontSize: 14, flexShrink: 0 }}>🗄</span>
                          <div style={{ flex: 1 }}>
                            <span style={{ fontSize: 12, fontWeight: 800, color: "#1e40af" }}>{dc.column}</span>
                            <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                              {dc.notNull && <span style={{ fontSize: 10, fontWeight: 700, color: "#dc2626", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 4, padding: "1px 7px" }}>NOT NULL</span>}
                              {dc.unique && <span style={{ fontSize: 10, fontWeight: 700, color: "#1d4ed8", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 4, padding: "1px 7px" }}>UNIQUE</span>}
                              {dc.maxLength && <span style={{ fontSize: 10, fontWeight: 700, color: "#0f766e", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 4, padding: "1px 7px" }}>MAX: {dc.maxLength}</span>}
                            </div>
                          </div>
                          <ConfirmRemoveButton onConfirm={() => removeDbConstraint(i)} title="Supprimer cette contrainte" />
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={S.draftBox("#bfdbfe", "#f0f7ff")}>
                    <div style={S.label}>Ajouter une colonne</div>
                    <input value={dcDraft.column} onChange={e => { setDcDraft(p => ({ ...p, column: e.target.value })); setDcError(""); }} onKeyDown={e => e.key === "Enter" && addDbConstraint()} placeholder="ex: users.email" style={S.inp(!!dcDraft.column)} />
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <div style={S.checkRow()} onClick={() => setDcDraft(p => ({ ...p, notNull: !p.notNull }))}>
                        <div style={{ width: 16, height: 16, borderRadius: 4, border: `2px solid ${dcDraft.notNull ? "#dc2626" : "#cbd5e1"}`, background: dcDraft.notNull ? "#dc2626" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#fff", fontWeight: 900, flexShrink: 0 }}>{dcDraft.notNull ? "✓" : ""}</div>
                        <span style={{ fontSize: 12, color: dcDraft.notNull ? "#dc2626" : "#0f172a", fontWeight: dcDraft.notNull ? 700 : 400 }}>NOT NULL</span>
                      </div>
                      <div style={S.checkRow()} onClick={() => setDcDraft(p => ({ ...p, unique: !p.unique }))}>
                        <div style={{ width: 16, height: 16, borderRadius: 4, border: `2px solid ${dcDraft.unique ? "#1d4ed8" : "#cbd5e1"}`, background: dcDraft.unique ? "#1d4ed8" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#fff", fontWeight: 900, flexShrink: 0 }}>{dcDraft.unique ? "✓" : ""}</div>
                        <span style={{ fontSize: 12, color: dcDraft.unique ? "#1d4ed8" : "#0f172a", fontWeight: dcDraft.unique ? 700 : 400 }}>UNIQUE</span>
                      </div>
                    </div>
                    <input value={dcDraft.maxLength} onChange={e => setDcDraft(p => ({ ...p, maxLength: e.target.value }))} placeholder="Longueur max (ex: 255)" style={S.inp(!!dcDraft.maxLength)} />
                    {dcError && <div style={S.errBox()}>{dcError}</div>}
                    <button onClick={addDbConstraint} style={S.addBtn("#1e40af", "#eff6ff", "#1e40af")}
                      onMouseEnter={e => { e.currentTarget.style.background = "#1e40af"; e.currentTarget.style.color = "#fff"; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "#eff6ff"; e.currentTarget.style.color = "#1e40af"; }}>
                      + Ajouter cette colonne
                    </button>
                  </div>
                </div>
              )}


              {showAuth && (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <SectionDivider label="🔐 Authentification" color="#1d4ed8" bg="#eff6ff" border="#bfdbfe" />
                  <div style={S.annotation("#1d4ed8")}>Déclarez les <strong>paramètres d'authentification</strong>.</div>

                  {/* ── Récap affiché après Ajouter ── */}
                  {((formData.authContext?.roles ?? []).length > 0 ||
                    (formData.authContext?.passwordPolicy ?? "").trim() ||
                    (formData.authContext?.maxAttempts ?? "").trim() ||
                    (formData.authContext?.sessionDuration ?? "").trim() ||
                    (formData.authContext?.mfaType ?? "").trim() ||
                    (formData.authContext?.protectedResources ?? []).length > 0) && (
                    <div style={{ border: "1.5px solid #bfdbfe", borderRadius: 10, padding: "12px 14px", background: "#eff6ff", display: "flex", flexDirection: "column", gap: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", background: "#1d4ed820", border: "1px solid #1d4ed830", borderRadius: 6, fontSize: 14, flexShrink: 0 }}>🔐</span>
                        <span style={{ fontSize: 12, fontWeight: 800, color: "#0f172a", flex: 1 }}>Contexte d'authentification</span>
                        <ConfirmRemoveButton onConfirm={resetAuth} title="Réinitialiser le contexte d'authentification" />
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingLeft: 36 }}>
                        {(formData.authContext?.roles ?? []).length > 0 && (
                          <div style={{ fontSize: 11, color: "#475569" }}>
                            <span style={{ fontWeight: 700, color: "#1d4ed8" }}>👤 Rôles : </span>{(formData.authContext?.roles ?? []).join(", ")}
                          </div>
                        )}
                        {(formData.authContext?.passwordPolicy ?? "").trim() && (
                          <div style={{ fontSize: 11, color: "#475569" }}>
                            <span style={{ fontWeight: 700, color: "#1d4ed8" }}>🔒 Politique MDP : </span>{formData.authContext?.passwordPolicy}
                          </div>
                        )}
                        {(formData.authContext?.maxAttempts ?? "").trim() && (
                          <div style={{ fontSize: 11, color: "#475569" }}>
                            <span style={{ fontWeight: 700, color: "#1d4ed8" }}>🚫 Tentatives max : </span>{formData.authContext?.maxAttempts}
                          </div>
                        )}
                        {(formData.authContext?.sessionDuration ?? "").trim() && (
                          <div style={{ fontSize: 11, color: "#475569" }}>
                            <span style={{ fontWeight: 700, color: "#1d4ed8" }}>⏱ Durée session : </span>{formData.authContext?.sessionDuration}
                          </div>
                        )}
                        {(formData.authContext?.mfaType ?? "").trim() && (
                          <div style={{ fontSize: 11, color: "#475569" }}>
                            <span style={{ fontWeight: 700, color: "#1d4ed8" }}>🔑 MFA : </span>{formData.authContext?.mfaType}
                          </div>
                        )}
                       
                      </div>
                    </div>
                  )}

                  {/* ── Draft ── */}
                  <div style={S.draftBox("#bfdbfe", "#eff6ff")}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: "#1d4ed8", marginBottom: 2 }}>Ajouter les paramètres d'authentification</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <label style={{ fontSize: 11, color: "#1d4ed8", fontWeight: 700 }}>Rôles / profils</label>
                      <TagInput
                        tags={authDraft.roles}
                        onChange={v => setAuthDraft(p => ({ ...p, roles: v }))}
                        placeholder={"admin\nuser\nguest"}
                        tagColor="amber"
                        id="auth-draft-roles"
                        onSanitizerWarning={setAuthDraftRolesWarning}
                      />
                      {authDraftRolesWarning && <SanitizerInlineWarning offending={authDraftRolesWarning.offending} category={authDraftRolesWarning.category} />}
                    </div>
                    {selectedScope.has("auth_password_policy") && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        <label style={{ fontSize: 11, color: "#64748b", fontWeight: 700 }}>Politique de mot de passe</label>
                        <input
                          value={authDraft.passwordPolicy}
                          onChange={e => setAuthDraft(p => ({ ...p, passwordPolicy: e.target.value }))}
                          placeholder="ex: min 8 car., 1 majuscule"
                          style={S.inp(!!authDraft.passwordPolicy)}
                        />
                      </div>
                    )}
                    {selectedScope.has("auth_rate_limiting") && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        <label style={{ fontSize: 11, color: "#64748b", fontWeight: 700 }}>Tentatives max</label>
                        <input
                          value={authDraft.maxAttempts}
                          onChange={e => setAuthDraft(p => ({ ...p, maxAttempts: e.target.value }))}
                          placeholder="ex: 3, 5"
                          style={S.inp(!!authDraft.maxAttempts)}
                        />
                      </div>
                    )}
                    {selectedScope.has("auth_session") && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        <label style={{ fontSize: 11, color: "#64748b", fontWeight: 700 }}>Durée de session</label>
                        <input
                          value={authDraft.sessionDuration}
                          onChange={e => setAuthDraft(p => ({ ...p, sessionDuration: e.target.value }))}
                          placeholder="ex: 30 min, JWT exp: 1h"
                          style={S.inp(!!authDraft.sessionDuration)}
                        />
                      </div>
                    )}
                    {selectedScope.has("auth_mfa") && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        <label style={{ fontSize: 11, color: "#64748b", fontWeight: 700 }}>Type de MFA</label>
                        <input
                          value={authDraft.mfaType}
                          onChange={e => setAuthDraft(p => ({ ...p, mfaType: e.target.value }))}
                          placeholder="ex: TOTP, SMS, Email OTP"
                          style={S.inp(!!authDraft.mfaType)}
                        />
                      </div>
                    )}
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  
                      {authDraftProtectedWarning && <SanitizerInlineWarning offending={authDraftProtectedWarning.offending} category={authDraftProtectedWarning.category} />}
                    </div>
                    {authError && <div style={{ fontSize: 11, color: "#ef4444", fontWeight: 700 }}>{authError}</div>}
                    <button
                      onClick={addAuth}
                      style={{
                        alignSelf: "flex-start", padding: "8px 18px", border: "none",
                        background: "linear-gradient(135deg,#1d4ed8,#1e40af)",
                        borderRadius: 9, color: "#fff", fontWeight: 800,
                        cursor: "pointer", fontFamily: "inherit", fontSize: 12,
                        marginTop: 4, letterSpacing: "0.02em",
                      }}
                    >
                      + Ajouter
                    </button>
                  </div>
                </div>
              )}

              {!showFields && !showFiles && !showErrors && !showCondFlows && !showSteps && !showApiContracts && !showAuth && (
                <div style={{ textAlign: "center", padding: "32px 0", color: "#94a3b8", fontSize: 12, lineHeight: 1.8 }}>
                  Aucun scope sélectionné.<br />
                  <button onClick={() => setActiveTab("scope")} style={{ background: "none", border: "none", color: "#0f766e", cursor: "pointer", fontWeight: 700, fontFamily: "inherit", fontSize: 12, textDecoration: "underline", padding: 0 }}>Sélectionnez d'abord des scopes</button>
                </div>
              )}
            </div>
          )}

          {/* ══════════════════ VALID ══════════════════════════════════════ */}
          {activeTab === "valid" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={S.annotation("#0d9488")}>Entrez les données que le système doit <strong>accepter</strong> — une valeur par ligne.</div>

              {eligibleFields.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {(formData.fileInputs ?? []).length > 0 && (
                    <div style={S.sectionLabel("#0f766e")}>▤ Champs du formulaire</div>
                  )}
                  {eligibleFields.map(field => {
                    const typeDef = allFieldTypes.find(t => t.value === field.type) || FIELD_TYPES[0];
                    const vals = formData.validValues[field.name] ?? [];
                    const dispVals = displayData.validValues[field.name] ?? [];
                    const wasTranslated = isTranslated && JSON.stringify(vals) !== JSON.stringify(dispVals);
                    return (
                      <div key={field.name} style={{ display: "flex", flexDirection: "column", gap: 6, border: `1.5px solid ${wasTranslated ? "#93c5fd" : "#d1fae5"}`, borderRadius: 10, padding: "12px 14px", background: wasTranslated ? "#eff6ff" : "#f0fdf4" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                          <span style={{ width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", background: "#0f766e20", border: "1px solid #0f766e30", borderRadius: 6, fontSize: 11, fontWeight: 900, color: "#0f766e", flexShrink: 0 }}>{typeDef.emoji}</span>
                          <span style={{ fontSize: 12, fontWeight: 800, color: "#0f172a" }}>{field.name}</span>
                          {field.label !== field.name && <span style={{ fontSize: 11, color: "#64748b" }}>— {field.label}</span>}
                          <span style={{ fontSize: 10, color: "#64748b", background: "#e2e8f0", borderRadius: 5, padding: "1px 7px", marginLeft: "auto" }}>{field.type}</span>
                        </div>
                        <TagInput
                          tags={dispVals}
                          onChange={v => updateWithReset("validValues", { ...formData.validValues, [field.name]: v })}
                          placeholder={`Valeurs valides pour ${field.name}…`}
                          tagColor="green"
                          id={`tag-valid-${field.name}`}
                          translated={wasTranslated}
                          targetLang={targetLang}
                          onSanitizerWarning={w => setFieldWarning(`tag-valid-${field.name}`, w)}
                        />
                        {fieldWarnings[`tag-valid-${field.name}`] && <SanitizerInlineWarning offending={fieldWarnings[`tag-valid-${field.name}`]!.offending} category={fieldWarnings[`tag-valid-${field.name}`]!.category} />}
                        <div style={{ fontSize: 10, color: "#64748b" }}>💡 {typeDef.hint}</div>
                      </div>
                    );
                  })}
                </div>
              )}

              {(formData.fileInputs ?? []).length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {eligibleFields.length > 0 && (
                    <div style={S.sectionLabel("#0369a1")}>📎 Fichiers — formats &amp; taille acceptés</div>
                  )}
                  {(formData.fileInputs ?? []).map((fi, i) => (
                    <div key={fi.name} style={{ border: "1.5px solid #bfdbfe", borderRadius: 10, padding: "12px 14px", background: "#eff6ff", display: "flex", flexDirection: "column", gap: 10 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", background: "#0369a120", border: "1px solid #0369a130", borderRadius: 6, fontSize: 13, flexShrink: 0 }}>📎</span>
                        <span style={{ fontSize: 12, fontWeight: 800, color: "#0f172a" }}>{fi.name}</span>
                        <span style={{ fontSize: 10, color: "#64748b", background: "#e2e8f0", borderRadius: 5, padding: "1px 7px", marginLeft: "auto" }}>file</span>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        

                          <label style={{ fontSize: 11, color: "#0f766e", fontWeight: 700 }}>Formats acceptés</label>
                          <TagInput
                            tags={fi.acceptedFormats}
                            onChange={v => { const next = [...(formData.fileInputs ?? [])]; next[i] = { ...next[i], acceptedFormats: v }; update("fileInputs", next); }}
                            placeholder={"pdf\npng\njpg"}
                            tagColor="green"
                            id={`file-valid-accepted-${fi.name}`}
                            targetLang={targetLang}
                            onSanitizerWarning={w => setFieldWarning(`file-valid-accepted-${fi.name}`, w)}
                          />

                          {fieldWarnings[`file-valid-accepted-${fi.name}`] && <SanitizerInlineWarning offending={fieldWarnings[`file-valid-accepted-${fi.name}`]!.offending} category={fieldWarnings[`file-valid-accepted-${fi.name}`]!.category} />}
                        </div>

                      </div>

                   
                  ))}
                </div>
              )}

              <button onClick={() => setActiveTab("invalid")} style={{ padding: "8px 16px", border: "none", borderRadius: 9, background: "linear-gradient(135deg,#0f766e,#0d9488)", color: "#fff", fontWeight: 800, cursor: "pointer", fontFamily: "inherit", fontSize: 12, alignSelf: "flex-end" }}>
                Suivant — Cas invalides →
              </button>
            </div>
          )}

          {/* ══════════════════ INVALID ════════════════════════════════════ */}
          {activeTab === "invalid" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={S.annotation("#ef4444")}>Entrez les données que le système doit <strong>rejeter</strong> — une valeur par ligne.</div>

              {eligibleFields.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {(formData.fileInputs ?? []).length > 0 && (
                    <div style={S.sectionLabel("#ef4444")}>▤ Champs du formulaire</div>
                  )}
                  {eligibleFields.map(field => {
                    const typeDef = allFieldTypes.find(t => t.value === field.type) || FIELD_TYPES[0];
                    const vals = formData.invalidValues[field.name] ?? [];
                    const dispVals = displayData.invalidValues[field.name] ?? [];
                    const wasTranslated = isTranslated && JSON.stringify(vals) !== JSON.stringify(dispVals);
                    return (
                      <div key={field.name} style={{ display: "flex", flexDirection: "column", gap: 6, border: `1.5px solid ${wasTranslated ? "#93c5fd" : "#fecaca"}`, borderRadius: 10, padding: "12px 14px", background: wasTranslated ? "#eff6ff" : "#fef2f2" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                          <span style={{ width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", background: "#ef444420", border: "1px solid #ef444430", borderRadius: 6, fontSize: 11, fontWeight: 900, color: "#991b1b", flexShrink: 0 }}>{typeDef.emoji}</span>
                          <span style={{ fontSize: 12, fontWeight: 800, color: "#0f172a" }}>{field.name}</span>
                          {field.label !== field.name && <span style={{ fontSize: 11, color: "#64748b" }}>— {field.label}</span>}
                          <span style={{ fontSize: 10, color: "#64748b", background: "#e2e8f0", borderRadius: 5, padding: "1px 7px", marginLeft: "auto" }}>{field.type}</span>
                        </div>
                        <TagInput
                          tags={dispVals}
                          onChange={v => updateWithReset("invalidValues", { ...formData.invalidValues, [field.name]: v })}
                          placeholder={`Valeurs invalides pour ${field.name}…`}
                          tagColor="red"
                          id={`tag-invalid-${field.name}`}
                          translated={wasTranslated}
                          targetLang={targetLang}
                          onSanitizerWarning={w => setFieldWarning(`tag-invalid-${field.name}`, w)}
                        />
                        {fieldWarnings[`tag-invalid-${field.name}`] && <SanitizerInlineWarning offending={fieldWarnings[`tag-invalid-${field.name}`]!.offending} category={fieldWarnings[`tag-invalid-${field.name}`]!.category} />}
                        <div style={{ fontSize: 10, color: "#64748b" }}>💡 {typeDef.hint}</div>
                      </div>
                    );
                  })}
                </div>
              )}

              {(formData.fileInputs ?? []).length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {eligibleFields.length > 0 && (
                    <div style={S.sectionLabel("#dc2626")}>📎 Fichiers — formats rejetés</div>
                  )}
                  {(formData.fileInputs ?? []).map((fi, i) => (
                    <div key={fi.name} style={{ border: "1.5px solid #fca5a5", borderRadius: 10, padding: "12px 14px", background: "#fef2f2", display: "flex", flexDirection: "column", gap: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", background: "#ef444420", border: "1px solid #ef444430", borderRadius: 6, fontSize: 13, flexShrink: 0 }}>📎</span>
                        <span style={{ fontSize: 12, fontWeight: 800, color: "#0f172a" }}>{fi.name}</span>
                        <span style={{ fontSize: 10, color: "#64748b", background: "#e2e8f0", borderRadius: 5, padding: "1px 7px", marginLeft: "auto" }}>file</span>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        <label style={{ fontSize: 11, color: "#dc2626", fontWeight: 700 }}>Formats rejetés</label>
                        <TagInput
                          tags={fi.rejectedFormats}
                          onChange={v => { const next = [...(formData.fileInputs ?? [])]; next[i] = { ...next[i], rejectedFormats: v }; update("fileInputs", next); }}
                          placeholder={"exe\nsh\nzip"}
                          tagColor="red"
                          id={`file-invalid-rejected-${fi.name}`}
                          targetLang={targetLang}
                          onSanitizerWarning={w => setFieldWarning(`file-invalid-rejected-${fi.name}`, w)}
                        />
                        {fieldWarnings[`file-invalid-rejected-${fi.name}`] && <SanitizerInlineWarning offending={fieldWarnings[`file-invalid-rejected-${fi.name}`]!.offending} category={fieldWarnings[`file-invalid-rejected-${fi.name}`]!.category} />}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
                <div style={{ ...S.label, color: "#94a3b8", marginBottom: 0 }}>Règles métier (optionnel)</div>
                <TagInput
                  tags={displayData.businessRules}
                  onChange={v => updateWithReset("businessRules", v)}
                  placeholder="Ex : email unique par compte, expiration après 24h"
                  tagColor="amber"
                  id="tag-rules"
                  targetLang={targetLang}
                  onSanitizerWarning={w => setFieldWarning("tag-rules", w)}
                />
                {fieldWarnings["tag-rules"] && <SanitizerInlineWarning offending={fieldWarnings["tag-rules"]!.offending} category={fieldWarnings["tag-rules"]!.category} />}
              </div>
              <button onClick={() => setActiveTab("boundary")} style={{ padding: "8px 16px", border: "none", borderRadius: 9, background: "linear-gradient(135deg,#0f766e,#0d9488)", color: "#fff", fontWeight: 800, cursor: "pointer", fontFamily: "inherit", fontSize: 12, alignSelf: "flex-end" }}>
                Suivant — Limites →
              </button>
            </div>
          )}

          {/* ══════════════════ BOUNDARY ═══════════════════════════════════ */}
          {activeTab === "boundary" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={S.annotation("#f59e0b")}>
                Les bugs se cachent aux frontières. Renseignez les valeurs <strong>exactes</strong> par entrée.
              </div>

              {eligibleFields.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {(formData.fileInputs ?? []).length > 0 && (
                    <div style={S.sectionLabel("#f59e0b")}>▤ Champs du formulaire</div>
                  )}
                  {eligibleFields.map(field => {
                    const typeDef = allFieldTypes.find(t => t.value === field.type) || FIELD_TYPES[0];
                    const min = formData.minBoundary[field.name] ?? "";
                    const max = formData.maxBoundary[field.name] ?? "";
                    const oob = formData.outOfBounds[field.name] ?? "";
                    const dMin = displayData.minBoundary[field.name] ?? "";
                    const dMax = displayData.maxBoundary[field.name] ?? "";
                    const dOob = displayData.outOfBounds[field.name] ?? "";
                    const minT = isTranslated && dMin !== min;
                    const maxT = isTranslated && dMax !== max;
                    const oobT = isTranslated && dOob !== oob;
                    return (
                      <div key={field.name} style={{ border: "1.5px solid #fde68a", borderRadius: 10, padding: "12px 14px", background: "#fffbeb", display: "flex", flexDirection: "column", gap: 10 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", background: "#f59e0b20", border: "1px solid #f59e0b30", borderRadius: 6, fontSize: 11, fontWeight: 900, color: "#92400e", flexShrink: 0 }}>{typeDef.emoji}</span>
                          <span style={{ fontSize: 12, fontWeight: 800, color: "#0f172a" }}>{field.name}</span>
                          {field.label !== field.name && <span style={{ fontSize: 11, color: "#64748b" }}>— {field.label}</span>}
                          <span style={{ fontSize: 10, color: "#64748b", background: "#e2e8f0", borderRadius: 5, padding: "1px 7px", marginLeft: "auto" }}>{field.type}</span>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                          <StructuredInput id={`min-${field.name}`} label="Valeur minimale" hint="Plus petite valeur acceptée" placeholder="ex: 8 caractères, 0" value={dMin} onChange={v => updateWithReset("minBoundary", { ...formData.minBoundary, [field.name]: v })} translated={minT} targetLang={targetLang} />
                          <StructuredInput id={`max-${field.name}`} label="Valeur maximale" hint="Plus grande valeur acceptée" placeholder="ex: 254 caractères, 100" value={dMax} onChange={v => updateWithReset("maxBoundary", { ...formData.maxBoundary, [field.name]: v })} translated={maxT} targetLang={targetLang} />
                        </div>
                        <StructuredInput id={`oob-${field.name}`} label="Comportement hors limites" hint="Message d'erreur ou comportement attendu" placeholder='ex: "Valeur trop longue", code 422' value={dOob} onChange={v => updateWithReset("outOfBounds", { ...formData.outOfBounds, [field.name]: v })} translated={oobT} targetLang={targetLang} />
                        {(min || max) && (
                          <div style={{ background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 7, padding: "6px 10px", fontSize: 10, color: "#166534", lineHeight: 1.7, fontFamily: "'JetBrains Mono', monospace" }}>
                            TCs auto :{" "}
                            {min && <><strong>min-1</strong>, <strong>min exactement</strong>{max && ", "}</>}
                            {max && <><strong>max exactement</strong>, <strong>max+1</strong></>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {(formData.fileInputs ?? []).length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {eligibleFields.length > 0 && (
                    <div style={S.sectionLabel("#f59e0b")}>📎 Fichiers — limites de taille</div>
                  )}
                  {(formData.fileInputs ?? []).map((fi, i) => (
                    <div key={fi.name} style={{ border: "1.5px solid #fde68a", borderRadius: 10, padding: "12px 14px", background: "#fffbeb", display: "flex", flexDirection: "column", gap: 10 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", background: "#f59e0b20", border: "1px solid #f59e0b30", borderRadius: 6, fontSize: 13, flexShrink: 0 }}>📎</span>
                        <span style={{ fontSize: 12, fontWeight: 800, color: "#0f172a" }}>{fi.name}</span>
                        <span style={{ fontSize: 10, color: "#64748b", background: "#e2e8f0", borderRadius: 5, padding: "1px 7px", marginLeft: "auto" }}>file</span>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                        <StructuredInput
                          id={`file-min-${fi.name}`}
                          label="Taille minimale"
                          hint="Plus petit fichier accepté"
                          placeholder="ex: 1 octet, 0 KB"
                          value={fi.minSizeLabel}
                          onChange={v => { const next = [...(formData.fileInputs ?? [])]; next[i] = { ...next[i], minSizeLabel: v }; update("fileInputs", next); }}
                          targetLang={targetLang}
                        />
                        <StructuredInput
                          id={`file-max-${fi.name}`}
                          label="Taille maximale"
                          hint="Plus grand fichier accepté"
                          placeholder="ex: 5 Mo, 10 MB"
                          value={fi.maxSizeLabel}
                          onChange={v => { const next = [...(formData.fileInputs ?? [])]; next[i] = { ...next[i], maxSizeLabel: v }; update("fileInputs", next); }}
                          targetLang={targetLang}
                        />
                      </div>
                      {(fi.minSizeLabel || fi.maxSizeLabel) && (
                        <div style={{ background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 7, padding: "6px 10px", fontSize: 10, color: "#166534", lineHeight: 1.7, fontFamily: "'JetBrains Mono', monospace" }}>
                          TCs auto :{" "}
                          {fi.minSizeLabel && <><strong>min-1 octet</strong>, <strong>taille min exacte</strong>{fi.maxSizeLabel && ", "}</>}
                          {fi.maxSizeLabel && <><strong>taille max exacte</strong>, <strong>max+1 octet</strong></>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ══════════════════ SUMMARY ════════════════════════════════════ */}
          {activeTab === "summary" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* ── Token Budget Panel ───────────────────────────────── */}
              {(() => {
                const { total, status, thresholds, breakdown } = tokenBudget;
                const color  = status === "ok" ? "#0f766e" : status === "warning" ? "#b45309" : "#dc2626";
                const bg     = status === "ok" ? "#f0fdf4" : status === "warning" ? "#fffbeb" : "#fef2f2";
                const border = status === "ok" ? "#bbf7d0" : status === "warning" ? "#fde68a" : "#fecaca";
                const icon   = status === "ok" ? "✓" : status === "warning" ? "⚠" : "✗";
                const label  = status === "ok"
                  ? "Budget tokens confortable"
                  : status === "warning"
                    ? "Contexte chargé — risque de troncature"
                    : `Contexte trop volumineux — max ${thresholds.max} tok pour ce modèle`;
                const pct = Math.min(Math.round((total / thresholds.max) * 100), 100);
                const topItems = Object.entries(breakdown)
                  .filter(([, v]) => v > 0)
                  .sort(([, a], [, b]) => b - a)
                  .slice(0, 5);
                return (
                  <div style={{ padding: "12px 14px", background: bg, border: `1.5px solid ${border}`, borderRadius: 9 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, fontWeight: 800, color, marginBottom: 6 }}>
                      <span>{icon} Budget tokens · {model}</span>
                      <span>~{total} / {thresholds.max} tok</span>
                    </div>
                    <div style={{ height: 5, background: "#e2e8f0", borderRadius: 3, overflow: "hidden", marginBottom: 8 }}>
                      <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 3, transition: "width .4s ease" }} />
                    </div>
                    <div style={{ fontSize: 10, color: "#64748b", marginBottom: 8 }}>{label} · ctx {thresholds.ctxWindow}</div>
                    {topItems.length > 0 && (
                      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                        {topItems.map(([key, val]) => (
                          <span key={key} style={{ fontSize: 9, fontWeight: 700, background: "#f1f5f9", color: "#475569", border: "1px solid #e2e8f0", borderRadius: 4, padding: "1px 7px" }}>
                            {key} {val}tok
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}
              <QualityBar score={qualityScore} />
              {isTranslated && translatedData && (
                <div style={{ padding: "10px 14px", background: "#eff6ff", border: "1px solid #93c5fd", borderRadius: 9, fontSize: 12, color: "#1d4ed8" }}>
                  <div style={{ fontWeight: 800, marginBottom: 4 }}>✦ Traduction active — {SUPPORTED_LANGUAGES.find(l => l.code === targetLang)?.label}</div>
                  <div style={{ fontSize: 10, color: "#64748b" }}>Les TCs seront générés avec les valeurs traduites.</div>
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button onClick={handleApplyTranslation} style={{ padding: "6px 14px", border: "none", borderRadius: 8, background: "#1d4ed8", color: "#fff", fontWeight: 800, cursor: "pointer", fontFamily: "inherit", fontSize: 11 }}>✔ Appliquer définitivement</button>
                    <button onClick={handleDiscardTranslation} style={{ padding: "6px 14px", border: "1.5px solid #bfdbfe", borderRadius: 8, background: "#fff", color: "#64748b", fontWeight: 700, cursor: "pointer", fontFamily: "inherit", fontSize: 11 }}>✗ Annuler la traduction</button>
                  </div>
                </div>
              )}
              <div style={{ background: "#f8fafc", border: "1.5px solid #e2e8f0", borderRadius: 9, padding: "12px 14px", fontSize: 11, color: "#475569", lineHeight: 1.8 }}>
                <div style={{ fontWeight: 800, marginBottom: 6, color: "#0f172a" }}>Récapitulatif</div>
                {(() => {
                  const nValid = Object.values(formData.validValues).flat().length;
                  const nInvalid = Object.values(formData.invalidValues).flat().length;
                  const nOptions = Object.values(formData.fieldOptions ?? {}).flat().length;
                  return (
                    <div>
                      <span style={{ color: "#60a5fa", fontWeight: 700 }}>{selectedScope.size}</span> scope
                      {" · "}<span style={{ color: "#0f766e", fontWeight: 700 }}>{formData.fields.length}</span> champ{formData.fields.length !== 1 ? "s" : ""}
                      {choiceFields.length > 0 && <>{" · "}<span style={{ color: "#2563eb", fontWeight: 700 }}>{choiceFields.length}</span> liste/case ({nOptions} options)</>}
                      {(formData.fileInputs ?? []).length > 0 && <>{" · "}<span style={{ color: "#0369a1", fontWeight: 700 }}>{(formData.fileInputs ?? []).length}</span> fichier{(formData.fileInputs ?? []).length !== 1 ? "s" : ""}</>}
                      {" · "}<span style={{ color: "#0d9488", fontWeight: 700 }}>{nValid}</span> valide{nValid !== 1 ? "s" : ""}
                      {" · "}<span style={{ color: "#ef4444", fontWeight: 700 }}>{nInvalid}</span> invalide{nInvalid !== 1 ? "s" : ""}
                      {" · "}<span style={{ color: "#f59e0b", fontWeight: 700 }}>{formData.businessRules.length}</span> règle{formData.businessRules.length !== 1 ? "s" : ""}
                    </div>
                  );
                })()}
                {formData.fields.length > 0 && (
                  <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {formData.fields.map(f => {
                      const tf = allFieldTypes.find(t => t.value === f.type) || FIELD_TYPES[0];
                      const isChoice = isChoiceField(f.type);
                      const opts = (formData.fieldOptions ?? {})[f.name] ?? [];
                      return (
                        <span key={f.name} style={{ fontSize: 10, background: isChoice ? "#eff6ff" : "#0f766e15", border: `1px solid ${isChoice ? "#93c5fd" : "#0f766e30"}`, color: isChoice ? "#2563eb" : "#0f766e", borderRadius: 6, padding: "2px 8px", fontWeight: 700 }}>
                          {tf.emoji ? tf.emoji + " " : ""}{f.name} [{f.type}]{isChoice && opts.length > 0 ? ` (${opts.length})` : ""}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <div style={{ borderTop: "1.5px solid #e2e8f0", padding: "12px 22px", display: "flex", flexDirection: "column", gap: 8, background: "#fafbfc" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 10, color: "#94a3b8", fontWeight: 600 }}>
                {formData.fields.length} champ{formData.fields.length !== 1 ? "s" : ""}
                {" · "}{Object.values(formData.validValues).flat().length + Object.values(formData.invalidValues).flat().length} valeur{Object.values(formData.validValues).flat().length + Object.values(formData.invalidValues).flat().length !== 1 ? "s" : ""} · {qualityScore}% · <span style={{ color: tokenBudget.status === "ok" ? "#0f766e" : tokenBudget.status === "warning" ? "#b45309" : "#dc2626", fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 3 }}>
                    {tokenCountLoading
                      ? <><span style={{ width: 8, height: 8, border: `1.5px solid ${tokenBudget.status === "ok" ? "#0f766e" : tokenBudget.status === "warning" ? "#b45309" : "#dc2626"}`, borderTopColor: "transparent", borderRadius: "50%", animation: "qa-spin 0.7s linear infinite", display: "inline-block" }} /> calcul…</>
                      : <>{(realTokenCount === null || tokenCountEstimated) ? "~" : ""}{realTokenCount ?? tokenBudget.total}<span style={{ fontSize: 9, fontWeight: 500, opacity: 0.7 }}>tok{realTokenCount !== null && !tokenCountEstimated ? " ✓" : " ~"}</span></>
                    }
                  </span>
              </span>
              <button onClick={goPrev} disabled={isFirstTab} style={{ padding: "8px 14px", border: "1.5px solid #e2e8f0", background: isFirstTab ? "#f8fafc" : "#fff", borderRadius: 9, color: isFirstTab ? "#cbd5e1" : "#475569", fontWeight: 700, cursor: isFirstTab ? "not-allowed" : "pointer", fontFamily: "inherit", fontSize: 12 }}>
                ← Retour
              </button>
              <button onClick={goNext} disabled={isLastTab} style={{ padding: "8px 14px", border: "none", background: isLastTab ? "#94a3b8" : "linear-gradient(135deg,#0f766e,#0d9488)", borderRadius: 9, color: "#fff", fontWeight: 800, cursor: isLastTab ? "not-allowed" : "pointer", fontFamily: "inherit", fontSize: 12 }}>
                Suivant →
              </button>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={onClose} style={{ padding: "9px 18px", border: "1.5px solid #e2e8f0", background: "#fff", borderRadius: 9, color: "#475569", fontWeight: 700, cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Annuler</button>

              {/* ✅ MODIFIÉ : bouton Générer avec états loading / error / idle */}
              <button
                onClick={handleConfirm}
                disabled={!canGenerate || generationState === "loading" || !!liveGenerationLock}
                title={!!liveGenerationLock ? formatLockStatus(liveGenerationLock) : !canGenerate ? "Sélectionnez au moins un scope avant de générer" : ""}
                style={{
                  padding: "9px 22px", border: "none",
                  background: !canGenerate || generationState === "loading" || !!liveGenerationLock ? "#94a3b8" : generateBtnBg(),
                  borderRadius: 9, color: "#fff", fontWeight: 900,
                  cursor: !canGenerate || generationState === "loading" || !!liveGenerationLock ? "not-allowed" : "pointer",
                  fontFamily: "inherit", fontSize: 12, letterSpacing: "0.05em", transition: "all .2s",
                  // ✅ Légère pulsation quand en état d'erreur pour attirer l'attention
                  outline: generationState === "error" ? "2px solid #ef4444" : "none",
                  outlineOffset: 2,
                }}
              >
                {liveGenerationLock ? (liveGenerationLock.step === "form" ? `⏸ ${liveGenerationLock.actorName} configure aussi cette exigence` : "⏸ Génération en cours par un autre membre") : generateBtnLabel()}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Token Warning Modal ─────────────────────────────────────────── */}
      {tokenWarningPending && (() => {
        const { thresholds, breakdown } = tokenBudget;
        const displayTotal = realTokenCount ?? tokenBudget.total;
        // realTokenCount === null  → la requête /llm/token-count a complètement échoué (Nest down)
        // tokenCountEstimated      → Nest a répondu mais avec le fallback texte.length/4 (Python tokenizer-server down)
        const isEstimate   = realTokenCount === null || tokenCountEstimated;
        const topItems = Object.entries(breakdown)
          .filter(([, v]) => v > 0)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 6);
        const pct = Math.min(Math.round((displayTotal / thresholds.max) * 100), 100);
        return (
          <div style={{
            position: "fixed", inset: 0, zIndex: 3000,
            background: "rgba(2,6,23,.72)",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: 24,
          }}
            onClick={() => setTokenWarningPending(false)}
          >
            <div style={{
              background: "#ffffff", border: "1.5px solid #fde68a",
              borderRadius: 14, padding: "28px 28px 22px",
              width: "100%", maxWidth: 440,
              boxShadow: "0 24px 64px rgba(0,0,0,.6)",
              display: "flex", flexDirection: "column", gap: 16,
            }}
              onClick={e => e.stopPropagation()}
            >
              {/* Header */}
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                <span style={{ fontSize: 28, lineHeight: 1 }}>⚠</span>
                <div>
                  <div style={{ color: "#d97706", fontWeight: 800, fontSize: 15, marginBottom: 3 }}>
                    Contexte chargé
                  </div>
                  <div style={{ color: "#78716c", fontSize: 12 }}>
                    Le contexte du formulaire assisté risque d'être tronqué par le modèle.
                  </div>
                </div>
              </div>

              {/* Progress bar */}
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#64748b", marginBottom: 5 }}>
                  <span>
                    {tokenCountLoading ? "Calcul en cours..." : `${isEstimate ? "~" : ""}${displayTotal} tokens${isEstimate ? " (estimés)" : " (exact)"}`}
                  </span>
                  <span>max conseillé : {thresholds.ok} · toléré : {thresholds.max}</span>
                </div>
                <div style={{ height: 6, background: "#f1f5f9", borderRadius: 4, overflow: "hidden" }}>
                  <div style={{
                    height: "100%", borderRadius: 4,
                    width: `${pct}%`,
                    background: pct >= 100 ? "#ef4444" : isEstimate ? "#f59e0b" : "#d97706",
                    transition: "width .3s ease",
                  }} />
                </div>
                <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 4 }}>
                  Modèle : {model} · ctx window : {thresholds.ctxWindow} tokens
                </div>
              </div>

              {/* Breakdown top composantes */}
              <div>
                <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 6, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>
                  Composantes les plus lourdes
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {topItems.map(([key, val]) => {
                    const ratio = displayTotal > 0 ? val / displayTotal : 0;
                    return (
                      <div key={key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ width: 72, fontSize: 10, color: "#64748b", textAlign: "right", flexShrink: 0 }}>{key}</div>
                        <div style={{ flex: 1, height: 4, background: "#e2e8f0", borderRadius: 2, overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${Math.round(ratio * 100)}%`, background: "#f59e0b", borderRadius: 2 }} />
                        </div>
                        <div style={{ width: 40, fontSize: 10, color: "#d97706", fontWeight: 700, flexShrink: 0 }}>{val} tok</div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Conseil */}
              <div style={{
                background: "#fefce8", borderRadius: 8, padding: "10px 12px",
                fontSize: 11, color: "#78716c", lineHeight: 1.6,
              }}>
                💡 Pour réduire la consommation de tokens et le temps de génération : désélectionnez des scopes non essentiels, raccourcissez les règles métier ou réduisez le nombre de valeurs valides/invalides.
              </div>

              {/* Buttons */}
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 4 }}>
                <button
                  onClick={() => setTokenWarningPending(false)}
                  style={{
                    padding: "9px 18px", borderRadius: 8, border: "1px solid #e2e8f0",
                    background: "transparent", color: "#64748b", fontSize: 13, fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Annuler
                </button>
                <button
                  onClick={handleConfirmForce}
                  style={{
                    padding: "9px 20px", borderRadius: 8, border: "none",
                    background: "linear-gradient(135deg,#d97706,#f59e0b)",
                    color: "#ffffff", fontSize: 13, fontWeight: 800,
                    cursor: "pointer",
                  }}
                >
                  Générer quand même
                </button>
              </div>
            </div>
          </div>
        );
      })()}

    </div>
  );
}

export default AssistTest;