# ADR 002 — Modelo de Customização de Avatar e Escopo Inicial

- **Status:** Aceito
- **Data:** 2026-11-20
- **Design Doc:** [002 — Customização de Avatar e Onboarding em Etapas](../design/002-avatar-customizer-onboarding.md)

## Contexto

Anteriormente, o jogador escolhia apenas entre 6 personagens fixos (`CHARACTERS`), sendo 3 gratuitos e 3 bloqueados por moedas. Queremos oferecer personalização real do avatar (cabelo + cor de cada parte: pele, cabelo, camisa, shorts, tênis, capacete e bike) já na experiência inicial de onboarding e também editável depois.

## Decisões

1. **Armazenar `AvatarConfig` compacto no `Profile` (7 cores primárias + `hair`):**
   - Sombras (`*Shade`) e brilhos (`hairLight`) são derivados a partir de paletas curadas em `src/sprites/avatar.ts` (com fallback algorítmico).
   - Mantém o JSON salvo pequeno, garante harmonia visual 16-bit e preserva compatibilidade retroativa com `save:v1` (`profile.avatar` é opcional e cai no preset de `profile.characterId`).

2. **Onboarding em 3 etapas (`CreateScreen`) e reuso do customizador em `StatsScreen`:**
   - Separar **Modalidade → Avatar → Apelido** reduz sobrecarga visual em telas móveis e dá espaço confortável para prévia animada + controles de cor.
   - O mesmo componente `AvatarCustomizer` é reutilizado no modal `Editar avatar` da aba de perfil.

3. **Presets gratuitos como ponto de partida; loja de itens adiada como próximo passo:**
   - Todas as cores básicas e os 3 estilos de cabelo começam liberados, com os 6 presets antigos servindo como templates rápidos (+ botão `Aleatório`).
   - Uma **loja de customizações** (chapéus, óculos, bicicletas, tênis e pets) fica explicitamente registrada como **não-objetivo / próximo passo**, para que a base de customização entre limpa e extensível para futuras camadas de equipamento e mascotes.

## Consequências

- **Positivas:** zero novos assets pesados, renderização idêntica no app e na WebView do mapa, compatibilidade com saves existentes e base pronta para adicionar camadas extras (chapéus, óculos, pets) no futuro.
- **Trade-offs:** o cache de rasters (`rasterImage.ts` e `map-runtime/sprite.ts`) precisa ser limitado em tamanho para evitar acúmulo de memória quando o jogador testa muitas combinações de cor.
