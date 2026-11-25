import { button, fallbackLink, paragraph, raiImage, renderLayout, renderText } from './layout';

export interface RenderedMail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface TemplateContext {
  readonly logoUrl: string;
  readonly appUrl: string;
}

/** « 24 heures », « 30 minutes », « 1 heure ». */
export function formatTtl(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? '24 heures' : `${days} jours`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? '1 heure' : `${hours} heures`;
  }
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

function linkMail(
  ctx: TemplateContext,
  input: {
    subject: string;
    title: string;
    preheader: string;
    intro: string;
    cta: string;
    link: string;
    validity: string;
    outro: string;
  },
): RenderedMail {
  const body = [
    paragraph(input.intro),
    button(input.cta, input.link),
    paragraph(input.validity, true),
    fallbackLink(input.link),
    paragraph(input.outro, true),
  ].join('\n');
  return {
    subject: input.subject,
    html: renderLayout({ title: input.title, preheader: input.preheader, body, ...ctx }),
    text: renderText([input.title, input.intro, `${input.cta} : ${input.link}`, input.validity, input.outro]),
  };
}

export function verifyEmailTemplate(ctx: TemplateContext, link: string, ttlMs: number): RenderedMail {
  return linkMail(ctx, {
    subject: 'Confirme ton adresse e-mail',
    title: 'Confirme ton adresse e-mail',
    preheader: 'Un clic pour activer ton compte Raijin.',
    intro: 'Bienvenue sur Raijin. Confirme ton adresse pour activer ton compte.',
    cta: 'Confirmer mon adresse',
    link,
    validity: `Ce lien est valable ${formatTtl(ttlMs)} et ne sert qu’une fois.`,
    outro: 'Tu n’as pas créé de compte ? Ignore cet e-mail, rien ne se passera.',
  });
}

export function passwordResetTemplate(ctx: TemplateContext, link: string, ttlMs: number): RenderedMail {
  return linkMail(ctx, {
    subject: 'Réinitialise ton mot de passe',
    title: 'Réinitialise ton mot de passe',
    preheader: 'Choisis un nouveau mot de passe pour ton compte Raijin.',
    intro: 'Tu as demandé à changer ton mot de passe. Choisis-en un nouveau avec le bouton ci-dessous.',
    cta: 'Choisir un nouveau mot de passe',
    link,
    validity: `Ce lien est valable ${formatTtl(ttlMs)} et ne sert qu’une fois. Toutes tes sessions seront déconnectées.`,
    outro: 'Ce n’est pas toi ? Ignore cet e-mail : ton mot de passe actuel reste valable.',
  });
}

export function magicLinkTemplate(ctx: TemplateContext, link: string, ttlMs: number): RenderedMail {
  return linkMail(ctx, {
    subject: 'Ton lien de connexion Raijin',
    title: 'Connecte-toi à Raijin',
    preheader: 'Ton lien de connexion, sans mot de passe.',
    intro: 'Voici ton lien de connexion. Il t’ouvre ta session sans mot de passe.',
    cta: 'Me connecter',
    link,
    validity: `Ce lien est valable ${formatTtl(ttlMs)} et ne sert qu’une fois.`,
    outro: 'Tu n’as rien demandé ? Ignore cet e-mail, personne ne pourra se connecter sans ce lien.',
  });
}

/** Essai Pro annoncé dans l'e-mail de bienvenue (`null` : compte Gratuit, message neutre). */
export interface WelcomeTrial {
  readonly endsAt: Date;
  readonly days: number;
}

/** Bienvenue (Rai, accueil) : annonce l'essai Pro s'il a démarré, sinon un message neutre (jamais le motif d'un refus). */
export function welcomeTemplate(ctx: TemplateContext & { readonly assetsBaseUrl?: string }, trial: WelcomeTrial | null): RenderedMail {
  const title = 'Bienvenue sur Raijin';
  const lines = [
    'Ton adresse est confirmée. Colle l’adresse d’un token Solana et Raijin vérifie pour toi les points qui comptent : mint et freeze authority, liquidité verrouillée, concentration des holders, possibilité de revente.',
    trial
      ? `Ton essai Pro de ${trial.days} jour${trial.days > 1 ? 's' : ''} est actif jusqu’au ${trial.endsAt.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', timeZone: 'Europe/Paris' })}, sans carte bancaire : analyses étendues, suivis de tokens, alertes push et scan de wallet. À la fin, ton compte repasse en Gratuit tout seul, sans rien payer.`
      : 'Ton compte Gratuit est prêt : analyses quotidiennes et suivi de tes premiers tokens.',
    'Le risque zéro n’existe pas : Raijin te donne des faits, à toi de décider.',
  ];
  const cta = 'Analyser un token';
  const link = `${ctx.appUrl}/analyse`;
  const rai = ctx.assetsBaseUrl ? raiImage(ctx.assetsBaseUrl, RAI_WELCOME_FILE, RAI_WELCOME_ALT) : '';
  const body = [rai, ...lines.map((line) => paragraph(line)), button(cta, link)].filter(Boolean).join('\n');
  return {
    subject: 'Bienvenue sur Raijin',
    html: renderLayout({ title, preheader: trial ? 'Ton compte est prêt, ton essai Pro aussi.' : 'Ton compte est prêt.', body, logoUrl: ctx.logoUrl, appUrl: ctx.appUrl }),
    text: renderText([title, ...lines, `${cta} : ${link}`]),
  };
}

export const RAI_WELCOME_FILE = 'rai-bravo@2x.png';
export const RAI_WELCOME_ALT = 'Rai, la mascotte de Raijin, te souhaite la bienvenue';

/** Inscription tentée avec une adresse déjà utilisée : on prévient le titulaire, sans rien révéler au demandeur. */
export function accountExistsTemplate(ctx: TemplateContext, loginLink: string, resetLink: string): RenderedMail {
  const title = 'Tu as déjà un compte Raijin';
  const intro =
    'Quelqu’un (sans doute toi) a essayé de créer un compte avec cette adresse, qui en a déjà un. Connecte-toi simplement :';
  const reset = 'Mot de passe oublié ? Tu peux en choisir un nouveau ici :';
  const outro = 'Ce n’est pas toi ? Ignore cet e-mail : ton compte n’a pas changé.';
  const body = [paragraph(intro), button('Me connecter', loginLink), paragraph(reset), fallbackLink(resetLink), paragraph(outro, true)].join('\n');
  return {
    subject: 'Tu as déjà un compte Raijin',
    html: renderLayout({ title, preheader: 'Connecte-toi avec ton compte existant.', body, ...ctx }),
    text: renderText([title, intro, `Me connecter : ${loginLink}`, `${reset} ${resetLink}`, outro]),
  };
}

/** Avis de sécurité après un changement ou une réinitialisation du mot de passe. */
export function passwordChangedTemplate(ctx: TemplateContext, resetLink: string): RenderedMail {
  const title = 'Ton mot de passe a changé';
  const intro = 'Le mot de passe de ton compte Raijin vient d’être modifié. Tes autres sessions ont été déconnectées.';
  const outro = 'Ce n’est pas toi ? Réinitialise ton mot de passe tout de suite :';
  const body = [paragraph(intro), paragraph(outro), button('Réinitialiser mon mot de passe', resetLink)].join('\n');
  return {
    subject: 'Ton mot de passe a changé',
    html: renderLayout({ title, preheader: 'Avis de sécurité de ton compte Raijin.', body, ...ctx }),
    text: renderText([title, intro, `${outro} ${resetLink}`]),
  };
}
