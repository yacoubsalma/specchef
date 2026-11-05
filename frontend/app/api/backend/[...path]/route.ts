import { NextRequest, NextResponse } from 'next/server';
import * as http from 'node:http';
import * as https from 'node:https';
import { getSessionTokens, setAccessTokenCookie, clearSessionCookies } from '@/lib/session';

/**
 * Proxy générique vers le backend NestJS (http://localhost:3000).
 *
 * Le frontend (composants client) appelle `/api/backend/...` au lieu
 * d'appeler directement le backend. Cette route :
 *  1. récupère l'access token depuis le cookie httpOnly,
 *  2. l'ajoute en header Authorization,
 *  3. si le backend répond 401 (token expiré), tente un refresh
 *     automatique via /auth/refresh-token, met à jour le cookie,
 *     puis réessaie la requête une seule fois,
 *  4. si le refresh échoue aussi, supprime les cookies et renvoie 401
 *     (le client redirige alors vers /login).
 *
 * Body, headers utiles (Content-Type), query string et méthode HTTP
 * sont transmis tels quels. Le streaming de fichiers (upload/download)
 * est supporté.
 *
 * ⚠️ IMPORTANT : on utilise le module `http`/`https` natif de Node ici,
 * PAS `fetch()`. Le `fetch()` global de Node (basé sur undici) a un
 * timeout headers/body interne (~5 min selon la version) qui ne peut
 * PAS être désactivé de façon fiable via `signal: AbortSignal.timeout()`
 * (ce signal ajoute un abandon volontaire EN PLUS du timeout interne,
 * il ne le remplace pas — voir nodejs/undici#1373, #1864, #4215).
 * Passer un `dispatcher` custom à fetch() ne fonctionne pas non plus de
 * façon fiable car Next.js intercepte/surcharge le fetch global.
 * Le module http/https natif, lui, expose un vrai contrôle de timeout
 * (`req.setTimeout()` / option `timeout`) qui fonctionne comme attendu.
 * Les générations LLM (Ollama) peuvent prendre plusieurs minutes
 * (~7-8 min observées en pratique sur de gros requirements) — il faut
 * donc un timeout réellement configurable et long ici.
 */

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const PROXY_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS) || 25 * 60 * 1000; // 25 minutes par défaut — marge pour les requirements à beaucoup d'angles (Mode Création) ou Phase B lente

// Requis : ce handler utilise les modules natifs node:http/node:https,
// non disponibles dans le runtime Edge. C'est déjà le défaut pour les
// Route Handlers Next.js, mais on le déclare explicitement pour éviter
// toute régression si quelqu'un ajoute `export const runtime = 'edge'`
// ailleurs dans le projet par erreur.
export const runtime = 'nodejs';
// Cette route fait un vrai appel réseau à chaque requête ; pas de cache.
export const dynamic = 'force-dynamic';
// Sur une plateforme serverless (Vercel...), la durée d'exécution d'une
// route est limitée par défaut (souvent 10-60s selon le plan). En local
// (next dev / next start sur un serveur classique) cette directive n'a
// aucun effet négatif. Alignée sur PROXY_TIMEOUT_MS.
export const maxDuration = 1500; // littéral requis par Next.js (= 25 min, valeur par défaut de PROXY_TIMEOUT_MS)

// On ne relaie pas les headers de négociation de cache conditionnel
// (If-None-Match / If-Modified-Since). Ce proxy sert une API JSON
// dynamique (pas des assets statiques) ; certains endpoints sont pollés
// régulièrement par le frontend (ex: SaturationBanner toutes les 30s) et
// si Express/NestJS répond 304 sur la base de ces headers, le client
// reçoit une réponse vide qu'il doit gérer comme un cas spécial pour
// rien — il vaut mieux que chaque appel reçoive toujours le JSON complet.
const STRIPPED_REQUEST_HEADERS = new Set([
  'host', 'connection', 'content-length',
  'if-none-match', 'if-modified-since',
]);
const STRIPPED_RESPONSE_HEADERS = new Set(['content-encoding', 'transfer-encoding', 'connection']);

interface ProxyResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

class ProxyTimeoutError extends Error {
  constructor() {
    super(`La requête a dépassé le délai maximum (${PROXY_TIMEOUT_MS / 1000}s) sans réponse du backend.`);
    this.name = 'ProxyTimeoutError';
  }
}

class ProxyConnectionError extends Error {
  constructor(cause?: unknown) {
    super(`Le serveur backend ne répond pas. Vérifiez qu'il est lancé sur ${BACKEND_URL}`);
    this.name = 'ProxyConnectionError';
    if (cause) (this as any).cause = cause;
  }
}

/**
 * Requête HTTP brute vers le backend, avec un timeout long et fiable.
 * Pas de dépendance à fetch()/undici : on pilote directement le socket.
 */
function rawRequest(
  targetUrl: string,
  method: string,
  headers: Record<string, string>,
  body: Buffer | null,
): Promise<ProxyResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        timeout: PROXY_TIMEOUT_MS, // timeout d'inactivité sur le socket
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 502,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on('error', (err) => reject(new ProxyConnectionError(err)));
      },
    );

    // Timeout explicite et global pour toute la requête (au-delà du timeout
    // d'inactivité du socket ci-dessus) — couvre le cas d'une connexion lente
    // mais "active" qui dépasserait quand même la durée maximale tolérée.
    const hardTimeout = setTimeout(() => {
      req.destroy();
      reject(new ProxyTimeoutError());
    }, PROXY_TIMEOUT_MS);

    req.on('timeout', () => {
      req.destroy();
      reject(new ProxyTimeoutError());
    });

    req.on('error', (err: any) => {
      clearTimeout(hardTimeout);
      if (err?.code === 'ECONNRESET' && err.message?.includes('aborted')) {
        reject(new ProxyTimeoutError());
      } else {
        reject(new ProxyConnectionError(err));
      }
    });

    req.on('close', () => clearTimeout(hardTimeout));

    if (body && body.length > 0) {
      req.write(body);
    }
    req.end();
  });
}

