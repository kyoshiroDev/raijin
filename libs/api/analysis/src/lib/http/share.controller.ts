import { Controller, Get, Inject, Param, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { APP_CONFIG, type AppConfig } from '@raijin/api-core';
import type { Request, Response } from 'express';
import { OgImageService } from '../og/og-image.service';
import { SharePageService } from '../share/share-page.service';
import { parseMint } from './mint-param.pipe';

/**
 * Politique de contenu du document de l'app servi pour `/t/<mint>` (l'API impose `default-src
 * 'none'` à ses réponses JSON, ce qui bloquerait le démarrage d'Angular).
 */
export function sharePageCsp(apiUrl: string): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: ${apiUrl}`,
    "font-src 'self'",
    `connect-src 'self' ${apiUrl}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Page publique et image Open Graph (robots des réseaux sociaux), docs/ARCHITECTURE.md §9.7. */
@ApiExcludeController()
@Controller()
export class ShareController {
  constructor(
    private readonly pages: SharePageService,
    private readonly images: OgImageService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('share/t/:mint')
  async page(@Param('mint') raw: string, @Res() res: Response): Promise<void> {
    const html = await this.pages.render(parseMint(raw));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', sharePageCsp(this.config.apiUrl));
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.status(200).send(html);
  }

  @Get('og/:mint.png')
  async image(@Param('mint') raw: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const mint = parseMint(raw);
    const image = mint ? await this.images.imageFor(mint) : await this.images.generic();
    res.setHeader('ETag', image.etag);
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (req.headers['if-none-match'] === image.etag) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Type', 'image/png');
    res.status(200).send(image.png);
  }
}
