# ADR 003 — Backend no Supabase, Autenticação, Social, Loja e Sincronização Offline-First

- **Status:** Aceito
- **Data:** 2026-11-20
- **Projeto Supabase:** `lugwebngeyadfrqoapsg`

---

## Contexto

Hoje todo o estado do **Desbrava** vive apenas no aparelho (`save:v1` JSON + `fog:v2` binário + `track:<id>` em arquivos locais no mobile ou IndexedDB na web, gerenciados em `src/game/persist.ts` e `src/game/store.ts`). Isso impede:

- Fazer login em múltiplos aparelhos (iOS, Android e Web) sem perder progresso.
- Buscar outros jogadores, adicionar amigos, ver níveis e competir em rankings (primeiro entre amigos, depois global).
- Comprar itens cosméticos e consumíveis/boosters em uma loja usando moedas (`wallet`) com integridade de saldo.
- Guardar todo o histórico de atividades (hoje limitado a 200 itens em `save:v1`) e trilhas na nuvem com proteção contra trapaças.

Ao mesmo tempo, o app é usado na rua (bicicleta/corrida), muitas vezes sem sinal estável. Portanto, **toda a experiência precisa continuar funcionando offline** e sincronizar automaticamente quando houver conexão.

---

## Inventário do Estado Atual → O que vai para a Nuvem

| Dado atual (`PersistedState` / arquivos) | Destino na nuvem | Observação |
|---|---|---|
| `profile` (`name`, `characterId`, `avatar`, `modality`, `createdAt`) | Tabela `profiles` | Ganha `username` único (para busca de amigos) e `updated_at`. |
| `xp` (nível e título derivados) | `profiles.xp` + `profiles.level` | Escrita exclusiva via Edge Function / RPC após verificação. |
| `wallet` (saldo de moedas) | `profiles.wallet` + `wallet_ledger` | Saldo mantido por extrato append-only verificado no servidor. |
| `totals` (distância, tempo, atividades, moedas, capturas, células) | Colunas agregadas em `profiles` | Indexáveis para rankings por XP, distância ou células. |
| `activities` (hoje cap em 200) | Tabela `activities` (sem limite) | Inclui `source` (`live` vs `gpx_import`) e `verification_status`. |
| `track:<activityId>` (`Float64Array`) | Storage `activity-tracks` (gzip) | Enviado para verificação no servidor e mantido em cache local sob demanda. |
| `fog:v2` (`encodeFog` binário) | Storage `fog-snapshots` + `user_fog_state` | Blob compacto em vez de dezenas de milhares de linhas no Postgres. |
| `cities` (`Record<string, City>`) | Tabela `user_cities` | Progresso por cidade. |
| `captures` (`Record<string, Capture>`) | Tabela `user_captures` | POIs capturados. |
| `achievements` (`Record<string, AchievementRecord>`) | Tabela `user_achievements` | Conquistas desbloqueadas e moedas concedidas. |
| `unlocked` (personagens/itens) | `store_items`, `user_inventory`, `user_boost_usages` | Evolui para cosméticos permanentes e consumíveis/boosters. |
| `settings` (`sound`, `haptics`, `simulator`) | `profiles.settings` (parcial) | `sound`/`haptics` sincronizáveis; `simulator` fica apenas local. |
| `coins`, `live`, `route` | **Apenas local** | Estado efêmero da sessão ativa; só vai para a nuvem ao finalizar a atividade. |

---

## Decisões

### 1. Stack de Backend: Supabase (Postgres + Auth + Storage + Edge Functions + RPC)
- **Decisão:** Usar o projeto Supabase `lugwebngeyadfrqoapsg` como backend único: Postgres com Row Level Security (RLS), Supabase Auth, Supabase Storage para binários (`fog:v2` e trilhas GPS), **Edge Functions** para verificação estrita de atividades/trilhas e funções Postgres (RPC) para compras na loja, busca e rankings.
- **Motivo:** Elimina manutenção de servidor próprio, oferece Auth + DB + Storage + Edge Functions integrados e funciona de forma uniforme no Expo (iOS/Android) e Web via `@supabase/supabase-js`.

