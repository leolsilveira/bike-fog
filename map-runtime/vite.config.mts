// Build da página do mapa: um único HTML com JS, CSS e o worker do MapLibre embutidos (vite-plugin-singlefile).
// `npm run build:map` gera map-runtime/dist/index.html e scripts/embed-map.ts o vira string em src/map/.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig, minify, transformWithOxc, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const root = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);

/**
 * Alvo de sintaxe. O app exige iOS 16.4 (Expo SDK 58), mas a página também roda no WKWebView do iOS 15 e em
 * Android WebView mais antigo: blocos `static {}` do MapLibre v6 são reescritos e `.at`/`Object.hasOwn`
 * ganham polyfill (no documento e no worker).
 */
const TARGET = ['es2020', 'safari15', 'chrome90'];

const POLYFILLS = `(function(){
function at(n){n=Math.trunc(n)||0;if(n<0)n+=this.length;return n<0||n>=this.length?undefined:this[n];}
var p=[Array.prototype,String.prototype,Object.getPrototypeOf(Int8Array.prototype)];
for(var i=0;i<p.length;i++)if(!p[i].at)Object.defineProperty(p[i],'at',{value:at,writable:true,configurable:true});
if(!Object.hasOwn)Object.defineProperty(Object,'hasOwn',{value:function(o,k){return Object.prototype.hasOwnProperty.call(o,k);},writable:true,configurable:true});
})();`;

/** Polyfills como <script> clássico no <head>: roda antes do módulo da página, que é adiado. */
function polyfills(): Plugin {
  return {
    name: 'desbrava-polyfills',
    transformIndexHtml() {
      return [{ tag: 'script', children: POLYFILLS, injectTo: 'head' }];
    },
  };
}

/**
 * `virtual:maplibre-worker`: o código do worker do MapLibre como string, pronto para um Blob URL.
 * O arquivo publicado é um módulo ES só por causa do `export` final; sem ele, vira script clássico.
 * As verificações abaixo quebram o build se uma versão nova do MapLibre mudar isso.
 */
function maplibreWorker(): Plugin {
  const id = 'virtual:maplibre-worker';
  const resolved = `\0${id}`;
  return {
    name: 'desbrava-maplibre-worker',
    resolveId(source) {
      return source === id ? resolved : null;
    },
    async load(source) {
      if (source !== resolved) return null;
      const file = require.resolve('maplibre-gl/dist/maplibre-gl-worker.mjs');
      const original = readFileSync(file, 'utf8');
      const tail = /export\s*\{\s*[\w$]+\s+as\s+default\s*\}\s*;?\s*(\/\/# sourceMappingURL=\S*\s*)?$/;
      if (!tail.test(original)) throw new Error('[map] worker do MapLibre mudou de formato: export final não encontrado');
      const body = original.replace(tail, '');
      if (body.includes('import.meta')) throw new Error('[map] worker do MapLibre usa import.meta: não roda como clássico');
      // função estrita em volta: mantém o escopo e o modo estrito que o código tinha como módulo
      const code = `${POLYFILLS}\n(function(){'use strict';\n${body}\n})();`;
      const lowered = await transformWithOxc(code, 'maplibre-gl-worker.js', {
        lang: 'js',
        sourceType: 'script',
        target: TARGET,
      });
      const min = await minify('maplibre-gl-worker.js', lowered.code, { compress: true, mangle: true });
      return `export default ${JSON.stringify(min.code)};`;
    },
  };
}

export default defineConfig({
  root,
  base: './',
  // os arquivos de ../src seriam transformados com o tsconfig do Expo (extends que o oxc não resolve)
  tsconfig: 'tsconfig.json',
  logLevel: 'warn',
  plugins: [polyfills(), maplibreWorker(), viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    target: TARGET,
    outDir: 'dist',
    emptyOutDir: true,
    modulePreload: false,
    reportCompressedSize: false,
    // HTML só com ASCII: o Hermes guarda strings com qualquer caractere fora do ASCII em UTF-16 (o dobro do
    // tamanho no bundle do app)
    rolldownOptions: { output: { charset: 'ascii' } },
  },
  server: { host: '127.0.0.1', port: 8091, strictPort: true },
});
