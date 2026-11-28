import { CanActivate, ExecutionContext, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiException } from '@raijin/api-core';
import { PrismaService } from '@raijin/api-prisma';
import type { Role } from '@raijin/shared-contracts';
import type { Request } from 'express';
import type { AuthContext } from './auth.guard';

export const ROLES_KEY = 'raijin:roles';

/** `@Roles('ADMIN')` : à combiner avec `@UseGuards(AuthGuard, RolesGuard)` (l'ordre compte). */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Exige l'un des rôles déclarés par `@Roles`. Le rôle est **relu en base** (un admin rétrogradé perd
 * l'accès tout de suite, sans attendre l'expiration de son access token). Sans session : 401 (posé par
 * `AuthGuard`) ; rôle insuffisant : 403 `FORBIDDEN`.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (!roles || roles.length === 0) return true;
    const auth = context.switchToHttp().getRequest<Request & { auth?: AuthContext }>().auth;
    if (!auth) throw ApiException.auth('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
    const user = await this.prisma.user.findUnique({ where: { id: auth.userId }, select: { role: true } });
    if (!user || !roles.includes(user.role)) throw new ApiException('FORBIDDEN', HttpStatus.FORBIDDEN);
    return true;
  }
}