### 2. Autenticação, Modo Convidado, Migração e Logout
- **Provedores suportados:**
  1. **Email e senha** (cadastro, login e recuperação de senha).
  2. **Sign in with Apple** (`expo-apple-authentication` no iOS + OAuth na web) — obrigatório pela App Store sempre que houver login social de terceiros.
  3. **Google Sign-In** (nativo/PKCE via `signInWithIdToken` ou `expo-auth-session`).
- **Modo Convidado primeiro:** Novos usuários podem jogar localmente imediatamente sem criar conta, e fazer login / vincular conta quando quiserem (para backup na nuvem, adicionar amigos, entrar no ranking ou comprar na loja).
- **Migração ao entrar em conta existente:**
  - Se a conta na nuvem for **nova/vazia**, o app faz **merge automático** enviando o progresso local (`save:v1`, `fog:v2`, atividades e trilhas).
  - Se **tanto o aparelho quanto a nuvem já tiverem progresso**, o app exibe um diálogo perguntando ao usuário se deseja **Mesclar** (união de atividades, névoa, capturas e conquistas) ou **Manter apenas a nuvem**.
- **Sessão persistente:** Tokens armazenados em `expo-secure-store` (mobile) e `localStorage`/IndexedDB (web), permitindo abrir o app offline já autenticado.
- **Logout (Sair da conta):** Se houver eventos ou atividades pendentes na outbox sem sincronizar, o app alerta o usuário antes; após sincronizar (ou confirmação explícita), limpa os dados locais da conta e retorna ao estado limpo de convidado/login.

### 3. Modelagem de Banco de Dados (Postgres + Storage)

#### Tabelas principais (Postgres)
1. **`profiles`** (1:1 com `auth.users`)
   - `id uuid PK` (`references auth.users(id) on delete cascade`)
   - `username text UNIQUE` (handle normalizado em minúsculas, sugerido automaticamente a partir do apelido no cadastro e editável depois; índice `pg_trgm` para busca rápida)
   - `display_name text NOT NULL`
   - `modality text NOT NULL` (`'bike' | 'run'`)
   - `character_id text NOT NULL`
   - `avatar_config jsonb` (`AvatarConfig` + slots cosméticos equipados da loja)
   - `xp integer NOT NULL DEFAULT 0` *(server-managed)*
   - `level integer NOT NULL DEFAULT 1` *(server-managed)*
   - `wallet integer NOT NULL DEFAULT 0` *(server-managed)*
   - `total_distance_m double precision NOT NULL DEFAULT 0` *(server-managed)*
   - `total_moving_s double precision NOT NULL DEFAULT 0` *(server-managed)*
   - `total_activities integer NOT NULL DEFAULT 0` *(server-managed)*
   - `total_coins_value integer NOT NULL DEFAULT 0` *(server-managed)*
   - `total_coins_count integer NOT NULL DEFAULT 0` *(server-managed)*
   - `total_captures integer NOT NULL DEFAULT 0` *(server-managed)*
   - `total_cells integer NOT NULL DEFAULT 0` *(server-managed)*
   - `achievements_count integer NOT NULL DEFAULT 0` *(server-managed, usado no resumo de amigos)*
   - `settings jsonb NOT NULL DEFAULT '{}'`
   - `is_public boolean NOT NULL DEFAULT true` (controla visibilidade na busca e no futuro ranking global)
   - `created_at timestamptz`, `updated_at timestamptz`

2. **`activities`**
   - `id text` (ID gerado no cliente, ex. `act_...`, garantindo idempotência no sync)
   - `user_id uuid NOT NULL references profiles(id)` — **PK `(user_id, id)`**
   - `source text NOT NULL DEFAULT 'live'` (`'live' | 'gpx_import'`)
   - `verification_status text NOT NULL DEFAULT 'pending'` (`'pending' | 'verified' | 'flagged'`)
   - `verification_reason text` (motivo quando `flagged`, ex.: velocidade irreal / teleporte)
   - `modality text NOT NULL`
   - `started_at timestamptz NOT NULL`, `ended_at timestamptz NOT NULL`
   - `elapsed_s double precision`, `moving_s double precision`, `distance_m double precision`, `max_speed double precision`
   - `coins_value integer`, `coins_count integer`, `new_cells integer`, `xp integer`
   - `city_ids text[]`, `capture_ids text[]`
   - `track_path text` (caminho no bucket `activity-tracks`)
   - `created_at timestamptz`, `verified_at timestamptz`
   - Índice em `(user_id, started_at DESC)` e índice parcial `WHERE verification_status = 'verified'` para rankings mensais.

