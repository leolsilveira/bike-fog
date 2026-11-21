-- ============================================================================
-- 0009_reject_nan_and_revoke_table_privs.sql
-- Correções de segurança pós-auditoria (M1 Iteração 4):
--   1. user_cities: adiciona constraint CHECK finita (user_cities_area_finite)
--      rejeitando 'NaN', 'Infinity' e '-Infinity' em area_m2 e cell_area_m2.
--   2. claim_achievement (city_pct): exige uc.area_m2 < 'Infinity'::double precision
--      na consulta e garante v_measure finito >= 0 antes de comparar metas.
--   3. Least privilege: revoga TRUNCATE, REFERENCES, TRIGGER e MAINTAIN de
--      PUBLIC, anon e authenticated em todas as 11 tabelas do schema public,
--      preservando integralmente os privilégios pretendidos de SELECT/INSERT/
--      UPDATE/DELETE e privilégios por coluna.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Constraint finita em public.user_cities (sem remover constraint anterior)
-- ----------------------------------------------------------------------------
ALTER TABLE public.user_cities
  ADD CONSTRAINT user_cities_area_finite CHECK (
    area_m2 >= 0 AND area_m2 < 'Infinity'::double precision
    AND cell_area_m2 >= 0 AND cell_area_m2 < 'Infinity'::double precision
  );

