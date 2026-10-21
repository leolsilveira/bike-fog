# Desbrava

**Pedale. Corra. Revele sua cidade.**

Jogo de exploração para ciclistas e corredores que mistura Pokémon GO com *fog of war*. O mapa da sua cidade começa coberto por uma névoa; cada pedalada ou corrida abre uma clareira por onde você passou. Pontos turísticos viram locais "capturáveis" e moedas aparecem pelas ruas a cada nova atividade.

App para **iOS e Android** feito com Expo/React Native. Por enquanto é 100% front-end: salva tudo no aparelho. A mesma base gera uma versão web estática, usada para testes e publicada no GitHub Pages.

---

## 1. Público-alvo e direção de arte

**Para quem é.** Adultos de 22 a 40 anos que já pedalam ou correm por lazer (o público do Strava) e cresceram com Pokémon de Game Boy/DS, Zelda, Stardew Valley e Animal Crossing. Gostam de colecionar, de ver progresso e de descobrir a própria cidade, e acham as metas frias de km/pace pouco motivadoras. Um público secundário são iniciantes que precisam de um empurrão lúdico para sair de casa.

**Estética: "cidade de brinquedo HD-2D".** É a linguagem de Octopath Traveler e do remake de Dragon Quest III: personagens em pixel art 16-bit dentro de um mundo 3D com perspectiva, desfoque *tilt-shift* e luz quente. Ela conversa com a nostalgia desse público, mas parece atual, não infantil.

- **Personagens e ícones:** pixel art chibi, contorno escuro (`#2a1f3d`) e paletas saturadas. Na tela de gravar, o herói aparece de costas, igual ao avatar de um RPG.
- **Mapa:** terreno creme, gramados e parques com textura de pixel e flores, água azul com ondinhas, ruas cor de papel com borda marrom (como as rotas de Pokémon), ciclovias em verde-menta, prédios extrudados em tons pastel (cidade de brinquedo) e árvores *billboard* que ficam em pé na visão 3D.
- **Névoa:** nuvens índigo/lavanda animadas, com borda pontilhada (dithering Bayer, típico do 16-bit), faíscas e um brilho dourado na fronteira do que já foi explorado. Ela é um pouco translúcida, para dar para enxergar as ruas e planejar a rota.
- **Interface:** painéis escuros com cantos "pixelados", botões com borda inferior que afunda ao toque, fontes Pixelify Sans (texto) e Press Start 2P (números e títulos) e sons chiptune sintetizados.

## 2. Mecânicas

| Sistema | Como funciona |
|---|---|
| **Névoa (fog of war)** | O mundo é dividido em células Web Mercator z21 (cerca de 17 m em SP). Durante uma atividade, tudo num raio de 38 m da sua rota é revelado. Movimentos rápidos são interpolados, então nenhum trecho fica com buraco. |
| **Moedas** | Ao iniciar uma atividade, as moedas antigas somem e nascem 26 novas **sobre ruas reais** num raio de 1,1 km. Ao se afastar 1,2 km de todos os centros de spawn, nasce um novo lote (até 6 por atividade). Há bronze (1), prata (5), ouro (20) e gema (100), e as mais valiosas são mais frequentes longe do ponto de partida. |
| **Capturas** | Parques, arte urbana, templos, teatros/cinemas, bibliotecas, museus, monumentos, mirantes, estádios e atrações vêm do OpenStreetMap. A captura acontece quando você passa perto durante uma atividade. O raio depende da categoria: parque 70 m, estádio 120 m, arte 35 m. Na névoa, o ponto aparece como "?". |
| **Raridade** | Comum → Incomum → Raro → Épico → Lendário, com XP de 40 a 640. Zoológicos, aquários, parques temáticos e castelos são lendários. |
| **XP e níveis** | XP vem da distância (bike 12/km, corrida 30/km), de células novas (2 cada), de moedas e de capturas. Cada nível dá um título, de "Novato de bairro" a "Mestre da névoa". |
| **Cidades** | O município é identificado via Nominatim, que devolve o polígono oficial. O percentual desbloqueado é a área das células exploradas dentro do município dividida pela área dele. |
| **Personagens** | Seis heróis com penteados e paletas próprias. Três são grátis; Kenji (250), Maya (500) e Zeca (900) se desbloqueiam com moedas. |
| **Anti-trapaça** | Acima de 60 km/h (bike) ou 25 km/h (corrida) a exploração pausa e aparece um aviso. Leituras de GPS com precisão pior que 45 m são ignoradas. |
| **Segurança** | Durante a gravação, capturas e subidas de nível aparecem num cartão compacto que some sozinho. Ninguém precisa tocar na tela pedalando. A tela fica ligada durante a gravação e, no celular, o GPS continua em segundo plano se ela apagar. |

## 3. Telas

