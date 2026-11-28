import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthGuard, Client, CurrentAuth, type AuthContext, type ClientInfo } from '@raijin/api-auth';
import { ApiZodBody, AuthCookies, AuthThrottle, ZodValidationPipe } from '@raijin/api-core';
import {
  deleteAccountRequestSchema,
  type DeleteAccountRequest,
  type PublicUser,
} from '@raijin/shared-contracts';
import type { Response } from 'express';
import { UsersService } from './users.service';

/** `/api/v1/users/me` : profil, export et suppression du compte connecté. */
@ApiTags('users')
@Controller('users')
@UseGuards(AuthGuard)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly cookies: AuthCookies,
  ) {}

  @Get('me')
  me(@CurrentAuth() auth: AuthContext): Promise<PublicUser> {
    return this.users.me(auth.userId);
  }

  @Get('me/export')
  @AuthThrottle()
  @Header('Content-Disposition', 'attachment; filename="raijin-export.json"')
  @Header('Cache-Control', 'no-store')
  export(@CurrentAuth() auth: AuthContext, @Client() client: ClientInfo): Promise<Record<string, unknown>> {
    return this.users.export(auth.userId, client);
  }

  @Delete('me')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AuthThrottle()
  @ApiZodBody(deleteAccountRequestSchema)
  async delete(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(deleteAccountRequestSchema)) body: DeleteAccountRequest,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.users.delete(auth.userId, body.password, client);
    this.cookies.clearSession(res);
  }
}
