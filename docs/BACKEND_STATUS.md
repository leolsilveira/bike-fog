# Estado do Backend e Integração — Desbrava

**Última atualização:** 2026-11-21 (fechamento do marco **M5 — `store-cosmetics-ui`** na branch `react-native`)

Este documento acompanha o que já está implantado no Supabase, o que já existe no código do aplicativo Expo/React Native, o que foi adiado no escopo atual e como rodar/testar o projeto localmente ou no dispositivo.

---

## 1. O que está implantado no Supabase (`lugwebngeyadfrqoapsg`)

- **Projeto:** `lugwebngeyadfrqoapsg` (região `eu-west-1`, PostgreSQL 17.12)
- **URL:** `https://lugwebngeyadfrqoapsg.supabase.co`
- **Migrações aplicadas (`0001`–`0009` em `supabase/migrations/`):**
  - `0001_extensions_and_core_tables` — extensão `pg_trgm` no schema `extensions`, schema `private` e 11 tabelas em `public` com índices.
  - `0002_auth_trigger_and_rls` — trigger `on_auth_user_created` (`private.handle_new_user`), triggers de proteção e RLS nas 11 tabelas.
  - `0003_storage_buckets` — buckets privados e políticas em `storage.objects`.
  - `0004_rpcs` — funções RPC iniciais.
  - `0005_seed_store_items` — catálogo inicial da loja (`store_items`).
  - `0006_service_role_private_grants` — permissões do schema `private` para `service_role`.
  - `0007_security_hardening_and_index_fix` — endurecimento pós-auditoria (`commit_verified_activity_v2`, proteção de `user_captures.is_verified`, índices globais por métrica).
  - `0008_protect_verified_captures_and_city_pct` — bloqueio de `UPDATE` em capturas verificadas, cálculo autoritativo de `city_pct` e checagem `IS DISTINCT FROM` em `upsert_fog_state`.
  - `0009_reject_nan_and_revoke_table_privs` — constraint `user_cities_area_finite` contra `NaN`/`Infinity`, guarda finita em `claim_achievement` e revogação de privilégios residuais (`TRUNCATE`, `REFERENCES`, `TRIGGER`, `MAINTAIN`) nas 11 tabelas.

### Tabelas (`public`, todas com RLS habilitada) e proteção de colunas

| Tabela | Proteção principal |
|---|---|
| `profiles` | `SELECT` restrito ao próprio dono (`auth.uid() = id`); `REVOKE/GRANT` por coluna + trigger `private.protect_profile_columns` bloqueiam escrita direta do cliente em `xp`, `level`, `wallet`, `total_*` e `achievements_count`. |
| `activities` | Escrita direta pelo cliente bloqueada; gravada exclusivamente via `commit_verified_activity_v2` (`service_role`). |
| `user_cities` | `SELECT`/`INSERT`/`UPDATE` apenas do próprio usuário; `area_m2` e `cell_area_m2` finitos e não negativos; conquistas exigem atividade verificada. |
| `user_captures` | `GRANT` por coluna exclui `is_verified`; trigger `private.protect_user_captures_columns` força `is_verified = false` no cliente e bloqueia `UPDATE` em capturas já verificadas (`42501`). |
| `user_achievements` | Escrita direta pelo cliente bloqueada; desbloqueio exclusivo pela RPC `claim_achievement`. |
| `user_fog_state` | Escrita direta pelo cliente bloqueada; atualização exclusiva pela RPC `upsert_fog_state`. |
| `friendships` | `SELECT`/`INSERT`/`UPDATE`/`DELETE` restritos às partes, com máquina de estados e proteção de bloqueio via `private.protect_friendships_transitions` (`blocked_by`). |
| `store_items` | Somente leitura para `anon` e `authenticated`. |
| `user_inventory` | Escrita direta pelo cliente bloqueada; gerenciada por `purchase_store_item` e `commit_verified_activity_v2`. |
| `user_boost_usages` | `SELECT` e `INSERT` do próprio usuário apenas com `consumed_at IS NULL`; consumo atômico no servidor. |
| `wallet_ledger` | Extrato append-only (`UNIQUE (user_id, reason, ref_id)`); escrita exclusiva do servidor. |

### Storage Buckets Privados

- `fog-snapshots` (`public = false`, limite `10 MiB`, caminho `{user_id}/fog.bin.gz`)
- `activity-tracks` (`public = false`, limite `5 MiB`, caminho `{user_id}/{activity_id}.bin.gz`)
- Políticas em `storage.objects` restringem `SELECT`, `INSERT`, `UPDATE` e `DELETE` a `authenticated` na pasta do próprio `auth.uid()`.

### Funções RPC (`public`)

