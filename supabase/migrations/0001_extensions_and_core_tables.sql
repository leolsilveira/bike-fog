-- ============================================================================
-- 0001_extensions_and_core_tables.sql
-- Extensões, schema privado, 11 tabelas principais, constraints e índices.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- Schema privado para funções de trigger e helpers internos (fora da Data API)
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;

-- Função genérica para atualizar updated_at automaticamente
CREATE OR REPLACE FUNCTION private.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.set_updated_at() FROM PUBLIC, anon, authenticated;

-- Curva de níveis idêntica a src/game/progression.ts (levelFromXp / xpToNext)
CREATE OR REPLACE FUNCTION private.level_from_xp(p_xp integer)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_level integer := 1;
  v_rest integer := GREATEST(0, COALESCE(p_xp, 0));
  v_needed integer;
  v_n integer;
BEGIN
  LOOP
    v_n := v_level - 1;
    v_needed := (round((100 + 60 * v_n + 8 * v_n * v_n) / 10.0) * 10)::integer;
    EXIT WHEN v_rest < v_needed;
    v_rest := v_rest - v_needed;
    v_level := v_level + 1;
  END LOOP;
  RETURN v_level;
END;
$$;

REVOKE ALL ON FUNCTION private.level_from_xp(integer) FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 1. profiles (1:1 com auth.users)
-- ----------------------------------------------------------------------------
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username text UNIQUE,
  display_name text NOT NULL DEFAULT 'Viajante',
  modality text NOT NULL DEFAULT 'bike',
  character_id text NOT NULL DEFAULT 'lia',
  avatar_config jsonb NOT NULL DEFAULT '{"hair":"pony","colors":{"skin":"#e8b48a","hair":"#4a2c2a","top":"#ff6b5a","bottom":"#2f3e7a","shoe":"#4fe0b0","helmet":"#ffd23f","bike":"#4fe0b0"}}'::jsonb,
  -- Colunas gerenciadas exclusivamente pelo servidor (Edge Function / RPC)
  xp integer NOT NULL DEFAULT 0,
  level integer NOT NULL DEFAULT 1,
  wallet integer NOT NULL DEFAULT 0,
  total_distance_m double precision NOT NULL DEFAULT 0,
  total_moving_s double precision NOT NULL DEFAULT 0,
  total_activities integer NOT NULL DEFAULT 0,
  total_coins_value integer NOT NULL DEFAULT 0,
  total_coins_count integer NOT NULL DEFAULT 0,
  total_captures integer NOT NULL DEFAULT 0,
  total_cells integer NOT NULL DEFAULT 0,
  achievements_count integer NOT NULL DEFAULT 0,
  -- Configurações sincronizáveis (sound, haptics) e visibilidade
  settings jsonb NOT NULL DEFAULT '{"sound":true,"haptics":true}'::jsonb,
  is_public boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT profiles_username_format CHECK (username IS NULL OR username ~ '^[a-z0-9_]{3,24}$'),
  CONSTRAINT profiles_display_name_len CHECK (char_length(trim(display_name)) BETWEEN 1 AND 32),
  CONSTRAINT profiles_modality_check CHECK (modality IN ('bike', 'run')),
  CONSTRAINT profiles_character_id_len CHECK (char_length(trim(character_id)) BETWEEN 1 AND 40),
  CONSTRAINT profiles_avatar_is_obj CHECK (jsonb_typeof(avatar_config) = 'object'),
  CONSTRAINT profiles_settings_is_obj CHECK (jsonb_typeof(settings) = 'object'),
  CONSTRAINT profiles_xp_nonneg CHECK (xp >= 0),
  CONSTRAINT profiles_level_pos CHECK (level >= 1),
  CONSTRAINT profiles_wallet_nonneg CHECK (wallet >= 0),
  CONSTRAINT profiles_totals_nonneg CHECK (
    total_distance_m >= 0 AND
    total_moving_s >= 0 AND
    total_activities >= 0 AND
    total_coins_value >= 0 AND
    total_coins_count >= 0 AND
    total_captures >= 0 AND
    total_cells >= 0 AND
    achievements_count >= 0
  )
);

CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

-- Índices trigram para busca de usuários públicos
CREATE INDEX idx_profiles_username_trgm
  ON public.profiles USING gin (username extensions.gin_trgm_ops)
  WHERE is_public = true AND username IS NOT NULL;

CREATE INDEX idx_profiles_display_name_trgm
  ON public.profiles USING gin (display_name extensions.gin_trgm_ops)
  WHERE is_public = true;

-- Índices parciais com cobertura (covering) para ranking global (All-Time)
CREATE INDEX idx_profiles_global_xp
  ON public.profiles (xp DESC, id ASC)
  INCLUDE (username, display_name, level, character_id, avatar_config, modality)
  WHERE is_public = true;

CREATE INDEX idx_profiles_global_distance
  ON public.profiles (total_distance_m DESC, id ASC)
  INCLUDE (username, display_name, level, character_id, avatar_config, modality)
  WHERE is_public = true;

CREATE INDEX idx_profiles_global_cells
  ON public.profiles (total_cells DESC, id ASC)
  INCLUDE (username, display_name, level, character_id, avatar_config, modality)
  WHERE is_public = true;

-- ----------------------------------------------------------------------------
-- 2. activities (escrita exclusiva do servidor via verify-activity / commit_verified_activity)
-- ----------------------------------------------------------------------------
CREATE TABLE public.activities (
  id text NOT NULL,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'live',
  verification_status text NOT NULL DEFAULT 'pending',
  verification_reason text,
  modality text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  elapsed_s double precision NOT NULL DEFAULT 0,
  moving_s double precision NOT NULL DEFAULT 0,
  distance_m double precision NOT NULL DEFAULT 0,
  max_speed double precision NOT NULL DEFAULT 0,
  coins_value integer NOT NULL DEFAULT 0,
  coins_count integer NOT NULL DEFAULT 0,
  new_cells integer NOT NULL DEFAULT 0,
  xp integer NOT NULL DEFAULT 0,
  city_ids text[] NOT NULL DEFAULT '{}'::text[],
  capture_ids text[] NOT NULL DEFAULT '{}'::text[],
  track_path text,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,

  PRIMARY KEY (user_id, id),
  CONSTRAINT activities_id_len CHECK (char_length(trim(id)) BETWEEN 1 AND 80),
  CONSTRAINT activities_source_check CHECK (source IN ('live', 'gpx_import')),
  CONSTRAINT activities_status_check CHECK (verification_status IN ('pending', 'verified', 'flagged')),
  CONSTRAINT activities_modality_check CHECK (modality IN ('bike', 'run')),
  CONSTRAINT activities_time_order CHECK (ended_at >= started_at),
  CONSTRAINT activities_metrics_nonneg CHECK (
    elapsed_s >= 0 AND moving_s >= 0 AND distance_m >= 0 AND max_speed >= 0 AND
    coins_value >= 0 AND coins_count >= 0 AND new_cells >= 0 AND xp >= 0
  )
);

CREATE INDEX idx_activities_user_started_at
  ON public.activities (user_id, started_at DESC);

CREATE INDEX idx_activities_user_verified_started
  ON public.activities (user_id, verification_status, started_at)
  INCLUDE (xp, distance_m, new_cells, source);

-- Índice parcial exclusivo para rankings mensais competitivos (apenas trilhas ao vivo verificadas)
CREATE INDEX idx_activities_verified_monthly_global
  ON public.activities (started_at, user_id)
  INCLUDE (xp, distance_m, new_cells)
  WHERE verification_status = 'verified' AND source = 'live';

