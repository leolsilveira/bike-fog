// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    // saídas de build e o HTML do mapa embutido (gerado por `npm run build:map`)
    ignores: ['dist/*', 'map-runtime/dist/*', 'src/map/mapHtml.generated.ts'],
  },
  {
    // módulos virtuais do Vite (ex.: o worker do MapLibre) só existem durante o build do mapa
    files: ['map-runtime/**'],
    rules: { 'import/no-unresolved': ['error', { ignore: ['^virtual:'] }] },
  },
]);