1. **Título**: logo, heróis animados e "Começar/Continuar". Na web, esse toque também libera o áudio do navegador.
2. **Criação**: escolha do herói (carrossel), modalidade (ciclismo/corrida) e apelido.
3. **Gravar** (tela principal): câmera em 3D atrás do personagem, que vira junto com o seu rumo. Mostra tempo, distância, velocidade ou pace, moedas, capturas e área nova. Iniciar → Pausar → Retomar/Finalizar, como no Strava. No fim aparece um resumo.
4. **Mapa**: visão geral em 2.5D com névoa, POIs, moedas e a lista "Por perto". Tocar num ponto abre um cartão.
5. **Stats**: perfil e nível, totais, cidades com %, coleção por categoria (estilo pokédex), histórico com **exportação GPX** e ajustes (som, vibração, simulador, apagar progresso).

## 4. Rodando

```bash
npm install          # o postinstall já gera o mapa embutido (npm run build:map)
npx expo start       # servidor de desenvolvimento (abre no development build)
npx expo start --go  # idem, abrindo no app Expo Go
npm run web          # versão web no navegador
npm run typecheck    # tsc do app, do map-runtime e dos scripts
npm run build:map    # recompila a página do mapa depois de mexer em map-runtime/
npm run sprites      # valida as artes e regenera ícones e splash do app em assets/
```

**No celular.** O jeito mais rápido é o **Expo Go** (`npx expo start --go` e ler o QR code). Ele roda o jogo inteiro, menos o GPS em segundo plano: no iOS o Expo Go não deixa gravar com a tela apagada. Para isso, gere um *development build* com o EAS (seção 5) ou, numa máquina com Xcode/Android Studio, `npx expo run:ios` / `npx expo run:android`. As pastas `ios/` e `android/` são geradas (Continuous Native Generation): não edite à mão. Permissões e plugins nativos ficam no `app.json`.

**Simulador (para jogar sem sair de casa).** Ligue em *Stats → Ajustes → Modo simulador* (na web, abra com `?sim=1`). Controles: joystick na tela (na web também WASD/setas, com Shift para turbo) e toque longo no mapa para teletransportar (na web também o botão direito). Na tela de gravar a direção é de "tanque": frente acelera e os lados viram.

Parâmetros de URL úteis na web: `?sim=1&lat=-22.9519&lng=-43.2105` (começa no lugar que você quiser), `?skip` (pula a tela de título), `?debug` (expõe `globalThis.__desbrava` no console).

## 5. Deploy

**Apps (EAS Build).** Os perfis estão em `eas.json`. Não é preciso ter Xcode nem Android Studio:

```bash
npx eas-cli@latest login
npx eas-cli@latest build --profile development --platform ios   # development build (com GPS em segundo plano)
npx eas-cli@latest build --profile preview --platform android   # APK para instalar direto
npx eas-cli@latest build --profile production --platform all    # lojas
npx eas-cli@latest submit --platform ios                        # envia para a App Store Connect
```

No primeiro build o EAS pergunta pelas contas da Apple/Google e cuida dos certificados. Os identificadores (`com.desbrava.app`) estão no `app.json`.

**Web.** `npx expo export --platform web` gera `dist/`. O workflow `.github/workflows/deploy.yml` publica essa pasta no GitHub Pages a cada push na `main`. Ative *Settings → Pages → Source: GitHub Actions*. Para publicar numa subpasta, defina `EXPO_BASE_URL` (o workflow já usa `/<repositório>`).

> O GPS do navegador só funciona em **HTTPS** (ou `localhost`).

## 6. Arquitetura

O app é React Native de verdade (telas, HUD, modais, GPS, saves e sons). A exceção é o mapa: ele roda em **MapLibre GL JS numa WebView** (num iframe, na web). A névoa é um shader WebGL2 próprio, uma camada custom que o MapLibre nativo não aceita, e é a assinatura visual do jogo. O mapa **só desenha**. Toda regra do jogo roda no app, então a névoa, as moedas e as capturas continuam funcionando com a tela apagada, quando a WebView fica suspensa.

```
App.tsx         casca: fontes, splash, Título → Criação → Jogo, mapa por trás e HUD por cima
index.ts        entrada; registra a task de GPS em segundo plano antes de tudo
src/
  sprites/      pixel art como texto + paletas (puro: roda no app, no mapa e no Node)
  game/         regras, sem dependência de UI
    store.ts        estado global (zustand): perfil, carteira, XP, capturas, atividade
    tracker.ts      recebe cada posição: distância, névoa, moedas, capturas, anti-trapaça
    location.ts     fonte de posição: GPS real ou simulador; objeto `player` que a UI lê
    gpsSource.ts    GPS do aparelho (expo-location); `.web.ts` usa a Geolocation API
    bgTask.ts       GPS em segundo plano durante a gravação (expo-task-manager)
    tiles.ts        baixa os vector tiles z14 e extrai POIs e ruas (tileDecode.ts)
    fog.ts          células exploradas (Map com dezenas de milhares de itens)
    pois.ts         classificação dos POIs do OpenMapTiles em categorias do jogo
    coins.ts        geração de moedas sobre ruas
    cities.ts       Nominatim + polígono do município + % explorado
    persist.ts      save local (névoa e trilhas em binário, ver binary.ts)
    audio.ts        sons e vibração (WAVs + expo-haptics no celular, WebAudio na web)
    gpx.ts          exportação GPX (folha de compartilhar no celular, download na web)
  services/     adaptadores de plataforma (`foo.ts` no celular, `foo.web.ts` na web):
                armazenamento (arquivos / IndexedDB), confirmação, cabeçalhos HTTP, parâmetros
  bridge/       protocol.ts (mensagens app ↔ mapa) + mapHost.ts (barramento do lado do app)
  map/          MapView (WebView / iframe), sync.ts (estado do jogo → mapa), controller.ts (câmera)
  ui/           telas, HUD e modais em componentes RN (theme.ts, Px.tsx = design system pixel)
map-runtime/    a página do mapa: MapLibre + estilo + névoa + herói + câmera + física do simulador
                (Vite + vite-plugin-singlefile → um HTML só → src/map/mapHtml.generated.ts)
scripts/        export-sprites.ts (ícones/splash), export-sfx.ts (WAVs), embed-map.ts
```

