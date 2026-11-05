/**
 * ─── TRANSLATION SERVICE — Azure Translator (tier F0) ─────────────────────────
 *
 * Traduit automatiquement tout payload texte libre (FR ou autre) vers l'anglais
 * avant qu'il n'entre dans un prompt LLM. Appelé EXPLICITEMENT par chaque
 * prompt-builder dans prompt-builders.ts — pas d'interception globale.
 *
 * Stratégie :
 *  - Un seul appel HTTP batch par traduction (Azure accepte un tableau de
 *    segments dans une requête → 1 round-trip au lieu de N).
 *  - Cache en mémoire (clé = texte source) pour éviter de re-traduire deux fois
 *    la même chaîne (ex: businessRules répétées entre Phase A et Phase B).
 *  - Détection de langue intégrée à Azure (`from` omis) : si le texte est déjà
 *    en anglais, Azure le renvoie tel quel sans frais supplémentaires notables.
 *  - Fail-open : si la clé n'est pas configurée ou si l'appel échoue, on
 *    retourne le texte original (jamais bloquant pour la génération de TCs).
 */

import { Logger } from '@nestjs/common';
import axios from 'axios';
import { randomUUID } from 'crypto';
import type { FormDataInput } from './prompt-builders';

const logger = new Logger('TranslationService');

const AZURE_KEY      = process.env.AZURE_TRANSLATOR_KEY ?? '';
const AZURE_REGION   = process.env.AZURE_TRANSLATOR_REGION ?? '';
const AZURE_ENDPOINT = process.env.AZURE_TRANSLATOR_ENDPOINT ?? 'https://api.cognitive.microsofttranslator.com';
const TARGET_LANG    = 'en';

const ENABLED = !!AZURE_KEY && !!AZURE_REGION;

if (!ENABLED) {
  logger.warn('AZURE_TRANSLATOR_KEY / AZURE_TRANSLATOR_REGION absents — traduction auto désactivée (texte transmis tel quel).');
}

// ─── Cache mémoire simple (clé = texte exact) ─────────────────────────────────
const cache = new Map<string, string>();

// ─── Détection rapide "déjà en anglais" pour éviter un appel réseau inutile ───
// Heuristique STRICTE : on ne skip que les cas évidents (token technique unique,
// nombre, URL...). Par défaut on envoie TOUJOURS à Azure — moins fiable de deviner
// localement que de laisser Azure détecter la langue lui-même. Le quota F0 (2M
// caractères/mois) couvre largement ce volume de texte de formulaire.
function looksAlreadyEnglish(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) return true;
  // Un seul "mot" technique sans espace (ex: "email", "password", "FR-01", "/register")
  // → pas la peine de traduire un identifiant/token.
  const isSingleTechnicalToken = !/\s/.test(trimmed) && /^[A-Za-z0-9_\-\/.:]+$/.test(trimmed);
  if (isSingleTechnicalToken) return true;
  // Nombre seul (ex: "8", "254")
  if (/^\d+$/.test(trimmed)) return true;
  return false;
}

// ─── Appel Azure Translator (batch) ───────────────────────────────────────────
async function azureTranslateBatch(texts: string[]): Promise<string[]> {
  if (!ENABLED || texts.length === 0) return texts;

  try {
    const response = await axios({
      baseURL: AZURE_ENDPOINT,
      url: '/translate',
      method: 'post',
      headers: {
        'Ocp-Apim-Subscription-Key': AZURE_KEY,
        'Ocp-Apim-Subscription-Region': AZURE_REGION,
        'Content-Type': 'application/json',
        'X-ClientTraceId': randomUUID(),
      },
      params: { 'api-version': '3.0', to: TARGET_LANG },
      data: texts.map(text => ({ text })),
      timeout: 8000,
    });

    return (response.data as any[]).map((item, i) => item?.translations?.[0]?.text ?? texts[i]);
  } catch (err: any) {
    logger.warn(`Azure Translator a échoué — texte original conservé. ${err?.message ?? err}`);
    return texts;
  }
}

/**
 * Traduit un tableau de chaînes vers l'anglais, avec cache + skip si déjà EN.
 * C'est la fonction de base utilisée par toutes les autres helpers ci-dessous.
 */
export async function translateBatch(texts: string[]): Promise<string[]> {
  const toTranslate: string[] = [];
  const indices: number[] = [];

  texts.forEach((t, i) => {
    if (!t || cache.has(t) || looksAlreadyEnglish(t)) return;
    toTranslate.push(t);
    indices.push(i);
  });

  const result = [...texts];

  if (toTranslate.length > 0) {
    const translated = await azureTranslateBatch(toTranslate);
    translated.forEach((tr, j) => {
      const original = toTranslate[j];
      cache.set(original, tr);
      result[indices[j]] = tr;
    });
  }

  // Appliquer le cache aux entrées déjà connues (non envoyées au réseau)
  return result.map(t => cache.get(t) ?? t);
}

/** Traduit une seule chaîne. Préférer translateBatch() pour plusieurs champs. */
export async function translateText(text?: string): Promise<string> {
  if (!text?.trim()) return text ?? '';
  const [out] = await translateBatch([text]);
  return out;
}

/**
 * Traduit les titres d'une liste de TCs existants (ex: tc.title édité manuellement
 * via le CRUD llm-viewer) en un seul appel batch.
 */
export async function translateExistingTCs<T extends { title: string }>(tcs: T[]): Promise<T[]> {
  if (!tcs || tcs.length === 0) return tcs;
  const titles = tcs.map(tc => tc.title);
  const translated = await translateBatch(titles);
  return tcs.map((tc, i) => ({ ...tc, title: translated[i] }));
}