3. **`user_cities`**
   - **PK `(user_id, city_id)`**
   - `name`, `state`, `country`, `area_m2`, `bbox jsonb`, `cells integer`, `cell_area_m2`, `discovered_at timestamptz`, `updated_at timestamptz`

4. **`user_captures`**
   - **PK `(user_id, poi_id)`**
   - `name`, `category`, `rarity`, `lng double precision`, `lat double precision`, `city_id text`, `activity_id text`, `captured_at timestamptz`

5. **`user_achievements`**
   - **PK `(user_id, achievement_key)`**
   - `unlocked_at timestamptz NOT NULL`, `coins_awarded integer NOT NULL`

6. **`user_fog_state`** (metadados do snapshot binário da névoa)
   - `user_id uuid PK references profiles(id)`
   - `storage_path text NOT NULL` (`fog-snapshots/{user_id}/fog.bin`)
   - `cell_count integer NOT NULL DEFAULT 0`
   - `revision bigint NOT NULL DEFAULT 0` (controle otimista de concorrência)
   - `updated_at timestamptz`

7. **`friendships`** (Social)
   - `id uuid PK DEFAULT gen_random_uuid()`
   - `requester_id uuid NOT NULL references profiles(id)`
   - `addressee_id uuid NOT NULL references profiles(id)`
   - `status text NOT NULL` (`'pending' | 'accepted' | 'blocked'`)
   - `created_at timestamptz`, `updated_at timestamptz`
   - Índice único em `(LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id))` para impedir convites duplicados nos dois sentidos.

8. **`store_items`**, **`user_inventory`**, **`user_boost_usages`** e **`wallet_ledger`** (Loja & Economia)
   - `store_items`:
     - `id text PK`
     - `kind text NOT NULL` (`'cosmetic' | 'consumable'`)
     - `category text NOT NULL` (`'character' | 'hat' | 'glasses' | 'bike' | 'shoe' | 'pet' | 'color' | 'boost_xp' | 'boost_fog' | 'boost_coins'`)
     - `name text NOT NULL`, `description text`, `price_coins integer NOT NULL`, `rarity text`
     - `max_stack integer` (`1` para cosméticos permanentes; `>1` ou `null` para consumíveis)
     - `metadata jsonb` (referência de sprite/paleta ou `effect_config`, ex.: `{ multiplier: 2, duration_s: 1800 }`)
     - `is_active boolean NOT NULL DEFAULT true`, `sort_order integer NOT NULL DEFAULT 0`
   - `user_inventory`:
     - **PK `(user_id, item_id)`**
     - `quantity integer NOT NULL DEFAULT 1` (`CHECK (quantity >= 0)`)
     - `first_purchased_at timestamptz`, `updated_at timestamptz`
   - `user_boost_usages` (consumo de boosters em atividades):
     - `id text PK` (idempotente por cliente)
     - `user_id uuid NOT NULL`, `item_id text NOT NULL references store_items(id)`, `activity_id text`
     - `activated_at timestamptz NOT NULL`, `expires_at timestamptz`
   - `wallet_ledger` (extrato append-only):
     - `id uuid PK`, `user_id uuid NOT NULL`, `delta integer NOT NULL`
     - `reason text NOT NULL` (`'activity_coins' | 'achievement' | 'store_purchase' | 'migration' | 'adjustment'`)
     - `ref_id text NOT NULL`, `created_at timestamptz`
     - **UNIQUE `(user_id, reason, ref_id)`** para idempotência total no sync offline.

#### Buckets de Storage (privados, acesso via RLS por pasta `{user_id}/...`)
- `fog-snapshots`: arquivo binário `DSBF` (`encodeFog`), opcionalmente comprimido com `fflate`.
- `activity-tracks`: trilhas `Float64Array` comprimidas por atividade (`{user_id}/{activity_id}.bin.gz`).

