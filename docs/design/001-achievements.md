# Design Doc 001: Sistema de Conquistas e Recompensas em Moedas

- **Status:** Implementado
- **Data:** 2026-11-20
- **Decision Log relacionado:** [ADR-001 — Decisões de design das conquistas](../decisions/001-achievements-design.md)

---

## 1. Objetivo

Introduzir um sistema de **Conquistas** no Desbrava, inspirado no **StatsHunters** e na progressão lúdica de RPG 16-bit (**MistRunner / Desbrava**). Cada conquista — ou nível (*tier*) dela — credita automaticamente **moedas** na carteira (`wallet`) do jogador, incentivando exploração contínua, conclusão de cidades e constância mensal.

---

## 2. Catálogo de Conquistas

### 2.1. Recorrentes por Cidade (`cities`)
Para **cada município** descoberto (`city_pct:<cityId>:<tier>`), novos patamares de conclusão concedem moedas novamente:

| Meta (% da cidade) | Marco | Moedas |
|---|---|---:|
| 0,1% | Primeiros Passos | +15 |
| 0,5% | Morador do Bairro | +25 |
| 1% | Conhecedor Local | +40 |
| 2,5% | Guia Urbano | +65 |
| 5% | Cartógrafo Municipal | +100 |
| 10% | Desbravador da Cidade | +150 |
| 25% | Guardião Urbano | +250 |
| 50% | Metade do Mapa | +400 |
| 100% | Mestre Absoluto | +750 |

### 2.2. Recorrentes Mensais (`consistency`)
Renovam todo mês calendário (`YYYY-MM`):
- **Meta Mensal de Distância** (`monthly_dist:<YYYY-MM>:<tier>`): `25 km` (+20), `50 km` (+35), `100 km` (+60), `250 km` (+120), `500 km` (+200).
- **Dias Ativos no Mês** (`monthly_days:<YYYY-MM>:<tier>`): `5 dias` (+20), `10 dias` (+40), `15 dias` (+70), `20 dias` (+120).

### 2.3. Marcos Progressivos Globais

| ID | Título | Categoria | Patamares (Meta → Moedas) |
|---|---|---|---|
| `total_distance` | Papa-Léguas | Distância | 5 km (20) · 25 km (40) · 100 km (75) · 250 km (120) · 500 km (180) · 1.000 km (300) · 2.500 km (500) |
| `total_activities` | Ritmo Constante | Constância | 1 (15) · 5 (30) · 15 (50) · 30 (80) · 50 (120) · 100 (200) · 250 (350) |
| `total_moving_time` | Horas na Estrada | Constância | 1 h (20) · 5 h (45) · 15 h (80) · 50 h (150) · 100 h (250) |
| `total_cells` | Caça-Névoa | Exploração | 500 (20) · 2.000 (40) · 10.000 (80) · 35.000 (150) · 100.000 (300) · 300.000 (500) |
| `cities_count` | Turista de Mapa | Cidades | 1 (20) · 2 (45) · 5 (90) · 10 (160) · 20 (300) |
| `total_captures` | Colecionador de Marcos | Coleção | 1 (20) · 5 (35) · 15 (60) · 30 (100) · 60 (160) · 100 (240) · 200 (400) |
| `poi_categories` | Enciclopédia Urbana | Coleção | 3 cat. (30) · 6 cat. (70) · 10 cat. (150) |
| `rare_captures` | Olho Clínico | Coleção | 1 (30) · 5 (70) · 15 (140) · 40 (280) |
| `street_coins` | Caçador de Tesouros | Exploração | 10 (15) · 50 (35) · 150 (70) · 500 (140) · 1.000 (250) |
| `max_streak` | Chama Acesa | Constância | 3 d (25) · 7 d (60) · 14 d (120) · 30 d (250) · 60 d (450) |
| `eddington_km` | Número de Eddington | Distância | E=5 (35) · E=10 (70) · E=20 (140) · E=35 (250) · E=50 (400) |

### 2.4. Atividade Única e Especiais

| ID | Título | Categoria | Patamares (Meta → Moedas) |
|---|---|---|---|
| `single_bike_dist` | Pedal Épico | Distância | 10 km (25) · 25 km (50) · 50 km (90) · 100 km (180) · 160 km (320) |
| `single_run_dist` | Corrida Épica | Distância | 5 km (25) · 10 km (50) · 21,1 km (120) · 42,2 km (300) |
| `early_bird` | Madrugador (antes das 6h) | Especiais | 1x (25) · 5x (60) · 15x (130) |
| `night_rider` | Coruja Urbana (21h–4h) | Especiais | 1x (25) · 5x (60) · 15x (130) |
| `multi_city_activity` | Sem Fronteiras (2+ cidades) | Cidades | 1x (40) · 5x (100) · 15x (220) |
| `dual_sport` | Híbrido (bike + corrida) | Especiais | Única (40) |

---

## 3. Arquitetura e Fluxo

1. **Modelo de dados (`src/game/types.ts` e `src/game/store.ts`)**
   - `PersistedState.achievements: Record<string, { at: number; coins: number }>`.
   - Compatível com `save:v1` existente (`saved.achievements ?? {}`).
   - `grantAchievements()` é **idempotente**: ignora chaves já presentes e nunca credita moedas em duplicidade.
   - Moedas de conquista entram em `wallet`, sem alterar `totals.coinsValue` (evitando ciclo com `street_coins`).
2. **Motor puro (`src/game/achievements.ts`)**
   - `evaluateAchievements(state)`: avalia totais, cidades, capturas, atividades (incluindo GPX importadas) e atividade em andamento (`live`).
   - `buildAchievementOverview(state)`: produz o modelo pronto para exibição na UI.
3. **Pontos de gatilho**
   - Em tempo real (com throttle de ~1,5 s durante movimento, imediato em captura/moeda/cidade).
   - Ao finalizar uma atividade (`finishActivity`).
   - Após importar GPX/Strava (`importActivitiesFromFile`, usando toast agregado).
   - Na inicialização (`initGame`, após `hydrate` + `loadCityPolygons`, creditando retroativamente saves antigos com toast agregado).
4. **Interface**
   - `StatsScreen`: nova seção **CONQUISTAS** com resumo, até 3 metas "quase lá" e botão **Ver todas as conquistas**.
   - `Modals`: `AchievementUnlockModal` (cartão passivo que some sozinho durante gravação) e `AchievementsModal` (vitrine completa com filtros por categoria, cidades e metas do mês atual).
   - `Hud`: suporte a toast `kind: 'achievement'` para desbloqueios em lote.
