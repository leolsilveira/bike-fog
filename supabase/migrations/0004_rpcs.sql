-- ============================================================================
-- 0004_rpcs.sql
-- RPCs públicos (restritos a authenticated): busca, perfis públicos,
-- rankings de amigos e global, compra atômica, conquistas, sync da névoa
-- e commit_verified_activity (SECURITY INVOKER, restrito a service_role).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. search_users(p_query, p_limit)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_users(
  p_query text,
  p_limit int DEFAULT 20
)
RETURNS TABLE (
  id uuid,
  username text,
  display_name text,
  level integer,
  xp integer,
  total_distance_m double precision,
  total_cells integer,
  avatar_config jsonb,
  character_id text,
  modality text,
  friendship_status text,
  friendship_direction text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_q text;
  v_like text;
  v_limit int;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Não autenticado' USING ERRCODE = '42501';
  END IF;

  v_q := lower(trim(COALESCE(p_query, '')));
  IF left(v_q, 1) = '@' THEN
    v_q := substr(v_q, 2);
  END IF;

  IF char_length(v_q) < 2 THEN
    RETURN;
  END IF;

  v_limit := least(greatest(COALESCE(p_limit, 20), 1), 50);
  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  RETURN QUERY
  SELECT
    p.id,
    p.username,
    p.display_name,
    p.level,
    p.xp,
    p.total_distance_m,
    p.total_cells,
    p.avatar_config,
    p.character_id,
    p.modality,
    COALESCE(f.status, 'none')::text AS friendship_status,
    CASE
      WHEN f.id IS NULL THEN 'none'
      WHEN f.requester_id = v_uid THEN 'outgoing'
      ELSE 'incoming'
    END::text AS friendship_direction
  FROM public.profiles p
  LEFT JOIN public.friendships f
    ON (f.requester_id = v_uid AND f.addressee_id = p.id)
    OR (f.addressee_id = v_uid AND f.requester_id = p.id)
  WHERE p.is_public = true
    AND p.id <> v_uid
    AND COALESCE(f.status, '') <> 'blocked'
    AND (
      p.username ILIKE v_like ESCAPE '\'
      OR p.display_name ILIKE v_like ESCAPE '\'
      OR p.username % v_q
      OR p.display_name % v_q
    )
  ORDER BY
    (p.username = v_q) DESC,
    (p.username LIKE replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%' ESCAPE '\') DESC,
    greatest(
      extensions.similarity(COALESCE(p.username, ''), v_q),
      extensions.similarity(p.display_name, v_q)
    ) DESC,
    p.xp DESC,
    p.id ASC
  LIMIT v_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.search_users(text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_users(text, int) TO authenticated;

-- ----------------------------------------------------------------------------
-- 2. get_public_profile(p_user_id) e get_public_profile_by_username(p_username)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_public_profile(p_user_id uuid)
RETURNS TABLE (
  id uuid,
  username text,
  display_name text,
  modality text,
  character_id text,
  avatar_config jsonb,
  level integer,
  xp integer,
  total_distance_m double precision,
  total_moving_s double precision,
  total_activities integer,
  total_captures integer,
  total_cells integer,
  achievements_count integer,
  is_public boolean,
  friendship_status text,
  friendship_direction text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Não autenticado' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    p.username,
    p.display_name,
    p.modality,
    p.character_id,
    p.avatar_config,
    p.level,
    p.xp,
    p.total_distance_m,
    p.total_moving_s,
    p.total_activities,
    p.total_captures,
    p.total_cells,
    p.achievements_count,
    p.is_public,
    COALESCE(f.status, 'none')::text AS friendship_status,
    CASE
      WHEN f.id IS NULL THEN 'none'
      WHEN f.requester_id = v_uid THEN 'outgoing'
      ELSE 'incoming'
    END::text AS friendship_direction
  FROM public.profiles p
  LEFT JOIN public.friendships f
    ON (f.requester_id = v_uid AND f.addressee_id = p.id)
    OR (f.addressee_id = v_uid AND f.requester_id = p.id)
  WHERE p.id = p_user_id
    AND COALESCE(f.status, '') <> 'blocked'
    AND (p.id = v_uid OR p.is_public = true OR f.status = 'accepted');
END;
$$;

REVOKE ALL ON FUNCTION public.get_public_profile(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_public_profile(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_public_profile_by_username(p_username text)
RETURNS TABLE (
  id uuid,
  username text,
  display_name text,
  modality text,
  character_id text,
  avatar_config jsonb,
  level integer,
  xp integer,
  total_distance_m double precision,
  total_moving_s double precision,
  total_activities integer,
  total_captures integer,
  total_cells integer,
  achievements_count integer,
  is_public boolean,
  friendship_status text,
  friendship_direction text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_uname text;
  v_target_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Não autenticado' USING ERRCODE = '42501';
  END IF;

  v_uname := lower(trim(COALESCE(p_username, '')));
  IF left(v_uname, 1) = '@' THEN
    v_uname := substr(v_uname, 2);
  END IF;

  SELECT p.id INTO v_target_id
  FROM public.profiles p
  WHERE p.username = v_uname;

  IF v_target_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT * FROM public.get_public_profile(v_target_id);
END;
$$;

REVOKE ALL ON FUNCTION public.get_public_profile_by_username(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_public_profile_by_username(text) TO authenticated;

-- ----------------------------------------------------------------------------
-- 3. get_friends_leaderboard(p_metric, p_period)
-- Ranking mensal considera apenas atividades verificadas com source = 'live'.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_friends_leaderboard(
  p_metric text DEFAULT 'xp',
  p_period text DEFAULT 'all_time'
)
RETURNS TABLE (
  rank bigint,
  user_id uuid,
  username text,
  display_name text,
  level integer,
  xp integer,
  score double precision,
  total_distance_m double precision,
  total_cells integer,
  avatar_config jsonb,
  character_id text,
  modality text,
  is_me boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_month_start timestamptz;
  v_month_end timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Não autenticado' USING ERRCODE = '42501';
  END IF;

  IF p_metric NOT IN ('xp', 'distance', 'cells') THEN
    RAISE EXCEPTION 'Métrica inválida: %', p_metric USING ERRCODE = '22023';
  END IF;
  IF p_period NOT IN ('all_time', 'monthly') THEN
    RAISE EXCEPTION 'Período inválido: %', p_period USING ERRCODE = '22023';
  END IF;

  v_month_start := date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';
  v_month_end := (date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') + interval '1 month') AT TIME ZONE 'America/Sao_Paulo';

  RETURN QUERY
  WITH cohort AS (
    SELECT v_uid AS uid
    UNION
    SELECT CASE WHEN f.requester_id = v_uid THEN f.addressee_id ELSE f.requester_id END AS uid
    FROM public.friendships f
    WHERE f.status = 'accepted'
      AND (f.requester_id = v_uid OR f.addressee_id = v_uid)
  ),
  monthly_agg AS (
    SELECT
      a.user_id AS uid,
      COALESCE(SUM(a.xp), 0)::double precision AS m_xp,
      COALESCE(SUM(a.distance_m), 0)::double precision AS m_dist,
      COALESCE(SUM(a.new_cells), 0)::double precision AS m_cells
    FROM public.activities a
    JOIN cohort c ON c.uid = a.user_id
    WHERE p_period = 'monthly'
      AND a.verification_status = 'verified'
      AND a.source = 'live'
      AND a.started_at >= v_month_start
      AND a.started_at < v_month_end
    GROUP BY a.user_id
  ),
  scored AS (
    SELECT
      p.id AS uid,
      p.username,
      p.display_name,
      p.level,
      p.xp,
      CASE
        WHEN p_period = 'all_time' AND p_metric = 'xp' THEN p.xp::double precision
        WHEN p_period = 'all_time' AND p_metric = 'distance' THEN p.total_distance_m
        WHEN p_period = 'all_time' AND p_metric = 'cells' THEN p.total_cells::double precision
        WHEN p_period = 'monthly' AND p_metric = 'xp' THEN COALESCE(m.m_xp, 0)
        WHEN p_period = 'monthly' AND p_metric = 'distance' THEN COALESCE(m.m_dist, 0)
        ELSE COALESCE(m.m_cells, 0)
      END AS metric_score,
      p.total_distance_m,
      p.total_cells,
      p.avatar_config,
      p.character_id,
      p.modality,
      (p.id = v_uid) AS is_me
    FROM cohort c
    JOIN public.profiles p ON p.id = c.uid
    LEFT JOIN monthly_agg m ON m.uid = p.id
  )
  SELECT
    ROW_NUMBER() OVER (ORDER BY s.metric_score DESC, s.xp DESC, s.uid ASC) AS rank,
    s.uid AS user_id,
    s.username,
    s.display_name,
    s.level,
    s.xp,
    s.metric_score AS score,
    s.total_distance_m,
    s.total_cells,
    s.avatar_config,
    s.character_id,
    s.modality,
    s.is_me
  FROM scored s
  ORDER BY s.metric_score DESC, s.xp DESC, s.uid ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_friends_leaderboard(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_friends_leaderboard(text, text) TO authenticated;

-- ----------------------------------------------------------------------------
-- 4. get_global_leaderboard(p_metric, p_period, p_limit, p_offset)
-- Ranking mensal considera apenas atividades verificadas com source = 'live'.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_global_leaderboard(
  p_metric text DEFAULT 'xp',
  p_period text DEFAULT 'all_time',
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_limit int;
  v_offset int;
  v_month_start timestamptz;
  v_month_end timestamptz;
  v_entries jsonb;
  v_my_rank jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Não autenticado' USING ERRCODE = '42501';
  END IF;

  IF p_metric NOT IN ('xp', 'distance', 'cells') THEN
    RAISE EXCEPTION 'Métrica inválida: %', p_metric USING ERRCODE = '22023';
  END IF;
  IF p_period NOT IN ('all_time', 'monthly') THEN
    RAISE EXCEPTION 'Período inválido: %', p_period USING ERRCODE = '22023';
  END IF;

  v_limit := least(greatest(COALESCE(p_limit, 50), 1), 100);
  v_offset := greatest(COALESCE(p_offset, 0), 0);

  IF p_period = 'all_time' THEN
    WITH ranked AS (
      SELECT
        ROW_NUMBER() OVER (
          ORDER BY
            CASE p_metric
              WHEN 'xp' THEN p.xp::double precision
              WHEN 'distance' THEN p.total_distance_m
              ELSE p.total_cells::double precision
            END DESC,
            p.id ASC
        ) AS rank,
        p.id AS user_id,
        p.username,
        p.display_name,
        p.level,
        p.xp,
        CASE p_metric
          WHEN 'xp' THEN p.xp::double precision
          WHEN 'distance' THEN p.total_distance_m
          ELSE p.total_cells::double precision
        END AS score,
        p.total_distance_m,
        p.total_cells,
        p.avatar_config,
        p.character_id,
        p.modality,
        (p.id = v_uid) AS is_me
      FROM public.profiles p
      WHERE p.is_public = true
    )
    SELECT
      COALESCE(
        (
          SELECT jsonb_agg(to_jsonb(r) ORDER BY r.rank)
          FROM (SELECT * FROM ranked ORDER BY rank LIMIT v_limit OFFSET v_offset) r
        ),
        '[]'::jsonb
      ),
      (SELECT to_jsonb(r) FROM ranked r WHERE r.user_id = v_uid)
    INTO v_entries, v_my_rank;
  ELSE
    v_month_start := date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';
    v_month_end := (date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') + interval '1 month') AT TIME ZONE 'America/Sao_Paulo';

    WITH monthly_agg AS (
      SELECT
        a.user_id,
        COALESCE(SUM(a.xp), 0)::double precision AS m_xp,
        COALESCE(SUM(a.distance_m), 0)::double precision AS m_dist,
        COALESCE(SUM(a.new_cells), 0)::double precision AS m_cells
      FROM public.activities a
      WHERE a.verification_status = 'verified'
        AND a.source = 'live'
        AND a.started_at >= v_month_start
        AND a.started_at < v_month_end
      GROUP BY a.user_id
    ),
    ranked AS (
      SELECT
        ROW_NUMBER() OVER (
          ORDER BY
            CASE p_metric
              WHEN 'xp' THEN m.m_xp
              WHEN 'distance' THEN m.m_dist
              ELSE m.m_cells
            END DESC,
            p.xp DESC,
            p.id ASC
        ) AS rank,
        p.id AS user_id,
        p.username,
        p.display_name,
        p.level,
        p.xp,
        CASE p_metric
          WHEN 'xp' THEN m.m_xp
          WHEN 'distance' THEN m.m_dist
          ELSE m.m_cells
        END AS score,
        p.total_distance_m,
        p.total_cells,
        p.avatar_config,
        p.character_id,
        p.modality,
        (p.id = v_uid) AS is_me
      FROM monthly_agg m
      JOIN public.profiles p ON p.id = m.user_id
      WHERE p.is_public = true
        AND (
          CASE p_metric
            WHEN 'xp' THEN m.m_xp
            WHEN 'distance' THEN m.m_dist
            ELSE m.m_cells
          END
        ) > 0
    )
    SELECT
      COALESCE(
        (
          SELECT jsonb_agg(to_jsonb(r) ORDER BY r.rank)
          FROM (SELECT * FROM ranked ORDER BY rank LIMIT v_limit OFFSET v_offset) r
        ),
        '[]'::jsonb
      ),
      (SELECT to_jsonb(r) FROM ranked r WHERE r.user_id = v_uid)
    INTO v_entries, v_my_rank;
  END IF;

  RETURN jsonb_build_object(
    'entries', v_entries,
    'my_rank', v_my_rank
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_global_leaderboard(text, text, int, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_global_leaderboard(text, text, int, int) TO authenticated;

-- ----------------------------------------------------------------------------
-- 5. purchase_store_item(p_item_id, p_quantity)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purchase_store_item(
  p_item_id text,
  p_quantity int DEFAULT 1
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_item public.store_items%ROWTYPE;
  v_wallet integer;
  v_cur_qty integer;
  v_total_price integer;
  v_new_wallet integer;
  v_final_qty integer;
  v_ledger_id uuid := gen_random_uuid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Não autenticado' USING ERRCODE = '42501';
  END IF;

  IF p_quantity IS NULL OR p_quantity < 1 OR p_quantity > 99 THEN
    RAISE EXCEPTION 'Quantidade inválida' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_item
  FROM public.store_items
  WHERE id = p_item_id AND is_active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Item não encontrado ou indisponível' USING ERRCODE = 'P0002';
  END IF;

  IF v_item.kind = 'cosmetic' AND p_quantity <> 1 THEN
    RAISE EXCEPTION 'Cosméticos só podem ser comprados 1 por vez' USING ERRCODE = '22023';
  END IF;

  -- Lock consistente: profiles primeiro, depois user_inventory
  SELECT wallet INTO v_wallet
  FROM public.profiles
  WHERE id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Perfil não encontrado' USING ERRCODE = 'P0002';
  END IF;

  SELECT quantity INTO v_cur_qty
  FROM public.user_inventory
  WHERE user_id = v_uid AND item_id = p_item_id
  FOR UPDATE;

  IF v_item.max_stack IS NOT NULL AND COALESCE(v_cur_qty, 0) + p_quantity > v_item.max_stack THEN
    RAISE EXCEPTION 'Limite máximo de inventário atingido (%)' , v_item.max_stack USING ERRCODE = '22023';
  END IF;

  v_total_price := v_item.price_coins * p_quantity;
  IF v_wallet < v_total_price THEN
    RAISE EXCEPTION 'Saldo insuficiente' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.profiles
  SET wallet = wallet - v_total_price,
      updated_at = now()
  WHERE id = v_uid
  RETURNING wallet INTO v_new_wallet;

  IF v_total_price > 0 THEN
    INSERT INTO public.wallet_ledger (id, user_id, delta, reason, ref_id)
    VALUES (v_ledger_id, v_uid, -v_total_price, 'store_purchase', p_item_id || ':' || v_ledger_id::text);
  END IF;

  INSERT INTO public.user_inventory (user_id, item_id, quantity, first_purchased_at, updated_at)
  VALUES (v_uid, p_item_id, p_quantity, now(), now())
  ON CONFLICT (user_id, item_id) DO UPDATE
    SET quantity = public.user_inventory.quantity + EXCLUDED.quantity,
        updated_at = now()
  RETURNING quantity INTO v_final_qty;

  RETURN jsonb_build_object(
    'item_id', p_item_id,
    'quantity', v_final_qty,
    'total_paid', v_total_price,
    'wallet', v_new_wallet
  );
END;
$$;

REVOKE ALL ON FUNCTION public.purchase_store_item(text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.purchase_store_item(text, int) TO authenticated;

-- ----------------------------------------------------------------------------
-- 6. claim_achievement(p_achievement_key)
-- Valida elegibilidade no servidor contra src/game/achievements.ts e credita
-- moedas de forma idempotente em user_achievements + wallet_ledger + profiles.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_achievement(p_achievement_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_profile public.profiles%ROWTYPE;
  v_existing public.user_achievements%ROWTYPE;
  v_parts text[];
  v_id text;
  v_sub text;
  v_tier_idx int;
  v_target double precision;
  v_coins int;
  v_measure double precision := 0;
  v_city public.user_cities%ROWTYPE;
  v_new_wallet int;
  v_new_count int;
  -- Arrays espelhando src/game/achievements.ts
  v_targets double precision[];
  v_rewards int[];
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Não autenticado' USING ERRCODE = '42501';
  END IF;

  IF p_achievement_key IS NULL OR trim(p_achievement_key) = '' THEN
    RAISE EXCEPTION 'Chave de conquista inválida' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_profile
  FROM public.profiles
  WHERE id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Perfil não encontrado' USING ERRCODE = 'P0002';
  END IF;

  -- Idempotência: se já resgatada, devolve estado atual sem creditar novamente
  SELECT * INTO v_existing
  FROM public.user_achievements
  WHERE user_id = v_uid AND achievement_key = p_achievement_key;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'achievement_key', p_achievement_key,
      'already_claimed', true,
      'coins_awarded', v_existing.coins_awarded,
      'wallet', v_profile.wallet,
      'achievements_count', v_profile.achievements_count
    );
  END IF;

  v_parts := string_to_array(p_achievement_key, ':');
  IF array_length(v_parts, 1) = 2 THEN
    -- Conquistas progressivas e especiais: <id>:<tierIndex>
    v_id := v_parts[1];
    BEGIN
      v_tier_idx := v_parts[2]::int;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Índice de tier inválido' USING ERRCODE = '22023';
    END;

    CASE v_id
      WHEN 'total_distance' THEN
        v_targets := ARRAY[5, 25, 100, 250, 500, 1000, 2500];
        v_rewards := ARRAY[20, 40, 75, 120, 180, 300, 500];
        v_measure := v_profile.total_distance_m / 1000.0;
      WHEN 'total_activities' THEN
        v_targets := ARRAY[1, 5, 15, 30, 50, 100, 250];
        v_rewards := ARRAY[15, 30, 50, 80, 120, 200, 350];
        v_measure := v_profile.total_activities;
      WHEN 'total_moving_time' THEN
        v_targets := ARRAY[1, 5, 15, 50, 100];
        v_rewards := ARRAY[20, 45, 80, 150, 250];
        v_measure := v_profile.total_moving_s / 3600.0;
      WHEN 'total_cells' THEN
        v_targets := ARRAY[500, 2000, 10000, 35000, 100000, 300000];
        v_rewards := ARRAY[20, 40, 80, 150, 300, 500];
        v_measure := v_profile.total_cells;
      WHEN 'cities_count' THEN
        v_targets := ARRAY[1, 2, 5, 10, 20];
        v_rewards := ARRAY[20, 45, 90, 160, 300];
        SELECT COUNT(*)::double precision INTO v_measure
        FROM public.user_cities WHERE user_id = v_uid;
      WHEN 'total_captures' THEN
        v_targets := ARRAY[1, 5, 15, 30, 60, 100, 200];
        v_rewards := ARRAY[20, 35, 60, 100, 160, 240, 400];
        v_measure := v_profile.total_captures;
      WHEN 'poi_categories' THEN
        v_targets := ARRAY[3, 6, 10];
        v_rewards := ARRAY[30, 70, 150];
        SELECT COUNT(DISTINCT category)::double precision INTO v_measure
        FROM public.user_captures WHERE user_id = v_uid;
      WHEN 'rare_captures' THEN
        v_targets := ARRAY[1, 5, 15, 40];
        v_rewards := ARRAY[30, 70, 140, 280];
        SELECT COUNT(*)::double precision INTO v_measure
        FROM public.user_captures
        WHERE user_id = v_uid AND rarity IN ('raro', 'epico', 'lendario');
      WHEN 'street_coins' THEN
        v_targets := ARRAY[10, 50, 150, 500, 1000];
        v_rewards := ARRAY[15, 35, 70, 140, 250];
        v_measure := v_profile.total_coins_count;
      WHEN 'max_streak' THEN
        v_targets := ARRAY[3, 7, 14, 30, 60];
        v_rewards := ARRAY[25, 60, 120, 250, 450];
        WITH days AS (
          SELECT DISTINCT (started_at AT TIME ZONE 'America/Sao_Paulo')::date AS d
          FROM public.activities
          WHERE user_id = v_uid AND verification_status = 'verified'
        ),
        grouped AS (
          SELECT d, (d - (ROW_NUMBER() OVER (ORDER BY d))::int) AS grp
          FROM days
        ),
        streaks AS (
          SELECT COUNT(*) AS len FROM grouped GROUP BY grp
        )
        SELECT COALESCE(MAX(len), 0)::double precision INTO v_measure FROM streaks;
      WHEN 'eddington_km' THEN
        v_targets := ARRAY[5, 10, 20, 35, 50];
        v_rewards := ARRAY[35, 70, 140, 250, 400];
        WITH daily AS (
          SELECT
            (started_at AT TIME ZONE 'America/Sao_Paulo')::date AS d,
            SUM(distance_m) / 1000.0 AS km
          FROM public.activities
          WHERE user_id = v_uid AND verification_status = 'verified'
          GROUP BY 1
        ),
        ordered AS (
          SELECT km, ROW_NUMBER() OVER (ORDER BY km DESC) AS rn
          FROM daily
        )
        SELECT COALESCE(MAX(rn), 0)::double precision INTO v_measure
        FROM ordered
        WHERE km >= rn;
      WHEN 'single_bike_dist' THEN
        v_targets := ARRAY[10, 25, 50, 100, 160];
        v_rewards := ARRAY[25, 50, 90, 180, 320];
        SELECT COALESCE(MAX(distance_m) / 1000.0, 0) INTO v_measure
        FROM public.activities
        WHERE user_id = v_uid AND verification_status = 'verified' AND modality = 'bike';
      WHEN 'single_run_dist' THEN
        v_targets := ARRAY[5, 10, 21.1, 42.2];
        v_rewards := ARRAY[25, 50, 120, 300];
        SELECT COALESCE(MAX(distance_m) / 1000.0, 0) INTO v_measure
        FROM public.activities
        WHERE user_id = v_uid AND verification_status = 'verified' AND modality = 'run';
      WHEN 'early_bird' THEN
        v_targets := ARRAY[1, 5, 15];
        v_rewards := ARRAY[25, 60, 130];
        SELECT COUNT(*)::double precision INTO v_measure
        FROM public.activities
        WHERE user_id = v_uid
          AND verification_status = 'verified'
          AND EXTRACT(HOUR FROM started_at AT TIME ZONE 'America/Sao_Paulo') < 6;
      WHEN 'night_rider' THEN
        v_targets := ARRAY[1, 5, 15];
        v_rewards := ARRAY[25, 60, 130];
        SELECT COUNT(*)::double precision INTO v_measure
        FROM public.activities
        WHERE user_id = v_uid
          AND verification_status = 'verified'
          AND (
            EXTRACT(HOUR FROM started_at AT TIME ZONE 'America/Sao_Paulo') >= 21
            OR EXTRACT(HOUR FROM started_at AT TIME ZONE 'America/Sao_Paulo') < 4
          );
      WHEN 'multi_city_activity' THEN
        v_targets := ARRAY[1, 5, 15];
        v_rewards := ARRAY[40, 100, 220];
        SELECT COUNT(*)::double precision INTO v_measure
        FROM public.activities
        WHERE user_id = v_uid
          AND verification_status = 'verified'
          AND cardinality(city_ids) >= 2;
      WHEN 'dual_sport' THEN
        v_targets := ARRAY[1];
        v_rewards := ARRAY[40];
        SELECT CASE
          WHEN BOOL_OR(modality = 'bike') AND BOOL_OR(modality = 'run') THEN 1
          ELSE 0
        END::double precision INTO v_measure
        FROM public.activities
        WHERE user_id = v_uid AND verification_status = 'verified';
      ELSE
        RAISE EXCEPTION 'Conquista desconhecida: %', v_id USING ERRCODE = 'P0002';
    END CASE;

  ELSIF array_length(v_parts, 1) = 3 THEN
    -- Conquistas recorrentes: city_pct:<cityId>:<tier>, monthly_dist:<YYYY-MM>:<tier>, monthly_days:<YYYY-MM>:<tier>
    v_id := v_parts[1];
    v_sub := v_parts[2];
    BEGIN
      v_tier_idx := v_parts[3]::int;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Índice de tier inválido' USING ERRCODE = '22023';
    END;

    CASE v_id
      WHEN 'city_pct' THEN
        v_targets := ARRAY[0.1, 0.5, 1, 2.5, 5, 10, 25, 50, 100];
        v_rewards := ARRAY[15, 25, 40, 65, 100, 150, 250, 400, 750];
        SELECT * INTO v_city
        FROM public.user_cities
        WHERE user_id = v_uid AND city_id = v_sub;
        IF NOT FOUND OR v_city.area_m2 < 10000 OR v_city.cells <= 0 THEN
          v_measure := 0;
        ELSE
          v_measure := LEAST(100.0, ((v_city.cells * v_city.cell_area_m2) / v_city.area_m2) * 100.0);
        END IF;
      WHEN 'monthly_dist' THEN
        IF v_sub !~ '^\d{4}-\d{2}$' THEN
          RAISE EXCEPTION 'Mês inválido: %', v_sub USING ERRCODE = '22023';
        END IF;
        v_targets := ARRAY[25, 50, 100, 250, 500];
        v_rewards := ARRAY[20, 35, 60, 120, 200];
        SELECT COALESCE(SUM(distance_m) / 1000.0, 0) INTO v_measure
        FROM public.activities
        WHERE user_id = v_uid
          AND verification_status = 'verified'
          AND to_char(started_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') = v_sub;
      WHEN 'monthly_days' THEN
        IF v_sub !~ '^\d{4}-\d{2}$' THEN
          RAISE EXCEPTION 'Mês inválido: %', v_sub USING ERRCODE = '22023';
        END IF;
        v_targets := ARRAY[5, 10, 15, 20];
        v_rewards := ARRAY[20, 40, 70, 120];
        SELECT COUNT(DISTINCT (started_at AT TIME ZONE 'America/Sao_Paulo')::date)::double precision INTO v_measure
        FROM public.activities
        WHERE user_id = v_uid
          AND verification_status = 'verified'
          AND to_char(started_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') = v_sub;
      ELSE
        RAISE EXCEPTION 'Conquista desconhecida: %', v_id USING ERRCODE = 'P0002';
    END CASE;
  ELSE
    RAISE EXCEPTION 'Formato de chave inválido: %', p_achievement_key USING ERRCODE = '22023';
  END IF;

  IF v_tier_idx < 0 OR v_tier_idx >= array_length(v_targets, 1) THEN
    RAISE EXCEPTION 'Tier fora do intervalo: %', v_tier_idx USING ERRCODE = '22023';
  END IF;

  v_target := v_targets[v_tier_idx + 1];
  v_coins := v_rewards[v_tier_idx + 1];

  IF v_measure < v_target THEN
    RAISE EXCEPTION 'Conquista ainda não atingida (% < %)', v_measure, v_target USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.user_achievements (user_id, achievement_key, unlocked_at, coins_awarded)
  VALUES (v_uid, p_achievement_key, now(), v_coins)
  ON CONFLICT (user_id, achievement_key) DO NOTHING;

  INSERT INTO public.wallet_ledger (user_id, delta, reason, ref_id)
  VALUES (v_uid, v_coins, 'achievement', p_achievement_key)
  ON CONFLICT (user_id, reason, ref_id) DO NOTHING;

  SELECT COUNT(*)::int INTO v_new_count
  FROM public.user_achievements
  WHERE user_id = v_uid;

  UPDATE public.profiles
  SET wallet = wallet + v_coins,
      achievements_count = v_new_count,
      updated_at = now()
  WHERE id = v_uid
  RETURNING wallet INTO v_new_wallet;

  RETURN jsonb_build_object(
    'achievement_key', p_achievement_key,
    'already_claimed', false,
    'coins_awarded', v_coins,
    'wallet', v_new_wallet,
    'achievements_count', v_new_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_achievement(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_achievement(text) TO authenticated;

-- ----------------------------------------------------------------------------
-- 7. upsert_fog_state(p_storage_path, p_cell_count, p_expected_revision)
-- Controle otimista de concorrência por revision e atualização autoritativa
-- de profiles.total_cells com a contagem deduplicada do snapshot DSBF.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_fog_state(
  p_storage_path text,
  p_cell_count int,
  p_expected_revision bigint DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_cur public.user_fog_state%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Não autenticado' USING ERRCODE = '42501';
  END IF;

  IF p_cell_count IS NULL OR p_cell_count < 0 THEN
    RAISE EXCEPTION 'cell_count inválido' USING ERRCODE = '22023';
  END IF;

  IF p_storage_path IS NULL OR p_storage_path !~ ('^' || v_uid::text || '/fog\.bin(\.gz)?$') THEN
    RAISE EXCEPTION 'storage_path inválido para o usuário' USING ERRCODE = '42501';
  END IF;

  -- Ordem consistente de lock: profiles primeiro, depois user_fog_state
  PERFORM 1 FROM public.profiles WHERE id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Perfil não encontrado' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_cur
  FROM public.user_fog_state
  WHERE user_id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN
    IF COALESCE(p_expected_revision, 0) <> 0 THEN
      RETURN jsonb_build_object(
        'conflict', true,
        'revision', 0,
        'storage_path', NULL,
        'cell_count', 0
      );
    END IF;

    INSERT INTO public.user_fog_state (user_id, storage_path, cell_count, revision, updated_at)
    VALUES (v_uid, p_storage_path, p_cell_count, 1, now())
    RETURNING * INTO v_cur;

    UPDATE public.profiles
    SET total_cells = p_cell_count,
        updated_at = now()
    WHERE id = v_uid;

    RETURN jsonb_build_object(
      'conflict', false,
      'revision', v_cur.revision,
      'storage_path', v_cur.storage_path,
      'cell_count', v_cur.cell_count
    );
  END IF;

  IF v_cur.revision <> p_expected_revision THEN
    RETURN jsonb_build_object(
      'conflict', true,
      'revision', v_cur.revision,
      'storage_path', v_cur.storage_path,
      'cell_count', v_cur.cell_count
    );
  END IF;

  UPDATE public.user_fog_state
  SET storage_path = p_storage_path,
      cell_count = p_cell_count,
      revision = v_cur.revision + 1,
      updated_at = now()
  WHERE user_id = v_uid
  RETURNING * INTO v_cur;

  UPDATE public.profiles
  SET total_cells = p_cell_count,
      updated_at = now()
  WHERE id = v_uid;

  RETURN jsonb_build_object(
    'conflict', false,
    'revision', v_cur.revision,
    'storage_path', v_cur.storage_path,
    'cell_count', v_cur.cell_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_fog_state(text, int, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_fog_state(text, int, bigint) TO authenticated;

-- ----------------------------------------------------------------------------
-- 8. commit_verified_activity(...)
-- RPC atômico e idempotente (SECURITY INVOKER, exclusivo para service_role)
-- invocado pela Edge Function verify-activity.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.commit_verified_activity(
  p_user_id uuid,
  p_activity_id text,
  p_source text,
  p_modality text,
  p_started_at timestamptz,
  p_ended_at timestamptz,
  p_elapsed_s double precision,
  p_moving_s double precision,
  p_distance_m double precision,
  p_max_speed double precision,
  p_coins_value integer,
  p_coins_count integer,
  p_new_cells integer,
  p_xp_earned integer,
  p_city_ids text[],
  p_captures jsonb,
  p_track_path text,
  p_status text,
  p_reason text DEFAULT NULL,
  p_boost_usage_ids text[] DEFAULT '{}'::text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prof public.profiles%ROWTYPE;
  v_existing public.activities%ROWTYPE;
  v_capture_ids text[] := '{}'::text[];
  v_cap jsonb;
  v_new_captures integer := 0;
  v_row_cnt integer := 0;
  v_boost_id text;
  v_boost public.user_boost_usages%ROWTYPE;
  v_inv_qty integer;
  v_fog_updated_at timestamptz;
  v_cells_delta integer := 0;
  v_xp_credit integer := 0;
  v_coins_credit integer := 0;
  v_coins_count_credit integer := 0;
  v_new_xp integer;
  v_new_level integer;
  v_act public.activities%ROWTYPE;
BEGIN
  IF p_status NOT IN ('verified', 'flagged') THEN
    RAISE EXCEPTION 'Status de verificação inválido: %', p_status USING ERRCODE = '22023';
  END IF;

  IF p_source NOT IN ('live', 'gpx_import') THEN
    RAISE EXCEPTION 'Source inválido: %', p_source USING ERRCODE = '22023';
  END IF;

  -- Lock consistente no perfil para serializar verificações simultâneas
  SELECT * INTO v_prof
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Perfil não encontrado' USING ERRCODE = 'P0002';
  END IF;

  -- Idempotência por (user_id, id)
  SELECT * INTO v_existing
  FROM public.activities
  WHERE user_id = p_user_id AND id = p_activity_id;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'already_exists', true,
      'status', v_existing.verification_status,
      'reason', v_existing.verification_reason,
      'activity', jsonb_build_object(
        'id', v_existing.id,
        'verificationStatus', v_existing.verification_status,
        'distanceM', v_existing.distance_m,
        'movingS', v_existing.moving_s,
        'maxSpeed', v_existing.max_speed,
        'xpEarned', v_existing.xp,
        'coinsEarned', v_existing.coins_value,
        'newCells', v_existing.new_cells
      ),
      'authoritative', jsonb_build_object(
        'xp', v_prof.xp,
        'level', v_prof.level,
        'wallet', v_prof.wallet,
        'totalDistanceM', v_prof.total_distance_m,
        'totalMovingS', v_prof.total_moving_s,
        'totalActivities', v_prof.total_activities,
        'totalCells', v_prof.total_cells,
        'totalCaptures', v_prof.total_captures,
        'achievementsCount', v_prof.achievements_count
      )
    );
  END IF;

  IF p_status = 'verified' AND p_source = 'live' THEN
    v_xp_credit := GREATEST(0, COALESCE(p_xp_earned, 0));
    v_coins_credit := GREATEST(0, COALESCE(p_coins_value, 0));
    v_coins_count_credit := GREATEST(0, COALESCE(p_coins_count, 0));

    IF p_captures IS NOT NULL AND jsonb_typeof(p_captures) = 'array' THEN
      SELECT COALESCE(array_agg(elem->>'poiId'), '{}'::text[])
      INTO v_capture_ids
      FROM jsonb_array_elements(p_captures) AS elem
      WHERE NULLIF(trim(elem->>'poiId'), '') IS NOT NULL;
    END IF;
  END IF;

  INSERT INTO public.activities (
    id, user_id, source, verification_status, verification_reason, modality,
    started_at, ended_at, elapsed_s, moving_s, distance_m, max_speed,
    coins_value, coins_count, new_cells, xp, city_ids, capture_ids,
    track_path, created_at, verified_at
  )
  VALUES (
    p_activity_id, p_user_id, p_source, p_status, p_reason, p_modality,
    p_started_at, p_ended_at,
    GREATEST(0, COALESCE(p_elapsed_s, 0)),
    GREATEST(0, COALESCE(p_moving_s, 0)),
    GREATEST(0, COALESCE(p_distance_m, 0)),
    GREATEST(0, COALESCE(p_max_speed, 0)),
    v_coins_credit,
    v_coins_count_credit,
    CASE WHEN p_status = 'verified' THEN GREATEST(0, COALESCE(p_new_cells, 0)) ELSE 0 END,
    v_xp_credit,
    COALESCE(p_city_ids, '{}'::text[]),
    v_capture_ids,
    p_track_path,
    now(),
    now()
  )
  RETURNING * INTO v_act;

  IF p_status = 'verified' THEN
    IF p_source = 'live' THEN
      -- Consumir boosters validados (decrementa inventário e marca consumed_at)
      IF p_boost_usage_ids IS NOT NULL AND array_length(p_boost_usage_ids, 1) > 0 THEN
        FOREACH v_boost_id IN ARRAY p_boost_usage_ids LOOP
          SELECT * INTO v_boost
          FROM public.user_boost_usages
          WHERE id = v_boost_id
            AND user_id = p_user_id
            AND consumed_at IS NULL
          FOR UPDATE;

          IF FOUND THEN
            SELECT quantity INTO v_inv_qty
            FROM public.user_inventory
            WHERE user_id = p_user_id AND item_id = v_boost.item_id
            FOR UPDATE;

            IF FOUND AND v_inv_qty > 0 THEN
              UPDATE public.user_inventory
              SET quantity = quantity - 1,
                  updated_at = now()
              WHERE user_id = p_user_id AND item_id = v_boost.item_id;

              UPDATE public.user_boost_usages
              SET activity_id = p_activity_id,
                  consumed_at = now()
              WHERE id = v_boost_id;
            END IF;
          END IF;
        END LOOP;
      END IF;

      -- Persistir capturas inéditas
      IF p_captures IS NOT NULL AND jsonb_typeof(p_captures) = 'array' THEN
        FOR v_cap IN SELECT * FROM jsonb_array_elements(p_captures) LOOP
          INSERT INTO public.user_captures (
            user_id, poi_id, name, category, rarity, lng, lat, city_id, activity_id, captured_at
          )
          VALUES (
            p_user_id,
            v_cap->>'poiId',
            v_cap->>'name',
            v_cap->>'category',
            v_cap->>'rarity',
            (v_cap->>'lng')::double precision,
            (v_cap->>'lat')::double precision,
            NULLIF(trim(v_cap->>'cityId'), ''),
            p_activity_id,
            p_ended_at
          )
          ON CONFLICT (user_id, poi_id) DO NOTHING;

          GET DIAGNOSTICS v_row_cnt = ROW_COUNT;
          v_new_captures := v_new_captures + v_row_cnt;
        END LOOP;
      END IF;

      -- Lançar crédito no extrato append-only
      IF v_coins_credit > 0 THEN
        INSERT INTO public.wallet_ledger (user_id, delta, reason, ref_id)
        VALUES (p_user_id, v_coins_credit, 'activity_coins', p_activity_id)
        ON CONFLICT (user_id, reason, ref_id) DO NOTHING;
      END IF;
    END IF;

    -- Só soma total_cells se o snapshot de névoa ainda não foi sincronizado após o início desta atividade
    SELECT updated_at INTO v_fog_updated_at
    FROM public.user_fog_state
    WHERE user_id = p_user_id;

    IF v_fog_updated_at IS NULL OR v_fog_updated_at < p_started_at THEN
      v_cells_delta := GREATEST(0, COALESCE(p_new_cells, 0));
    END IF;

    v_new_xp := v_prof.xp + v_xp_credit;
    v_new_level := private.level_from_xp(v_new_xp);

    UPDATE public.profiles
    SET xp = v_new_xp,
        level = v_new_level,
        wallet = wallet + v_coins_credit,
        total_distance_m = total_distance_m + GREATEST(0, COALESCE(p_distance_m, 0)),
        total_moving_s = total_moving_s + GREATEST(0, COALESCE(p_moving_s, 0)),
        total_activities = total_activities + 1,
        total_coins_value = total_coins_value + v_coins_credit,
        total_coins_count = total_coins_count + v_coins_count_credit,
        total_captures = total_captures + v_new_captures,
        total_cells = total_cells + v_cells_delta,
        updated_at = now()
    WHERE id = p_user_id
    RETURNING * INTO v_prof;
  END IF;

  RETURN jsonb_build_object(
    'already_exists', false,
    'status', v_act.verification_status,
    'reason', v_act.verification_reason,
    'activity', jsonb_build_object(
      'id', v_act.id,
      'verificationStatus', v_act.verification_status,
      'distanceM', v_act.distance_m,
      'movingS', v_act.moving_s,
      'maxSpeed', v_act.max_speed,
      'xpEarned', v_act.xp,
      'coinsEarned', v_act.coins_value,
      'newCells', v_act.new_cells
    ),
    'authoritative', jsonb_build_object(
      'xp', v_prof.xp,
      'level', v_prof.level,
      'wallet', v_prof.wallet,
      'totalDistanceM', v_prof.total_distance_m,
      'totalMovingS', v_prof.total_moving_s,
      'totalActivities', v_prof.total_activities,
      'totalCells', v_prof.total_cells,
      'totalCaptures', v_prof.total_captures,
      'achievementsCount', v_prof.achievements_count
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commit_verified_activity(
  uuid, text, text, text, timestamptz, timestamptz,
  double precision, double precision, double precision, double precision,
  integer, integer, integer, integer, text[], jsonb, text, text, text, text[]
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.commit_verified_activity(
  uuid, text, text, text, timestamptz, timestamptz,
  double precision, double precision, double precision, double precision,
  integer, integer, integer, integer, text[], jsonb, text, text, text, text[]
) TO service_role;