#### Alternativa rejeitada para névoa e trilhas
- Guardar cada célula de névoa ou cada ponto GPS como linha no Postgres. Com dezenas de milhares de células por jogador, isso multiplicaria o volume de linhas, índices e tráfego sem benefício prático.

### 4. Verificação Estrita no Servidor (Anti-Cheat) + Experiência Otimista Offline
- **Decisão:** Adotar **verificação estrita via Supabase Edge Function (`verify-activity`)** antes de creditar XP, moedas e totais oficiais de ranking.
- **Fluxo:**
  1. **Offline / Ao vivo:** Ao finalizar uma atividade, o app salva localmente e mostra imediatamente o progresso otimista (XP, nível, moedas pendentes, névoa revelada) para zero atrito.
  2. **Envio (quando online):** A outbox faz upload da trilha comprimida para `activity-tracks` e chama a Edge Function `verify-activity` com o resumo da atividade, capturas, moedas coletadas e boosters ativados.
  3. **Validação no servidor:** A Edge Function lê a trilha no Storage, recalcula distância, tempo em movimento, velocidade máxima/anomalias (teleporte ou velocidade incompatível com a modalidade), valida os boosters aplicados (`user_boost_usages`) e calcula XP e moedas autoritativos.
  4. **Commit atômico (`service_role`):** Grava `activities` com `verification_status = 'verified'` (ou `'flagged'` com `verification_reason`), registra o crédito no `wallet_ledger`, atualiza `profiles` (`xp`, `level`, `wallet`, totais) e devolve o estado autoritativo para o cliente reconciliar.
- **Restrição de escrita:** Políticas RLS bloqueiam `INSERT`/`UPDATE` direto do cliente nas colunas econômicas/ranking de `profiles`, `activities`, `wallet_ledger` e `user_inventory`. Apenas o perfil cosmético (`display_name`, `username`, `avatar_config`, `modality`, `settings`, `is_public`) é editável diretamente pelo cliente.

### 5. Social, Busca de Usuários e Rankings (Amigos → Global)
- **Descoberta de amigos:**
  - Busca por `@username` ou `display_name` via RPC `search_users(query)` (índice `pg_trgm`, apenas perfis `is_public = true`).
  - **Link de convite compartilhável** (deep link `desbrava://add/<username>` / URL web) que abre direto o cartão do jogador para enviar pedido de amizade.
- **Modelo de amizade:** Amizade mútua (`pending` → `accepted`, com opção de recusar ou `blocked`).
- **Privacidade do perfil de amigos:** Amigos aceitos veem apenas o **resumo do perfil** (avatar, `@username`, nome, nível/XP, título, modalidade, totais de distância/células/capturas/atividades e contagem de conquistas desbloqueadas). **Nunca** expomos trilhas GPS, lista de atividades individuais ou coordenadas exatas.
- **Ranking de amigos (Fase 1):** RPC `get_friends_leaderboard(metric, period)` sobre o próprio usuário + amigos `accepted`:
  - **Métricas:** **Nível/XP** (padrão), **Distância** e **Células Exploradas**.
  - **Períodos:** **Geral (All-Time)** (lê direto de `profiles`) e **Mensal** (agrega `activities` verificadas do mês corrente).
- **Ranking global (Fase 2):** Preparado desde já com índices em `profiles(xp DESC)`, `profiles(total_distance_m DESC)` e `profiles(total_cells DESC)` (`WHERE is_public = true`), podendo evoluir para *materialized views* / snapshots periódicos via `pg_cron` sem quebrar o contrato do app.

### 6. Loja (Cosméticos + Consumíveis/Boosters)
- **Decisão:** Suportar já na v1 tanto **cosméticos permanentes** (chapéus, óculos, bikes, tênis, pets, paletas/presets) quanto **consumíveis/boosters** (ex.: 2x XP, raio de névoa ampliado, imã de moedas).
- **Compra atômica:** RPC `purchase_store_item(p_item_id, p_quantity)` com lock na linha do perfil (`FOR UPDATE`), validação de saldo **verificado** (`wallet >= total_price`), checagem de `max_stack`, débito em `wallet_ledger` e atualização de `user_inventory`.
- **Uso offline:**
  - Comprar itens na loja exige estar online (evita gasto duplo em dois aparelhos simultâneos).
  - Catálogo (`store_items`) e inventário (`user_inventory`) ficam em cache local: o jogador pode equipar cosméticos e **ativar boosters já comprados mesmo offline** (a ativação gera um evento `user_boost_usages` na outbox, validado e abatido do inventário quando a atividade sincroniza).

