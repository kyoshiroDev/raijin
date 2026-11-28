/**
 * Plugin PostCSS : retire les `@import` de polices distantes (Google Fonts) restés dans le CSS
 * après l'inlining de Tailwind. Celui de libs/brand/tokens.css n'est de toute façon jamais
 * appliqué (un @import placé après d'autres règles est ignoré par le navigateur), mais il ne doit
 * pas apparaître dans le build : polices auto-hébergées (RGPD, CSP 'self'). Voir ARCHITECTURE.md §4.
 */
const REMOTE_FONTS = /fonts\.(googleapis|gstatic)\.com/;

/** @type {import('postcss').PluginCreator<void>} */
const plugin = () => ({
  postcssPlugin: 'raijin-strip-remote-font-imports',
  OnceExit(root) {
    root.walkAtRules('import', (rule) => {
      if (REMOTE_FONTS.test(rule.params)) rule.remove();
    });
  },
});
plugin.postcss = true;

module.exports = plugin;
