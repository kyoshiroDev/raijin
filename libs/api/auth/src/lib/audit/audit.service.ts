import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, errorCode, hmac, type AppConfig } from '@raijin/api-core';
import { Prisma, PrismaService } from '@raijin/api-prisma';
import type { ClientInfo } from './client-info';

/** Journal d'audit de sécurité (table AuditLog). Jamais d'e-mail, de mot de passe ni de jeton. */
@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** IP hachée (HMAC avec COOKIE_SECRET) : jamais stockée en clair. */
  hashIp(ip: string | null): string | null {
    return ip ? hmac(this.config.auth.cookieSecret, `ip:${ip}`) : null;
  }

  async record(
    action: string,
    userId: string | null,
    client: ClientInfo | null,
    metadata?: Prisma.InputJsonValue,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action,
          userId,
          ipHash: this.hashIp(client?.ip ?? null),
          userAgent: client?.userAgent ?? null,
          ...(metadata === undefined ? {} : { metadata }),
        },
      });
    } catch (error) {
      // L'audit ne doit jamais casser le parcours utilisateur.
      this.logger.error(`Audit « ${action} » non enregistré (${errorCode(error)})`);
    }
  }
}
