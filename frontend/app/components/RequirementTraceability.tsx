"use client";
/**
 * RequirementTraceability — Traçabilité des exigences générées
 * ───────────────────────────────────────────────────────────────
 * Pour chaque exigence affichée dans l'onglet "Modules", lance en arrière-plan
 * une recherche sémantique dans le SRS indexé (endpoint existant
 * `POST /srs/:projectId/search`, utilisé aussi par "🔍 Recherche intelligente")
 * et affiche le passage source le plus proche avec son score de similarité,
 * sous forme de badge discret.
 *
 * Cliquer sur le badge ouvre une fenêtre dédiée (modale), reprenant le même
 * habillage visuel que l'onglet "Recherche intelligente" (cartes d'extraits,
 * barre de score, "Voir plus / Copier"), pour servir de preuve/justification
 * de l'exigence — SANS toucher au prompt de génération ni à aucune logique
 * métier existante.
 */

import { useEffect, useRef, useState } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────
interface SrsChunk {
  id: string;
  text: string;
  score: number;
}
interface TraceResult {
  chunks: SrsChunk[];
  source: string | null;
}
type TraceState = "loading" | "ready" | "empty" | "error";

// ─── Cache + dédup des requêtes en mémoire (par session onglet) ───────────────
const traceCache = new Map<string, TraceResult>();
const traceErrors = new Set<string>();
const inFlight = new Map<string, Promise<TraceResult>>();

function cacheKey(projectId: string, question: string) {
  return `${projectId}::${question}`;
}

async function fetchTrace(
  apiBaseUrl: string,
  projectId: string,
  question: string,
): Promise<TraceResult> {
  const key = cacheKey(projectId, question);
  const cached = traceCache.get(key);
  if (cached) return cached;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const p = (async () => {
    const res = await fetch(`${apiBaseUrl}/srs/${projectId}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, topK: 3 }),
    });
    if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
    const json = await res.json();
    const result: TraceResult = {
      chunks: Array.isArray(json?.chunks) ? json.chunks : [],
      source: json?.source ?? null,
    };
    traceCache.set(key, result);
    return result;
  })();

  inFlight.set(key, p);
  try {
    return await p;
  } finally {
    inFlight.delete(key);
  }
}

// ─── Petits utilitaires texte (mêmes règles que "Recherche intelligente") ─────
function escapeRegExp(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function highlightRelevantText(text: string, query: string) {
  const words = Array.from(new Set(query.split(/\s+/).map(w => w.trim()).filter(w => w.length >= 3)));
  if (words.length === 0) return text;
  const pattern = new RegExp(`(${words.map(escapeRegExp).join("|")})`, "gi");
  const parts = text.split(pattern);
  return parts.map((part, i) =>
    words.some(w => w.toLowerCase() === part.toLowerCase())
      ? <mark key={i} className="bg-zumthor text-primary dark:bg-primary/20 dark:text-white rounded px-0.5">{part}</mark>
      : <span key={i}>{part}</span>
  );
}

function extractReqId(text: string): string | null {
  const m = text.match(/\b(FR|NFR|REQ|REQUIREMENT|US|UC)[-\s]?\d+(?:\.\d+)*\b/i);
  return m ? m[0].toUpperCase().replace(/\s+/, "-") : null;
}

function extractSectionTitle(text: string): { title: string | null; body: string } {
  const m = text.match(/^##\s*(.+?)\n+([\s\S]*)$/);
  if (m) return { title: m[1].trim(), body: m[2].trim() };
  return { title: null, body: text.trim() };
}

function scoreClasses(pct: number) {
  if (pct >= 85) return { bar: "bg-meta", text: "text-meta" };
  if (pct >= 70) return { bar: "bg-amber-500", text: "text-amber-600 dark:text-amber-400" };
  return { bar: "bg-waterloo", text: "text-waterloo" };
}

function Spinner() {
  return <span className="inline-block w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />;
}

// ─── Badge (déclenche la recherche en arrière-plan) ───────────────────────────
export function TraceabilityBadge({
  apiBaseUrl, projectId, reqId, reqDescription,
}: {
  apiBaseUrl: string;
  projectId: string | null | undefined;
  reqId: string;
  reqDescription: string;
}) {
  const [state, setState] = useState<TraceState>("loading");
  const [result, setResult] = useState<TraceResult | null>(null);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    if (!projectId || !reqDescription?.trim()) return;
    const key = cacheKey(projectId, reqDescription);
    let cancelled = false;

    if (traceCache.has(key)) {
      const r = traceCache.get(key)!;
      setResult(r);
      setState(r.chunks.length > 0 ? "ready" : "empty");
      return;
    }
    if (traceErrors.has(key)) { setState("error"); return; }

    setState("loading");
    fetchTrace(apiBaseUrl, projectId, reqDescription)
      .then(r => {
        if (cancelled) return;
        setResult(r);
        setState(r.chunks.length > 0 ? "ready" : "empty");
      })
      .catch(() => {
        traceErrors.add(key);
        if (!cancelled) setState("error");
      });

    return () => { cancelled = true; };
  }, [apiBaseUrl, projectId, reqDescription]);

  if (!projectId) return null;

  if (state === "loading") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-waterloo">
        <Spinner /> Recherche dans le SRS...
      </span>
    );
  }

  if (state === "error") {
    return (
      <span className="text-[11px] text-waterloo" title="La recherche sémantique dans le SRS a échoué">
        📄 Traçabilité indisponible
      </span>
    );
  }

  if (state === "empty") {
    return <span className="text-[11px] text-waterloo">📄 Aucun passage SRS correspondant trouvé</span>;
  }

  const pct = Math.round(Math.max(0, Math.min(1, result!.chunks[0].score)) * 100);
  const { bar, text } = scoreClasses(pct);

  return (
    <>
      <button
        onClick={() => setShowModal(true)}
        title="Voir la justification dans le SRS"
        className="inline-flex items-center gap-2 rounded-full border border-stroke dark:border-strokedark bg-white dark:bg-blacksection pl-3 pr-3 py-1 hover:border-primary/40 transition-all"
      >
        <span className="text-[11px] font-bold text-waterloo">📄 Basé sur : extrait du SRS</span>
        <span className="h-1.5 w-10 rounded-full bg-alabaster dark:bg-black/30 overflow-hidden">
          <span className={`h-full block rounded-full ${bar}`} style={{ width: `${pct}%` }} />
        </span>
        <span className={`text-[11px] font-bold ${text}`}>{pct}% match</span>
      </button>

      {showModal && (
        <TraceabilityModal
          reqId={reqId}
          reqDescription={reqDescription}
          result={result!}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  );
}

// ─── Carte d'extrait — identique visuellement à SrsResultCard ────────────────
function TraceResultCard({ chunk, query, index }: { chunk: SrsChunk; query: string; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const { title, body } = extractSectionTitle(chunk.text || "");
  const reqIdInChunk = extractReqId(body);
  const scorePct = chunk.score !== undefined ? Math.round(Math.max(0, Math.min(1, chunk.score)) * 100) : null;
  const isLong = body.length > 320;
  const displayText = expanded || !isLong ? body : body.slice(0, 320).trimEnd() + "…";
  const { bar, text } = scorePct !== null ? scoreClasses(scorePct) : { bar: "", text: "" };

  const handleCopy = () => {
    navigator.clipboard?.writeText(chunk.text || "").then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="bg-white dark:bg-blacksection border border-stroke dark:border-strokedark rounded-xl p-4">
      <div className="flex items-center justify-between mb-2 gap-2">
        {reqIdInChunk ? (
          <span className="text-[11px] font-bold text-primary bg-zumthor dark:bg-blackho border border-primary/30 rounded px-2 py-0.5">{reqIdInChunk}</span>
        ) : (
          <span className="text-[11px] font-bold text-waterloo bg-alabaster dark:bg-black/30 border border-stroke dark:border-strokedark rounded px-2 py-0.5">
            {index === 0 ? "📄 Passage le plus proche" : `Extrait #${index + 1}`}
          </span>
        )}
        {scorePct !== null && (
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-14 rounded-full bg-alabaster dark:bg-black/30 overflow-hidden">
              <div className={`h-full rounded-full ${bar}`} style={{ width: `${scorePct}%` }} />
            </div>
            <span className={`text-[11px] font-bold ${text}`}>{scorePct}%</span>
          </div>
        )}
      </div>

      {title && <p className="text-[11px] font-bold text-waterloo mb-1.5">{title}</p>}

      <p className="text-xs text-black dark:text-manatee leading-relaxed" style={{ whiteSpace: "pre-wrap" }}>
        {highlightRelevantText(displayText, query)}
      </p>

      <div className="flex items-center gap-4 mt-2.5">
        {isLong && (
          <button onClick={() => setExpanded(v => !v)} className="text-[11px] font-bold text-primary hover:underline">
            {expanded ? "Voir moins" : "Voir plus"}
          </button>
        )}
        <button onClick={handleCopy} className="text-[11px] font-bold text-waterloo hover:text-black dark:hover:text-white">
          {copied ? "✓ Copié" : "Copier"}
        </button>
      </div>
    </div>
  );
}

