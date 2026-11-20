# Changelog

Todas as mudanças notáveis deste projeto serão documentadas neste arquivo.

## [Unreleased]

### Added
- **Customização de Avatar e Onboarding em 3 Etapas**
  - Modelo de avatar customizável (`src/sprites/avatar.ts`) com 3 estilos de cabelo (`Curto`, `Rabo`, `Black`) e paletas 16-bit curadas para 7 partes (`Cabelo`, `Pele`, `Camisa`, `Shorts`, `Tênis`, `Capacete`, `Bike`), mantendo compatibilidade retroativa com saves `save:v1`.
  - Componente reutilizável `AvatarCustomizer` (`src/ui/components/AvatarCustomizer.tsx`) com rotação em 4 direções, alternador de prévia `Bike`/`Corrida`, templates rápidos e botão `Aleatório`.
  - Novo fluxo de onboarding em 3 etapas em `CreateScreen` (`1 · Modalidade` → `2 · Avatar` → `3 · Apelido`).
  - Edição de avatar pós-onboarding em `StatsScreen` (`Editar avatar` → `AvatarEditorModal`).
  - Sincronização do avatar customizado entre app e mapa WebView (`protocol.ts`, `sync.ts`, `map-runtime/engine.ts`, `map-runtime/sprite.ts`) com caches limitados.
- **Sistema de Conquistas e Recompensas em Moedas**
  - Motor de conquistas (`src/game/achievements.ts`) com conquistas em níveis (multi-tier), recorrentes (mensais e por cidade) e especiais, concessão automática de moedas, visão geral em `StatsScreen`, modais/toasts de desbloqueio e testes unitários (`scripts/test-achievements.ts`).
- **Importação e Exportação de Atividades (Strava / GPX)**
  - Importação de arquivos GPX e ZIPs do Strava em `src/game/gpxImport.ts` e `src/game/activitiesTransfer.ts`, com leitura em chunks, barra de progresso e cancelamento, além de exportação em lote para ZIP.
- **Documentação (`docs/`)**
  - Estrutura de Design Docs e Decision Logs (ADRs) em `docs/README.md`:
    - `docs/design/001-achievements.md` e `docs/decisions/001-achievements-design.md`
    - `docs/design/002-avatar-customizer-onboarding.md` e `docs/decisions/002-avatar-customization-model.md` (incluindo futura loja de customizações — chapéus, óculos, bicicletas, tênis e pets — registrada como próximo passo / não-objetivo).

### Changed
- **HUD e Mapa**: Limpeza do HUD durante gravações e escala do avatar no mapa proporcional ao zoom (`Hud.tsx`, `MapTab.tsx`, `map-runtime/engine.ts`, `map-runtime/page.css`).

### Fixed
- **iOS**: Persistência de GPS em segundo plano endurecida e adoção do ciclo de vida `UIScene` (`app.config.ts`, `bgTask.ts`, `index.ts`, `location.ts`, `persist.ts`, `tracker.ts`).
