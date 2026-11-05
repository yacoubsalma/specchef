import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthenticatedUser {
  sub: string; // userId
  email: string;
  name: string;
  role: 'ADMIN' | 'QA' | 'BA' | 'PO';
}

/**
 * Injecte l'utilisateur authentifié (payload du JWT) dans un handler.
 *
 * @example
 * getMe(@CurrentUser() user: AuthenticatedUser) { return user; }
 * getMyId(@CurrentUser('sub') userId: string) { return userId; }
 */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user: AuthenticatedUser = request.user;
    return data ? user?.[data] : user;
  },
);