// ─── Fenêtre dédiée (modale) ───────────────────────────────────────────────────
function TraceabilityModal({
  reqId, reqDescription, result, onClose,
}: {
  reqId: string;
  reqDescription: string;
  result: TraceResult;
  onClose: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      ref={overlayRef}
      onClick={e => { if (e.target === overlayRef.current) onClose(); }}
      className="fixed inset-0 z-[1000] bg-black/50 dark:bg-black/70 flex items-center justify-center p-5"
    >
      <div className="w-full max-w-2xl max-h-[85vh] overflow-y-auto bg-white dark:bg-blacksection border border-stroke dark:border-strokedark rounded-2xl shadow-solid-4">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-white dark:bg-blacksection border-b border-stroke dark:border-strokedark px-6 py-4 flex items-start justify-between gap-3 rounded-t-2xl">
          <div className="min-w-0">
            <h3 className="text-base font-bold text-black dark:text-white flex items-center flex-wrap gap-2">
              🔍 Traçabilité de l'exigence
              <span className="text-[11px] font-bold text-primary bg-zumthor dark:bg-blackho border border-primary/30 rounded px-2 py-0.5">{reqId}</span>
            </h3>
            <p className="text-xs text-waterloo mt-1.5 leading-relaxed">{reqDescription}</p>
          </div>
          <button
            onClick={onClose}
            className="flex-shrink-0 w-8 h-8 rounded-lg border border-stroke dark:border-strokedark text-waterloo hover:text-black dark:hover:text-white hover:border-primary/40 flex items-center justify-center transition-all"
          >✕</button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-3">
          <p className="text-xs text-waterloo">
            {result.chunks.length} passage(s) pertinent(s){result.source ? ` — ${result.source}` : ""} — utilisés comme preuve/justification, sans influencer la génération des cas de test.
          </p>
          {result.chunks.map((chunk, i) => (
            <TraceResultCard key={chunk.id ?? i} chunk={chunk} query={reqDescription} index={i} />
          ))}
        </div>
      </div>
    </div>
  );
}