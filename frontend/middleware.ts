import { NextRequest, NextResponse } from 'next/server';
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from './lib/session';

/**
 * Routes protégées par l'authentification.
 *
 * Contrairement à l'outil llm-viewer original (où presque tout était protégé,
 * le site n'étant qu'un outil), integrated-project est aussi un site marketing
 * (accueil, blog, docs, support...) qui doit rester public. Seul l'outil
 * d'analyse (cahier de recettes) et la liste des projets nécessitent une
 * session valide.
 */
const PROTECTED_PATHS = ['/analyzer', '/projects', '/admin', '/account'];

function isProtected(pathname: string): boolean {
  return PROTECTED_PATHS.some(p => pathname === p || pathname.startsWith(`${p}/`));
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!isProtected(pathname)) {
    return NextResponse.next();
  }

  const hasSession =
    request.cookies.has(ACCESS_TOKEN_COOKIE) || request.cookies.has(REFRESH_TOKEN_COOKIE);

  if (!hasSession) {
    const loginUrl = new URL('/auth/signin', request.url);
    loginUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Le matcher reste large (tout sauf assets statiques / routes API) ;
  // c'est isProtected() ci-dessus qui décide vraiment quelles pages exigent
  // une session, ce qui laisse le site marketing public.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