-- ----------------------------------------------------------------------------
-- 3. user_cities (progresso por município)
-- ----------------------------------------------------------------------------
CREATE TABLE public.user_cities (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  city_id text NOT NULL,
  name text NOT NULL,
  state text,
  country text,
  area_m2 double precision NOT NULL,
  bbox jsonb NOT NULL,
  cells integer NOT NULL DEFAULT 0,
  cell_area_m2 double precision NOT NULL DEFAULT 0,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, city_id),
  CONSTRAINT user_cities_id_len CHECK (char_length(trim(city_id)) BETWEEN 1 AND 120),
  CONSTRAINT user_cities_name_len CHECK (char_length(trim(name)) BETWEEN 1 AND 120),
  CONSTRAINT user_cities_area_nonneg CHECK (area_m2 >= 0 AND cells >= 0 AND cell_area_m2 >= 0),
  CONSTRAINT user_cities_bbox_array CHECK (jsonb_typeof(bbox) = 'array' AND jsonb_array_length(bbox) = 4)
);

CREATE TRIGGER trg_user_cities_updated_at
  BEFORE UPDATE ON public.user_cities
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

-- ----------------------------------------------------------------------------
-- 4. user_captures (POIs capturados)
-- ----------------------------------------------------------------------------
CREATE TABLE public.user_captures (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  poi_id text NOT NULL,
  name text NOT NULL,
  category text NOT NULL,
  rarity text NOT NULL,
  lng double precision NOT NULL,
  lat double precision NOT NULL,
  city_id text,
  activity_id text,
  captured_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, poi_id),
  CONSTRAINT user_captures_poi_len CHECK (char_length(trim(poi_id)) BETWEEN 1 AND 120),
  CONSTRAINT user_captures_name_len CHECK (char_length(trim(name)) BETWEEN 1 AND 160),
  CONSTRAINT user_captures_category_check CHECK (
    category IN ('parque','arte','templo','cultura','biblioteca','museu','monumento','mirante','estadio','atracao')
  ),
  CONSTRAINT user_captures_rarity_check CHECK (
    rarity IN ('comum','incomum','raro','epico','lendario')
  ),
  CONSTRAINT user_captures_coords_check CHECK (lng BETWEEN -180 AND 180 AND lat BETWEEN -90 AND 90)
);

CREATE INDEX idx_user_captures_user_cat_rarity
  ON public.user_captures (user_id, category, rarity);

-- ----------------------------------------------------------------------------
-- 5. user_achievements (conquistas desbloqueadas via claim_achievement RPC)
-- ----------------------------------------------------------------------------
CREATE TABLE public.user_achievements (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  achievement_key text NOT NULL,
  unlocked_at timestamptz NOT NULL DEFAULT now(),
  coins_awarded integer NOT NULL DEFAULT 0,

  PRIMARY KEY (user_id, achievement_key),
  CONSTRAINT user_achievements_key_len CHECK (char_length(trim(achievement_key)) BETWEEN 1 AND 160),
  CONSTRAINT user_achievements_coins_nonneg CHECK (coins_awarded >= 0)
);

-- ----------------------------------------------------------------------------
-- 6. user_fog_state (metadados do snapshot binário da névoa + revision otimista)
-- ----------------------------------------------------------------------------
CREATE TABLE public.user_fog_state (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  cell_count integer NOT NULL DEFAULT 0,
  revision bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT user_fog_state_cell_nonneg CHECK (cell_count >= 0),
  CONSTRAINT user_fog_state_rev_nonneg CHECK (revision >= 0)
);

-- ----------------------------------------------------------------------------
-- 7. friendships (amizade mútua e bloqueio)
-- ----------------------------------------------------------------------------
CREATE TABLE public.friendships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  addressee_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  blocked_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT friendships_no_self CHECK (requester_id <> addressee_id),
  CONSTRAINT friendships_status_check CHECK (status IN ('pending', 'accepted', 'blocked')),
  CONSTRAINT friendships_blocked_by_check CHECK (
    (status = 'blocked' AND blocked_by IN (requester_id, addressee_id)) OR
    (status <> 'blocked' AND blocked_by IS NULL)
  )
);

