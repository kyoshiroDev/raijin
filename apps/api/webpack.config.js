const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { join } = require('path');

module.exports = {
  output: {
    path: join(__dirname, '../../dist/apps/api'),
    clean: true,
    ...(process.env.NODE_ENV !== 'production' && {
      devtoolModuleFilenameTemplate: '[absolute-resource-path]',
    }),
  },
  plugins: [
    new NxAppWebpackPlugin({
      target: 'node',
      compiler: 'tsc',
      main: './src/main.ts',
      tsConfig: './tsconfig.app.json',
      assets: [
        './src/assets',
        // Polices WOFF de l'image Open Graph (satori ne lit pas le WOFF2), voir libs/api/analysis/src/lib/og/og-fonts.ts.
        { input: 'node_modules/@fontsource/space-grotesk/files', glob: 'space-grotesk-latin-700-normal.woff', output: 'assets/fonts' },
        { input: 'node_modules/@fontsource/inter/files', glob: 'inter-latin-400-normal.woff', output: 'assets/fonts' },
        { input: 'node_modules/@fontsource/jetbrains-mono/files', glob: 'jetbrains-mono-latin-500-normal.woff', output: 'assets/fonts' },
      ],
      optimization: false,
      outputHashing: 'none',
      generatePackageJson: true,
      sourceMap: true,
    }),
  ],
};