- `search_users(p_query, p_limit)` — busca pública por `@username` / nome (`pg_trgm`) excluindo bloqueios.
- `get_public_profile(p_user_id)` e `get_public_profile_by_username(p_username)` — resumo público/de amigo sem expor `wallet`, `settings`, `activities` ou trilhas.
- `get_friends_leaderboard(p_metric, p_period)` — ranking entre amigos aceitos (`xp` | `distance` | `cells`, `all_time` | `monthly` em `America/Sao_Paulo`).
- `get_global_leaderboard(p_metric, p_period, p_limit, p_offset)` — ranking global (`is_public = true` no `all_time` e atividades `verified` + `live` no `monthly`) com `{ entries, my_rank }`.
- `purchase_store_item(p_item_id, p_quantity)` — compra atômica com lock `FOR UPDATE` em `profiles` e `user_inventory`, débito em `wallet` e lançamento em `wallet_ledger`.
- `claim_achievement(p_achievement_key)` — validação autoritativa em chave canônica contra atividades/capturas/cidades verificadas e crédito idempotente em `wallet`.
- `upsert_fog_state(p_storage_path, p_cell_count, p_expected_revision)` — controle otimista de `revision` e teto de células verificadas.
- `commit_verified_activity_v2(...)` — restrita a `service_role`, grava atividade, promove capturas verificadas, consome boosters (`user_boost_usages` + `user_inventory`), lança moedas no `wallet_ledger` e recalcula totais/nível no perfil. *(A assinatura legada `commit_verified_activity` v1 foi revogada inclusive de `service_role`.)*

### Edge Function e Seed da Loja

- **Edge Function `verify-activity`** (`status: ACTIVE`, versão `3`, `verify_jwt = false` com validação interna via `auth.getUser(token)`): lê a trilha `.bin.gz` no bucket `activity-tracks`, valida assinatura gzip/formato, aplica paridade matemática e regras anti-cheat em `supabase/functions/verify-activity/{index.ts, validator.ts, gameMath.ts}` e chama `commit_verified_activity_v2`.
- **Seed `store_items`** (`0005_seed_store_items.sql`): **19 itens** ativos em pt-BR — 16 cosméticos permanentes (`character`: Kenji, Maya, Zeca; `hat`: Boné Retrô, Gorro Urbano, Coroa do Desbravador; `glasses`: Óculos Aviador, Viseira Neon; `bike`: Quadro Carbono, Bike Dourada; `shoe`: Tênis Turbo Coral, Tênis Relâmpago; `pet`: Doguinho Caramelo, Gatinho da Névoa; `color`: Paleta Cyber Neon, Paleta Aurora Real) e 3 boosters consumíveis (`boost_xp_2x`, `boost_fog_wide`, `boost_coins_2x`, empilháveis até 10 unidades).

---

## 2. O que já está implementado no app

- **Concluído — M1 (`design-backend`):**
  - Especificação completa em `docs/design/003-supabase-backend.md` e ADR em `docs/decisions/003-supabase-backend-and-offline-sync.md`.
  - Migrações `0001`–`0009` e Edge Function `verify-activity` versionadas em `supabase/` e implantadas no projeto `lugwebngeyadfrqoapsg`.
  - Dependências Expo SDK 57 instaladas em `package.json`: `@supabase/supabase-js`, `expo-secure-store`, `expo-crypto` e `expo-linking` (com plugin `expo-secure-store` configurado em `app.json`).
  - Template de variáveis de ambiente em `.env.example` e script de verificação de backend em `scripts/verify-supabase-backend.ts`.
- **Concluído — M2 (`supabase-sync-core`):**
  - Armazenamento seguro de sessão: `src/services/sessionStorage.ts` (`LargeSecureStore` nativo com `expo-crypto` AES-256-GCM + `expo-secure-store` `AFTER_FIRST_UNLOCK` + `Documents/desbrava-auth` isolado de `wipeAll()`) e `src/services/sessionStorage.web.ts` (`window.localStorage` com fallback em memória).
  - Cliente Supabase singleton: `src/services/supabase.ts` (`isSupabaseConfigured()`, `requireSupabase()`, `getSupabaseSession()`, `getSupabaseUser()`, lifecycle de `autoRefreshToken` no `AppState` nativo e boot seguro no Modo Convidado quando sem env).
  - Motor de sincronização bidirecional: `src/services/syncCore.ts` (puro/testável no Node) e `src/services/sync.ts` (hooks no app): `syncProfile`, `syncActivity` (trilha `.bin.gz` via `activity-tracks` + Edge Function `verify-activity` + reconciliação autoritativa), `syncFog` (snapshot `DSBF` gzipado em `fog-snapshots` com `cacheControl: '0'`/`cacheNonce` + `upsert_fog_state` e retry com `fog.merge` em conflitos), `syncCitiesAndCaptures` (preservando `user_captures.is_verified = true`), `syncAchievements` (`claim_achievement`), `pushAllLocalToCloud`, `pullCloudToLocal` e auto-sync não-bloqueante ao hidratar, finalizar atividade ao vivo, importar GPX, editar perfil/configurações ou desbloquear conquistas.
  - Adaptações no estado e matemática do jogo: guarda polar em `src/game/geo.ts` (`|lat| <= 85.05112878`, `r <= 1024`), `fog.merge()` com remapeamento de `cityIds` em `src/game/fog.ts`, rastreio de `coinsByKind` e ações de reconciliação (`setSyncState`, `reconcileVerifiedActivity`, `applyCloudSnapshot`) em `src/game/store.ts` e `src/game/types.ts`, estado `fog:sync` e boot hook em `src/game/persist.ts` e auto-sync após importação GPX em `src/game/activitiesTransfer.ts`.
  - Verificação: `scripts/verify-sync-core.ts` (testes unitários + integração ao vivo contra `lugwebngeyadfrqoapsg`), `scripts/test-achievements.ts`, `npm run typecheck`, `npm run lint` e `npm run build:web` passando.