**Como o app e o mapa conversam** (`src/bridge/protocol.ts`): mensagens JSON por `postMessage`. O app manda o que o mapa desenha (modo, perfil, células, moedas, POIs, trilha, posição do GPS) e comandos de câmera. O mapa devolve toques (POI selecionado, teleporte), a posição suavizada do jogador e, no simulador, os fixes da física, que roda lá a 60 fps junto da câmera.

**Dados, sem chave de API:**
- Mapa: vector tiles do [OpenFreeMap](https://openfreemap.org), no schema OpenMapTiles.
- POIs e ruas: camada `poi` e de ruas desses mesmos tiles. O app baixa e decodifica os tiles z14 em volta do jogador (`src/game/tiles.ts`), sem depender do mapa. Não há outra requisição nem limite de uso. (A API Overpass foi descartada por ser instável.)
- Cidades: [Nominatim](https://nominatim.org) reverse geocoding com `polygon_geojson`. Há no máximo uma consulta a cada 20 s e o resultado fica em cache no aparelho.

**Como a névoa é desenhada** (`map-runtime/fogLayer.ts`):
1. Num `prerender`, cada célula explorada vira uma "bolha" suave projetada no chão e desenhada numa textura de meia resolução com blending `MAX`. Células novas crescem com uma animação de abertura.
2. No `render`, um quadrilátero no plano do chão desenha nuvens procedurais (fbm) com tons em degraus pontilhados, faíscas e brilho dourado. A máscara da etapa 1 define a opacidade.
3. A matriz de projeção é recalculada em float64 relativa a uma origem local, para não tremer no zoom de rua.

**Detalhe importante do MapLibre v6:** acima do zoom máximo do tile (z14), o v6 "fatia" os tiles e descarta as camadas que o estilo não usa, como a `poi`. O motor do mapa usa `zoomLevelsToOverscale: 99` para manter os POIs disponíveis para os emblemas.

**Sprites como código.** Cada sprite é uma grade de caracteres (`'o'` contorno, `'s'` pele, `'h'` cabelo…) mais uma paleta. Trocar a paleta muda o personagem inteiro. `npm run sprites` valida as larguras das linhas e exporta PNGs.

## 7. Limitações conhecidas

- **GPS em segundo plano no iOS** exige um development build ou o app das lojas: o Expo Go não suporta. No Android, a gravação usa um serviço em primeiro plano, com notificação, e não pede a permissão "o tempo todo".
- **Web:** o navegador para de entregar posição com a tela apagada, então a tela fica ligada durante a gravação.
- **Nominatim** é um serviço comunitário com política de uso justo. Em produção, use um geocodificador próprio ou pago, ou pré-calcule os polígonos no backend.
- O progresso vive só no aparelho (arquivos do app no celular, IndexedDB na web). Desinstalar o app ou limpar os dados do site apaga tudo.

## 8. Roadmap (próximos passos)

**Backend**
- Contas e sincronização do save. O ponto de integração é `src/game/persist.ts`.
- Validação de atividades no servidor (velocidade, saltos, assinatura da trilha) e moedas geradas pelo servidor para impedir trapaça.
- Rankings por cidade e por bairro, além de "territórios" (quem revelou mais um bairro).
- Curadoria de POIs: lendários reais (cartões-postais da cidade), fotos e descrições.

**Jogo**
- Percentual por **bairro**: mesma lógica das cidades, com Nominatim zoom 14.
- Missões semanais ("capture 3 mirantes", "revele 2 km² novos"), eventos sazonais e sequências de dias seguidos.
- Loja de cosméticos com as moedas: bikes, capacetes, rastros coloridos.
- Importar atividades do Strava/GPX para revelar a névoa retroativamente.
- Modo multijogador: ver amigos no mapa e fazer capturas em grupo.

**Plataforma**
- Mapa offline (cache dos tiles visitados).
- Notificações durante a gravação ("moeda de ouro a 200 m!") e Live Activity / widget com o tempo e a distância.