### 7. Arquitetura Offline-First e Armazenamento Local
- **Decisão:** Manter a camada atual de storage KV em arquivos/IndexedDB (`src/services/storage`) — evitando risco de migração nativa de banco agora e preservando paridade total iOS/Android/Web — e estendê-la com:
  1. **Índice completo de atividades (`activities:index`)**: remove o limite local de 200 itens mantendo `save:v1` leve.
  2. **Outbox persistente (`sync:outbox`)**: fila ordenada de eventos idempotentes pendentes (atividades finalizadas + trilhas, capturas, conquistas, uso de boosters, atualizações de perfil/avatar, flag de névoa modificada).
  3. **Caches locais para leitura offline**: `cache:friends`, `cache:leaderboard`, `cache:store` e `cache:inventory` (com `syncedAt`, padrão *stale-while-revalidate*).
- **Gatilhos de sync:** Abertura do app autenticado, retorno ao primeiro plano (`AppState`), reconexão de rede e conclusão de atividade / edição de perfil.
- **Resolução de conflitos (multi-dispositivo):**
  - **Atividades, Capturas, Conquistas, Boosts:** *Append-only* idempotente por ID.
  - **Névoa (`fog:v2`):** União de conjuntos (*Grow-Only Set CRDT*) com `revision` otimista.
  - **Moedas (`wallet`) e XP:** Estado autoritativo do servidor (`wallet_ledger` + `verify-activity`), reconciliado sobre o estado otimista local.
  - **Perfil / Avatar / Configurações:** *Last-Write-Wins* por `updated_at`.

---

## Consequências

- **Positivas:**
  - Progresso sincronizado entre iOS, Android e Web com login Apple, Google, Email/Senha e modo convidado sem fricção.
  - Experiência 100% funcional offline (incluindo gravação, uso de boosters já comprados, histórico completo e visualização em cache de amigos, ranking e loja).
  - Integridade real de moedas e rankings (preparado para o ranking global futuro) graças à verificação de trilhas em Edge Function e `wallet_ledger` append-only.
  - Privacidade preservada: amigos nunca têm acesso a trilhas GPS ou localizações exatas.
- **Trade-offs / Pontos de atenção:**
  - Verificação estrita no servidor significa que moedas/XP de atividades feitas offline ficam em estado **pendente** até sincronizar e serem verificadas pela Edge Function (só moedas verificadas podem ser gastas na loja).
  - Login nativo Apple/Google exige configurar credenciais (Apple Developer, Google Cloud OAuth e Supabase Auth) e gerar novo **development build** (`eas build --profile development` / `expo run:ios|android`), já que adiciona módulos nativos fora do Expo Go.
  - Edge Function `verify-activity` precisa replicar (ou compartilhar via módulo puro TypeScript) as mesmas regras de cálculo de distância, velocidade e XP de `src/game/geo.ts`, `src/game/config.ts` e `src/game/progression.ts` para evitar divergências entre a prévia otimista e o resultado verificado.

---

## Próximos Passos

1. Inspecionar o estado atual do projeto Supabase `lugwebngeyadfrqoapsg` (extensões, tabelas existentes, Auth e Storage).
2. Criar o Design Doc (`docs/design/003-supabase-backend.md`) com o DDL SQL completo, políticas RLS, RPCs e contrato da Edge Function `verify-activity`.
3. Aplicar migrações iniciais no Supabase e configurar buckets + provedores Auth.
4. Implementar em fases: **Fase 1** Auth + Sync/Verificação de progresso, névoa e atividades → **Fase 2** Amigos + Ranking de amigos → **Fase 3** Loja (cosméticos + boosters) → **Fase 4** Ranking global.