- **Concluído — M3 (`auth-migration-ui`):**
  - Autenticação e perfil (`src/services/authCore.ts`, `src/services/auth.ts`): `signInWithEmail`, `signUpWithEmail`, `sendPasswordReset`, `signOutAndReset`, `initAuthListener`, `updateProfileSettings`, validação/sugestão de `@username` (`^[a-z0-9_]{3,24}$`) e mensagens de erro mapeadas em pt-BR.
  - Migração local ↔ nuvem (`src/services/migrationCore.ts`, `src/services/migration.ts`): inspeção de estado local vs nuvem (`profiles`, `activities`, `user_fog_state`), envio automático para conta nova, substituição automática para aparelho vazio e diálogo de conflito (`MigrationModal` com **Mesclar progresso** e **Manter apenas a nuvem**, com correção de persistência de `fog:v2` após `wipeAll()` em `src/game/persist.ts`).
  - Deep links de convite (`src/services/deepLinkCore.ts`, `src/services/deepLink.ts`): captura `desbrava://add/<username>`, URLs web `/add/<username>` e `?add=<username>` em `pendingInviteUsername` via `App.tsx`, preservando `?skip`, `?sim=1`, `?debug` e `?gallery`.
  - Telas e modais: `AuthModal.tsx`, `MigrationModal.tsx`, `Modals.tsx`, `TitleScreen.tsx` (Modo Convidado instantâneo + botão entrar/badge da conta), `CreateScreen.tsx` (`@username` opcional com sugestão automática) e `StatsScreen.tsx` (cartão **Conta e Sincronização** com `@username`, toggle `Perfil público`, sincronização manual e logout limpo).
  - Verificação: `scripts/verify-auth-migration.ts`, `scripts/verify-sync-core.ts`, `scripts/test-achievements.ts`, `npm run typecheck`, `npm run lint`, `npm run build:web` e smoke check no Chrome headless contra `dist/`.
- **Concluído — M4 (`friends-ranking-ui`):**
  - Serviços sociais (`src/services/socialCore.ts`, `src/services/social.ts`): busca pública (`search_users`), perfis públicos (`get_public_profile`, `get_public_profile_by_username`), ciclo de vida completo de amizades (`pending`/`accepted`/`blocked`, auto-aceite em convite cruzado, bloqueio via `blocked_by`, desbloqueio/recusa/cancelamento/remoção via `DELETE`), rankings de Amigos (`get_friends_leaderboard`) e Global (`get_global_leaderboard` com paginação e `my_rank` fixado) em XP, Distância e Células (Geral e Mensal), além de compartilhamento de link de convite (`desbrava://add/<username>` / `?add=<username>`).
  - Telas, modais e navegação (`SocialScreen.tsx`, `FriendProfileModal.tsx`, `Hud.tsx`, `Modals.tsx`, `App.tsx`, `src/game/types.ts`, `src/game/store.ts`): nova aba **Social** na `TabBar`, estado de Convidado com CTA de login, banner de convite pendente por deep link (`pendingInviteUsername`), busca por `@username`/nome, solicitações recebidas/enviadas, lista de amigos/bloqueados, modal de resumo público do explorador (sem expor trilhas, atividades, carteira ou ajustes) e filtros completos de ranking.
  - Polimento M3 (`src/services/migration.ts`): `resolveMigrationCloudOnly()` agora conclui `pullCloudToLocal({ mode: 'replace' })` antes de limpar dados locais e fechar o `MigrationModal`, preservando o estado local e exibindo erros de rede caso a nuvem falhe.
  - Verificação: `scripts/verify-social.ts`, `scripts/test-achievements.ts`, `npm run typecheck`, `npm run lint`, `npm run build:web` e smoke check no Chrome headless contra `dist/`.