async function tryRefresh(refreshToken: string): Promise<string | null> {
  try {
    const res = await rawRequest(
      `${BACKEND_URL}/auth/refresh-token`,
      'POST',
      { 'Content-Type': 'application/json' },
      Buffer.from(JSON.stringify({ refreshToken })),
    );
    if (res.status < 200 || res.status >= 300) return null;
    const data = JSON.parse(res.body.toString('utf-8') || '{}');
    return data?.token ?? null;
  } catch {
    return null;
  }
}

function buildTargetUrl(request: NextRequest, path: string[]): string {
  const search = request.nextUrl.search; // inclut le '?' si présent
  return `${BACKEND_URL}/${path.join('/')}${search}`;
}

function forwardableHeaders(request: NextRequest, token?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (!STRIPPED_REQUEST_HEADERS.has(lower) && lower !== 'authorization') {
      headers[key] = value;
    }
  });
  if (token) headers['authorization'] = `Bearer ${token}`;
  return headers;
}

async function doRequest(
  request: NextRequest,
  targetUrl: string,
  token: string | undefined,
  bodyBuffer: Buffer | null,
): Promise<ProxyResponse> {
  return rawRequest(targetUrl, request.method, forwardableHeaders(request, token), bodyBuffer);
}

async function handler(request: NextRequest, params: { path: string[] }) {
  const { path } = params;
  const targetUrl = buildTargetUrl(request, path);

  const { token, refreshToken } = await getSessionTokens();

  // Les requêtes GET/HEAD n'ont pas de body ; pour les autres on lit le buffer
  // une seule fois pour pouvoir le rejouer si on doit refresh + réessayer.
  const hasBody = !['GET', 'HEAD'].includes(request.method);
  const bodyArrayBuffer = hasBody ? await request.arrayBuffer() : null;
  const bodyBuffer = bodyArrayBuffer ? Buffer.from(bodyArrayBuffer) : null;

  let backendRes: ProxyResponse;
  try {
    backendRes = await doRequest(request, targetUrl, token, bodyBuffer);
  } catch (err: any) {
    const isTimeout = err instanceof ProxyTimeoutError;
    return NextResponse.json(
      {
        message: isTimeout
          ? `${err.message} Si la génération LLM est juste longue, augmentez PROXY_TIMEOUT_MS dans app/api/backend/[...path]/route.ts ou dans .env.local.`
          : err?.message || `Le serveur backend ne répond pas. Vérifiez qu'il est lancé sur ${BACKEND_URL}`,
      },
      { status: 502 },
    );
  }

  if (backendRes.status === 401 && refreshToken) {
    const newToken = await tryRefresh(refreshToken);
    if (newToken) {
      await setAccessTokenCookie(newToken);
      try {
        backendRes = await doRequest(request, targetUrl, newToken, bodyBuffer);
      } catch (err: any) {
        const isTimeout = err instanceof ProxyTimeoutError;
        return NextResponse.json(
          { message: isTimeout ? err.message : (err?.message || 'Le serveur backend ne répond pas.') },
          { status: 502 },
        );
      }
    }

    if (backendRes.status === 401) {
      await clearSessionCookies();
    }
  } else if (backendRes.status === 401) {
    await clearSessionCookies();
  }

  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(backendRes.headers)) {
    if (value === undefined || STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
    responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : String(value));
  }

  // La spec Web Response interdit un body non-vide pour certains status
  // (101, 103, 204, 205, 304 — "null body status"). NestJS peut renvoyer
  // un 304 Not Modified (cache conditionnel via ETag/If-None-Match) avec
  // un body vide ; si on essaie quand même de passer un Uint8Array (même
  // vide) à `new NextResponse(...)` pour ces status, ça lève
  // "Invalid response status code". On force donc le body à null ici.
  const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
  const responseBody = NULL_BODY_STATUSES.has(backendRes.status)
    ? null
    : new Uint8Array(backendRes.body);

  return new NextResponse(responseBody, {
    status: backendRes.status,
    headers: responseHeaders,
  });
}

// Next.js 15 : `params` est une Promise dans les route handlers.
type RouteParams = Promise<{ path: string[] }>;

async function resolveParams(params: RouteParams): Promise<{ path: string[] }> {
  return await params;
}

export async function GET(request: NextRequest, ctx: { params: RouteParams }) {
  return handler(request, await resolveParams(ctx.params));
}
export async function POST(request: NextRequest, ctx: { params: RouteParams }) {
  return handler(request, await resolveParams(ctx.params));
}
export async function PATCH(request: NextRequest, ctx: { params: RouteParams }) {
  return handler(request, await resolveParams(ctx.params));
}
export async function PUT(request: NextRequest, ctx: { params: RouteParams }) {
  return handler(request, await resolveParams(ctx.params));
}
export async function DELETE(request: NextRequest, ctx: { params: RouteParams }) {
  return handler(request, await resolveParams(ctx.params));
}