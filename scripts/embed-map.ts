// Embute a página do mapa (map-runtime/dist/index.html, gerada pelo Vite) numa string TypeScript que o
// MapView entrega à WebView. Roda em `npm run build:map` (e no postinstall, para o EAS Build).
import { readFileSync, writeFileSync } from 'node:fs';

const src = new URL('../map-runtime/dist/index.html', import.meta.url);
const out = new URL('../src/map/mapHtml.generated.ts', import.meta.url);

const html = readFileSync(src, 'utf8');
if (!html.includes('<div id="map">')) throw new Error(`[embed-map] HTML inesperado em ${src.pathname}`);

// o Hermes guarda em UTF-16 (o dobro) strings com algum caractere fora do ASCII: o build já escapa tudo
const nonAscii = [...html].filter((c) => c.charCodeAt(0) > 127).length;
if (nonAscii) console.warn(`[embed-map] aviso: ${nonAscii} caracteres fora do ASCII no HTML do mapa`);

// JSON é literal de string JS válido; os separadores de linha/parágrafo Unicode vão escapados por garantia
const literal = JSON.stringify(html)
  .split(String.fromCharCode(0x2028))
  .join('\\u2028')
  .split(String.fromCharCode(0x2029))
  .join('\\u2029');
const ts =
  '// GERADO por scripts/embed-map.ts a partir de map-runtime/ (npm run build:map). Não edite.\n' +
  `export const MAP_HTML: string = ${literal};\n`;
writeFileSync(out, ts);
console.log(`[embed-map] ${out.pathname} (${(Buffer.byteLength(ts) / 1024).toFixed(0)} KiB)`);