- **Concluído — M5 (`store-cosmetics-ui`):**
  - Serviços da Loja (`src/services/storeServiceCore.ts` puro para Node 24 e `src/services/storeService.ts`): catálogo online (`store_items`), inventário e carteira autoritativos (`user_inventory`, `profiles.wallet`, desbloqueio de personagens `char_*`), compra atômica via RPC `purchase_store_item`, ativação online de boosters (`user_boost_usages`) e equipamento/remoção de cosméticos (`equipCosmetic`) com sincronização automática de perfil (`syncProfile`), mapeando erros offline e de validação em pt-BR.
  - Cosméticos em pixel art e mapa (`src/sprites/icons.ts`, `src/sprites/characters.ts`, `src/sprites/avatar.ts`, `src/services/syncCore.ts`, `map-runtime/` + `src/map/mapHtml.generated.ts`): suporte opcional a `AvatarConfig.cosmetics` (`hat`, `glasses`, `bike`, `shoe`, `pet`, `color`) renderizado no mesmo pipeline tanto nos sprites da interface quanto no mapa em WebView/iframe, com validação estrita em `isValidAvatarConfig`.
  - Boosters no gameplay (`src/game/types.ts`, `src/game/store.ts`, `src/game/tracker.ts`): estado em tempo real `activeBoosters`, vínculo automático de `boostUsageIds` na atividade ao vivo (`startActivity` / `addActiveBooster` / `finishActivity`) com reconciliação na `verify-activity`, multiplicador de raio `boost_fog` em `effectiveRevealRadius` (1:1 com o servidor), multiplicador `boost_xp` e prévia `boost_coins` mantendo `live.coinsValue` no valor base para paridade com `coinsByKind`.
  - Interface e navegação (`src/ui/screens/ShopScreen.tsx`, `src/ui/components/Hud.tsx`, `src/map/sync.ts`, `App.tsx`): nova aba **Loja** (`tab-shop`) na `TabBar`, estado Convidado com CTA de login (`auth-open-btn`), banner de erro/offline (`store-offline-error`), prévia do avatar equipado, filtros de catálogo (`shop-item-<id>`, `shop-buy-btn`) e seção **Mochila · Boosters** com contagem regressiva e ativação online (`inventory-booster-<id>`, `booster-activate-btn`).
  - Verificação: `npm run build:map`, `scripts/verify-store.ts` (unitário + integração ao vivo contra `lugwebngeyadfrqoapsg`), `scripts/test-achievements.ts`, `scripts/verify-sync-core.ts`, `scripts/verify-auth-migration.ts`, `scripts/verify-social.ts`, `npm run typecheck`, `npm run lint`, `npm run build:web` e smoke check no Chrome headless contra `dist/`.

---

## 3. O que foi adiado (Deferred)

Para priorizar o app funcionando de ponta a ponta com integração online direta no Supabase, os itens abaixo foram explicitamente **adiados (fora do escopo atual)**:

- Iterações adicionais de auditoria profunda de segurança e loops extras de hardening no backend.
- Expansão e execução de suítes pesadas de testes E2E (`tier1`–`tier4`).
- Fila offline durável (`sync:outbox`) e caches locais de leitura (`cache:friends`, `cache:leaderboard`, `cache:store`, `cache:inventory`).
- Ativação e reconciliação offline de boosters (os boosters serão ativados online via `user_boost_usages`).
- Provedores OAuth **Sign in with Apple** e **Google Sign-In**.

---

## 4. Como rodar e testar localmente / no dispositivo

1. **Configurar variáveis de ambiente (nunca commitar `.env.local`):**
   ```bash
   cp .env.example .env.local
   ```
   Preencha `.env.local` com os valores do projeto `lugwebngeyadfrqoapsg`:
   - `EXPO_PUBLIC_SUPABASE_URL=https://lugwebngeyadfrqoapsg.supabase.co`
   - `EXPO_PUBLIC_SUPABASE_ANON_KEY=<sua-chave-publicavel-ou-anon>`

2. **Instalar dependências (também gera o mapa embutido via `postinstall`):**
   ```bash
   npm install
   ```

3. **Rodar verificações estáticas (obrigatório antes de fechar qualquer entrega):**
   ```bash
   npm run typecheck
   npm run lint
   ```

4. **Rodar no dispositivo ou navegador:**
   ```bash
   npx expo start
   ```
   - Escaneie o QR Code com o Expo Go / Development Build no iOS ou Android, ou pressione `w` (ou rode `npm run web`) para abrir na Web.
   - Se adicionar módulos nativos fora do bundle do Expo Go, gere um Development Build com `npx expo run:ios` / `npx expo run:android` ou `npx eas-cli@latest build --profile development`.

5. **Gerar build estático para Web:**
   ```bash
   npm run build:web
   ```