CREATE UNIQUE INDEX idx_friendships_pair_unique
  ON public.friendships (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id));

CREATE INDEX idx_friendships_requester_status
  ON public.friendships (requester_id, status);

CREATE INDEX idx_friendships_addressee_status
  ON public.friendships (addressee_id, status);

CREATE INDEX idx_friendships_blocked_by
  ON public.friendships (blocked_by);

CREATE TRIGGER trg_friendships_updated_at
  BEFORE UPDATE ON public.friendships
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

-- ----------------------------------------------------------------------------
-- 8. store_items (catálogo da loja)
-- ----------------------------------------------------------------------------
CREATE TABLE public.store_items (
  id text PRIMARY KEY,
  kind text NOT NULL,
  category text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  price_coins integer NOT NULL,
  rarity text NOT NULL DEFAULT 'comum',
  max_stack integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT store_items_kind_check CHECK (kind IN ('cosmetic', 'consumable')),
  CONSTRAINT store_items_category_check CHECK (
    category IN ('character', 'hat', 'glasses', 'bike', 'shoe', 'pet', 'color', 'boost_xp', 'boost_fog', 'boost_coins')
  ),
  CONSTRAINT store_items_rarity_check CHECK (rarity IN ('comum', 'incomum', 'raro', 'epico', 'lendario')),
  CONSTRAINT store_items_price_nonneg CHECK (price_coins >= 0),
  CONSTRAINT store_items_max_stack_pos CHECK (max_stack IS NULL OR max_stack >= 1),
  CONSTRAINT store_items_metadata_obj CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX idx_store_items_active_sort
  ON public.store_items (sort_order, id)
  WHERE is_active = true;

-- ----------------------------------------------------------------------------
-- 9. user_inventory (escrita exclusiva via purchase_store_item / commit_verified_activity)
-- ----------------------------------------------------------------------------
CREATE TABLE public.user_inventory (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  item_id text NOT NULL REFERENCES public.store_items(id),
  quantity integer NOT NULL DEFAULT 1,
  first_purchased_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, item_id),
  CONSTRAINT user_inventory_qty_nonneg CHECK (quantity >= 0)
);

CREATE INDEX idx_user_inventory_item_id
  ON public.user_inventory (item_id);

-- ----------------------------------------------------------------------------
-- 10. user_boost_usages (consumo offline/online de boosters)
-- ----------------------------------------------------------------------------
CREATE TABLE public.user_boost_usages (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  item_id text NOT NULL REFERENCES public.store_items(id),
  activity_id text,
  activated_at timestamptz NOT NULL,
  expires_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT user_boost_usages_id_len CHECK (char_length(trim(id)) BETWEEN 1 AND 80),
  CONSTRAINT user_boost_usages_expires_after CHECK (expires_at IS NULL OR expires_at >= activated_at)
);

CREATE INDEX idx_user_boost_usages_user_act
  ON public.user_boost_usages (user_id, activity_id);

CREATE INDEX idx_user_boost_usages_item_id
  ON public.user_boost_usages (item_id);

-- ----------------------------------------------------------------------------
-- 11. wallet_ledger (extrato append-only de moedas)
-- ----------------------------------------------------------------------------
CREATE TABLE public.wallet_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  delta integer NOT NULL,
  reason text NOT NULL,
  ref_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT wallet_ledger_delta_nonzero CHECK (delta <> 0),
  CONSTRAINT wallet_ledger_reason_check CHECK (
    reason IN ('activity_coins', 'achievement', 'store_purchase', 'migration', 'adjustment')
  ),
  CONSTRAINT wallet_ledger_unique_ref UNIQUE (user_id, reason, ref_id)
);

CREATE INDEX idx_wallet_ledger_user_created
  ON public.wallet_ledger (user_id, created_at DESC);