/** Traduit une liste de titres libres (ex: forbiddenTitles) en un seul appel batch. */
export async function translateTitles(titles: string[]): Promise<string[]> {
  if (!titles || titles.length === 0) return titles;
  return translateBatch(titles);
}


// ─── Traduction d'un FormDataInput complet (formulaire wizard + business rules) ─
//
// Parcourt tous les champs texte libre (labels, valeurs, règles métier, messages
// d'erreur, conditions, etc.), les regroupe en UN SEUL appel batch, puis reconstruit
// un FormDataInput identique en structure mais traduit.

export async function translateFormData(formData?: FormDataInput): Promise<FormDataInput | undefined> {
  if (!formData) return formData;

  // 1) Collecter toutes les chaînes à traduire avec un chemin de retour (setter)
  const collected: string[] = [];
  const setters: ((translated: string) => void)[] = [];
  const out: FormDataInput = JSON.parse(JSON.stringify(formData)); // clone profond

  function register(value: string | undefined, setter: (v: string) => void) {
    if (!value?.trim()) return;
    collected.push(value);
    setters.push(setter);
  }
  function registerArray(arr: string[] | undefined, replaceAt: (i: number, v: string) => void) {
    if (!arr) return;
    arr.forEach((v, i) => register(v, (t) => replaceAt(i, t)));
  }
  function registerRecord(rec: Record<string, string[]> | undefined) {
    if (!rec) return;
    for (const key of Object.keys(rec)) {
      rec[key].forEach((v, i) => register(v, (t) => { rec[key][i] = t; }));
    }
  }
  function registerStringOrRecord(
    val: string | Record<string, string> | undefined,
    setFlat: (t: string) => void,
  ) {
    if (!val) return;
    if (typeof val === 'string') {
      register(val, setFlat);
    } else {
      for (const key of Object.keys(val)) {
        register(val[key], (t) => { val[key] = t; });
      }
    }
  }

  // fields (name + label — tous deux potentiellement écrits par l'utilisateur)
  out.fields?.forEach((f, i) => {
    register(f.name,  (t) => { out.fields![i].name  = t; });
    register(f.label, (t) => { out.fields![i].label = t; });
  });

  // validValues / invalidValues (array ou Record)
  if (Array.isArray(out.validValues)) {
    registerArray(out.validValues, (i, t) => { (out.validValues as string[])[i] = t; });
  } else {
    registerRecord(out.validValues as Record<string, string[]> | undefined);
  }
  if (Array.isArray(out.invalidValues)) {
    registerArray(out.invalidValues, (i, t) => { (out.invalidValues as string[])[i] = t; });
  } else {
    registerRecord(out.invalidValues as Record<string, string[]> | undefined);
  }

  // businessRules — explicitement demandé
  registerArray(out.businessRules, (i, t) => { out.businessRules![i] = t; });

  // bounds (string ou Record)
  registerStringOrRecord(out.minBoundary, (t) => { out.minBoundary = t; });
  registerStringOrRecord(out.maxBoundary, (t) => { out.maxBoundary = t; });
  registerStringOrRecord(out.outOfBounds, (t) => { out.outOfBounds = t; });

  // fileInputs
  out.fileInputs?.forEach((fi, i) => {
    register(fi.maxSizeLabel, (t) => { out.fileInputs![i].maxSizeLabel = t; });
    register(fi.minSizeLabel, (t) => { out.fileInputs![i].minSizeLabel = t; });
    register(fi.mimeNote,     (t) => { out.fileInputs![i].mimeNote     = t; });
  });

  // errorMessages
  out.errorMessages?.forEach((em, i) => {
    register(em.text, (t) => { out.errorMessages![i].text = t; });
  });

  // conditionalFlows
  out.conditionalFlows?.forEach((cf, i) => {
    register(cf.condition,   (t) => { out.conditionalFlows![i].condition   = t; });
    register(cf.trueBranch,  (t) => { out.conditionalFlows![i].trueBranch  = t; });
    register(cf.falseBranch, (t) => { out.conditionalFlows![i].falseBranch = t; });
  });

  // steps (labels)
  out.steps?.forEach((s, i) => {
    register(s.label, (t) => { out.steps![i].label = t; });
  });

  // paymentGateways (scenarios)
  out.paymentGateways?.forEach((pg, i) => {
    registerArray(pg.scenarios, (j, t) => { out.paymentGateways![i].scenarios[j] = t; });
  });

  // authContext
  if (out.authContext) {
    register(out.authContext.passwordPolicy,  (t) => { out.authContext!.passwordPolicy  = t; });
    register(out.authContext.maxAttempts,     (t) => { out.authContext!.maxAttempts     = t; });
    register(out.authContext.sessionDuration, (t) => { out.authContext!.sessionDuration = t; });
    register(out.authContext.mfaType,         (t) => { out.authContext!.mfaType         = t; });
    registerArray(out.authContext.protectedResources, (i, t) => { out.authContext!.protectedResources[i] = t; });
  }

  // legacy
  registerArray(out.validInputClasses,   (i, t) => { out.validInputClasses![i]   = t; });
  registerArray(out.invalidInputClasses, (i, t) => { out.invalidInputClasses![i] = t; });

  if (collected.length === 0) return out;

  // 2) UN SEUL appel batch pour tout le formData
  const translated = await translateBatch(collected);
  translated.forEach((t, i) => setters[i](t));

  return out;
}