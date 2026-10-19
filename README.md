# Desbrava

**Pedale. Corra. Revele sua cidade.**

Jogo de exploração para ciclistas e corredores que mistura Pokémon GO com *fog of war*. O mapa da sua cidade começa coberto por uma névoa; cada pedalada ou corrida abre uma clareira por onde você passou. Pontos turísticos viram locais "capturáveis" e moedas aparecem pelas ruas a cada nova atividade.

Protótipo 100% front-end: roda no navegador, salva tudo no aparelho e pode ser publicado em qualquer hospedagem estática.

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
| **Segurança** | Durante a gravação, capturas e subidas de nível aparecem num cartão compacto que some sozinho. Ninguém precisa tocar na tela pedalando. A tela fica ligada (Wake Lock). |

## 3. Telas

1. **Título**: logo, heróis animados e "Começar/Continuar". Esse toque também libera o áudio do navegador.
2. **Criação**: escolha do herói (carrossel), modalidade (ciclismo/corrida) e apelido.
3. **Gravar** (tela principal): câmera em 3D atrás do personagem, que vira junto com o seu rumo. Mostra tempo, distância, velocidade ou pace, moedas, capturas e área nova. Iniciar → Pausar → Retomar/Finalizar, como no Strava. No fim aparece um resumo.
4. **Mapa**: visão geral em 2.5D com névoa, POIs, moedas e a lista "Por perto". Tocar num ponto abre um cartão.
5. **Stats**: perfil e nível, totais, cidades com %, coleção por categoria (estilo pokédex), histórico com **exportação GPX** e ajustes (som, vibração, simulador, apagar progresso).

## 4. Rodando

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # gera dist/ (estático)
npm run preview      # serve o build
npm run sprites      # valida as artes e regenera os ícones do app em public/icons
```

**Simulador (para jogar no computador).** Ligue em *Stats → Ajustes → Modo simulador* ou abra com `?sim=1`. Controles: joystick na tela ou WASD/setas, Shift para turbo e botão direito (ou toque longo) no mapa para teletransportar. Na tela de gravar a direção é de "tanque": frente acelera e os lados viram.

Parâmetros de URL úteis: `?sim=1&lat=-22.9519&lng=-43.2105` (começa no lugar que você quiser), `?skip` (pula a tela de título), `?debug` (expõe `window.__desbrava` no console).

## 5. Deploy

O build é um site estático com caminhos relativos (`base: './'`), então funciona na raiz ou numa subpasta.

- **Vercel / Netlify / Cloudflare Pages:** importe o repositório. Comando de build `npm run build`, pasta de saída `dist`.
- **GitHub Pages:** já existe um workflow em `.github/workflows/deploy.yml`. Ative *Settings → Pages → Source: GitHub Actions* e faça push na `main`.

> O GPS do navegador só funciona em **HTTPS** (ou `localhost`). Todas as opções acima já servem HTTPS.

## 6. Arquitetura

```
src/
  sprites/      pixel art como texto + paletas (puro, roda no navegador e no Node)
    pixel.ts        rasterizador: camadas, espelhamento, escala nearest-neighbor
    characters.ts   6 heróis × 3 direções × corrida/bike, com animação
    items.ts        moedas animadas, emblemas de POI, raridades e categorias
    icons.ts        ícones de UI 12×12
    tiles.ts        texturas do mapa (grama, parque, floresta, água, areia) e árvores
  game/         regras, sem dependência de UI
    store.ts        estado global (zustand): perfil, carteira, XP, capturas, atividade
    tracker.ts      recebe cada posição: distância, névoa, moedas, capturas, anti-trapaça
    location.ts     GPS real (watchPosition) + simulador + posição suavizada
    fog.ts          registro de células exploradas (Map de dezenas de milhares de itens)
    pois.ts         classificação dos POIs do OpenMapTiles em categorias do jogo
    coins.ts        geração de moedas sobre ruas
    cities.ts       Nominatim + polígono do município + % explorado
    persist.ts      IndexedDB (save, células, polígonos, trilhas)
  map/
    style.ts        tema do mapa (estilo MapLibre próprio)
    fogLayer.ts     névoa em WebGL2 (camada custom do MapLibre)
    images.ts       sprites → imagens do mapa (inclui moedas animadas)
    engine.ts       instância do mapa, câmera, loop por quadro, fontes GeoJSON do jogo
  ui/           React: telas, HUD e modais
```

**Dados, sem chave de API:**
- Mapa: vector tiles do [OpenFreeMap](https://openfreemap.org), no schema OpenMapTiles.
- POIs: camada `poi` desses mesmos tiles, lida com `querySourceFeatures`. Não há outra requisição nem limite de uso. (A API Overpass foi descartada por ser instável.)
- Cidades: [Nominatim](https://nominatim.org) reverse geocoding com `polygon_geojson`. Há no máximo uma consulta a cada 20 s e o resultado fica em cache no aparelho.

**Como a névoa é desenhada** (`src/map/fogLayer.ts`):
1. Num `prerender`, cada célula explorada vira uma "bolha" suave projetada no chão e desenhada numa textura de meia resolução com blending `MAX`. Células novas crescem com uma animação de abertura.
2. No `render`, um quadrilátero no plano do chão desenha nuvens procedurais (fbm) com tons em degraus pontilhados, faíscas e brilho dourado. A máscara da etapa 1 define a opacidade.
3. A matriz de projeção é recalculada em float64 relativa a uma origem local, para não tremer no zoom de rua.

**Detalhe importante do MapLibre v6:** acima do zoom máximo do tile (z14), o v6 "fatia" os tiles e descarta as camadas que o estilo não usa, como a `poi`. O motor usa `zoomLevelsToOverscale: 99` para manter os POIs e as ruas disponíveis para o jogo.

**Sprites como código.** Cada sprite é uma grade de caracteres (`'o'` contorno, `'s'` pele, `'h'` cabelo…) mais uma paleta. Trocar a paleta muda o personagem inteiro. `npm run sprites` valida as larguras das linhas e exporta PNGs.

## 7. Limitações conhecidas (do navegador)

- **GPS em segundo plano:** navegadores param de entregar posição com a tela apagada. Por isso a tela fica ligada durante a gravação. Um app nativo (por exemplo com Capacitor) resolve isso.
- **Nominatim** é um serviço comunitário com política de uso justo. Em produção, use um geocodificador próprio ou pago, ou pré-calcule os polígonos no backend.
- O progresso vive só no aparelho (IndexedDB). Limpar os dados do site apaga tudo.

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
- PWA offline (service worker com cache dos tiles visitados).
- App nativo com GPS em segundo plano e notificações ("moeda de ouro a 200 m!").