-- ----------------------------------------------------------------------------
-- 2. claim_achievement: guarda explícita contra NaN/Infinity em city_pct
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
  v_canonical_key text;
  v_target double precision;
  v_coins int;
  v_measure double precision := 0;
  v_city public.user_cities%ROWTYPE;
  v_effective_cells int;
  v_city_verified_cells int;
  v_w double precision;
  v_s double precision;
  v_e double precision;
  v_n double precision;
  v_mid_lat double precision;
  v_cell_size_m double precision;
  v_srv_cell_area_m2 double precision;
  v_bbox_area_m2 double precision;
  v_effective_area_m2 double precision;
  v_new_wallet int;
  v_new_count int;
  v_targets double precision[];
  v_rewards int[];
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Não autenticado' USING ERRCODE = '42501';
  END IF;

  IF p_achievement_key IS NULL OR trim(p_achievement_key) = '' THEN
    RAISE EXCEPTION 'Chave de conquista inválida' USING ERRCODE = '22023';
  END IF;

  v_parts := string_to_array(p_achievement_key, ':');
  IF array_length(v_parts, 1) = 2 THEN
    v_id := v_parts[1];
    IF v_parts[2] IS NULL OR v_parts[2] !~ '^(0|[1-9][0-9]*)$' THEN
      RAISE EXCEPTION 'Índice de tier inválido' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_tier_idx := v_parts[2]::int;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Índice de tier inválido' USING ERRCODE = '22023';
    END;
    v_canonical_key := v_id || ':' || v_tier_idx::text;
  ELSIF array_length(v_parts, 1) = 3 THEN
    v_id := v_parts[1];
    v_sub := v_parts[2];
    IF v_sub IS NULL OR v_sub = '' OR v_sub <> trim(v_sub) THEN
      RAISE EXCEPTION 'Subchave de conquista inválida' USING ERRCODE = '22023';
    END IF;
    IF v_parts[3] IS NULL OR v_parts[3] !~ '^(0|[1-9][0-9]*)$' THEN
      RAISE EXCEPTION 'Índice de tier inválido' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_tier_idx := v_parts[3]::int;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Índice de tier inválido' USING ERRCODE = '22023';
    END;
    v_canonical_key := v_id || ':' || v_sub || ':' || v_tier_idx::text;
  ELSE
    RAISE EXCEPTION 'Formato de chave inválido: %', p_achievement_key USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_profile
  FROM public.profiles
  WHERE id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Perfil não encontrado' USING ERRCODE = 'P0002';
  END IF;

  -- Idempotência pela chave canônica
  SELECT * INTO v_existing
  FROM public.user_achievements
  WHERE user_id = v_uid AND achievement_key = v_canonical_key;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'achievement_key', v_canonical_key,
      'already_claimed', true,
      'coins_awarded', v_existing.coins_awarded,
      'wallet', v_profile.wallet,
      'achievements_count', v_profile.achievements_count
    );
  END IF;

  IF array_length(v_parts, 1) = 2 THEN
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
        FROM public.user_cities uc
        WHERE uc.user_id = v_uid
          AND uc.cells > 0
          AND EXISTS (
            SELECT 1
            FROM public.activities a
            WHERE a.user_id = v_uid
              AND a.verification_status = 'verified'
              AND uc.city_id = ANY(a.city_ids)
          );
      WHEN 'total_captures' THEN
        v_targets := ARRAY[1, 5, 15, 30, 60, 100, 200];
        v_rewards := ARRAY[20, 35, 60, 100, 160, 240, 400];
        v_measure := v_profile.total_captures;
      WHEN 'poi_categories' THEN
        v_targets := ARRAY[3, 6, 10];
        v_rewards := ARRAY[30, 70, 150];
        SELECT COUNT(DISTINCT category)::double precision INTO v_measure
        FROM public.user_captures
        WHERE user_id = v_uid AND is_verified = true;
      WHEN 'rare_captures' THEN
        v_targets := ARRAY[1, 5, 15, 40];
        v_rewards := ARRAY[30, 70, 140, 280];
        SELECT COUNT(*)::double precision INTO v_measure
        FROM public.user_captures
        WHERE user_id = v_uid
          AND is_verified = true
          AND rarity IN ('raro', 'epico', 'lendario');
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
  ELSE
    CASE v_id
      WHEN 'city_pct' THEN
        v_targets := ARRAY[0.1, 0.5, 1, 2.5, 5, 10, 25, 50, 100];
        v_rewards := ARRAY[15, 25, 40, 65, 100, 150, 250, 400, 750];
        SELECT * INTO v_city
        FROM public.user_cities uc
        WHERE uc.user_id = v_uid
          AND uc.city_id = v_sub
          AND uc.cells > 0
          AND uc.area_m2 >= 10000
          AND uc.area_m2 < 'Infinity'::double precision
          AND uc.cell_area_m2 BETWEEN 1 AND 400
          AND EXISTS (
            SELECT 1
            FROM public.activities a
            WHERE a.user_id = v_uid
              AND a.verification_status = 'verified'
              AND uc.city_id = ANY(a.city_ids)
          );
        IF NOT FOUND THEN
          v_measure := 0;
        ELSE
          SELECT COALESCE(SUM(a.new_cells), 0)::integer INTO v_city_verified_cells
          FROM public.activities a
          WHERE a.user_id = v_uid
            AND a.verification_status = 'verified'
            AND v_city.city_id = ANY(a.city_ids);

          v_effective_cells := LEAST(v_city.cells, v_profile.total_cells, v_city_verified_cells);

          IF jsonb_typeof(v_city.bbox->0) = 'number'
             AND jsonb_typeof(v_city.bbox->1) = 'number'
             AND jsonb_typeof(v_city.bbox->2) = 'number'
             AND jsonb_typeof(v_city.bbox->3) = 'number' THEN
            v_w := (v_city.bbox->>0)::double precision;
            v_s := (v_city.bbox->>1)::double precision;
            v_e := (v_city.bbox->>2)::double precision;
            v_n := (v_city.bbox->>3)::double precision;
            IF v_w < v_e AND v_s < v_n
               AND v_w >= -180.0 AND v_e <= 180.0
               AND v_s >= -85.05112878 AND v_n <= 85.05112878 THEN
              v_mid_lat := (v_s + v_n) / 2.0;
              v_cell_size_m := (2.0 * pi() * 6378137.0 * cos(radians(v_mid_lat))) / 2097152.0;
              v_srv_cell_area_m2 := LEAST(400.0, GREATEST(1.0, v_cell_size_m * v_cell_size_m));
              v_bbox_area_m2 := GREATEST(
                0.0,
                (radians(v_e - v_w) * 6371008.8 * cos(radians(v_mid_lat))) *
                (radians(v_n - v_s) * 6371008.8)
              );
              v_effective_area_m2 := GREATEST(v_city.area_m2, v_bbox_area_m2 * 0.15, 1000000.0);
              v_measure := LEAST(
                100.0,
                ((v_effective_cells * v_srv_cell_area_m2) / v_effective_area_m2) * 100.0
              );
              IF v_measure IS NULL OR NOT (v_measure >= 0 AND v_measure < 'Infinity'::double precision) THEN
                v_measure := 0;
              END IF;
            ELSE
              v_measure := 0;
            END IF;
          ELSE
            v_measure := 0;
          END IF;
        END IF;
      WHEN 'monthly_dist' THEN
        IF v_sub !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
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
        IF v_sub !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
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
  END IF;

  IF v_measure IS NULL OR NOT (v_measure >= 0 AND v_measure < 'Infinity'::double precision) THEN
    v_measure := 0;
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
  VALUES (v_uid, v_canonical_key, now(), v_coins)
  ON CONFLICT (user_id, achievement_key) DO NOTHING;

  INSERT INTO public.wallet_ledger (user_id, delta, reason, ref_id)
  VALUES (v_uid, v_coins, 'achievement', v_canonical_key)
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
    'achievement_key', v_canonical_key,
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
-- 3. Revogação de privilégios residuais em todas as 11 tabelas public
-- ----------------------------------------------------------------------------
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON
  public.profiles,
  public.activities,
  public.user_cities,
  public.user_captures,
  public.user_achievements,
  public.user_fog_state,
  public.friendships,
  public.store_items,
  public.user_inventory,
  public.user_boost_usages,
  public.wallet_ledger
FROM PUBLIC, anon, authenticated;
