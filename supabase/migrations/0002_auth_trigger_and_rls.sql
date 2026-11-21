-- ============================================================================
-- 0002_auth_trigger_and_rls.sql
-- Trigger de criação de perfil em auth.users, proteção de colunas,
-- máquina de estados de friendships e RLS estrita em todas as 11 tabelas.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Trigger de cadastro automático em auth.users -> public.profiles
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_raw_name text;
  v_display_name text;
  v_modality text;
  v_character_id text;
  v_base text;
  v_candidate text;
  v_suffix text;
  v_attempt int := 0;
BEGIN
  v_raw_name := COALESCE(
    NULLIF(trim(NEW.raw_user_meta_data->>'display_name'), ''),
    NULLIF(trim(NEW.raw_user_meta_data->>'full_name'), ''),
    NULLIF(trim(NEW.raw_user_meta_data->>'name'), ''),
    'Viajante'
  );
  v_display_name := left(v_raw_name, 32);

  v_modality := CASE
    WHEN NEW.raw_user_meta_data->>'modality' IN ('bike', 'run')
      THEN NEW.raw_user_meta_data->>'modality'
    ELSE 'bike'
  END;

  v_character_id := COALESCE(
    NULLIF(left(trim(NEW.raw_user_meta_data->>'character_id'), 40), ''),
    'lia'
  );

  -- Normaliza base de username a partir de metadata ou display_name
  v_base := lower(COALESCE(NULLIF(trim(NEW.raw_user_meta_data->>'username'), ''), v_display_name));
  v_base := regexp_replace(v_base, '[^a-z0-9_]+', '_', 'g');
  v_base := regexp_replace(v_base, '^_+|_+$', '', 'g');
  v_base := left(v_base, 16);
  IF char_length(v_base) < 3 THEN
    v_base := 'viajante';
  END IF;

  v_suffix := substr(replace(NEW.id::text, '-', ''), 1, 6);
  v_candidate := left(v_base, 17) || '_' || v_suffix;

  WHILE EXISTS (SELECT 1 FROM public.profiles WHERE username = v_candidate) AND v_attempt < 5 LOOP
    v_attempt := v_attempt + 1;
    v_candidate := 'desbrava_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
  END LOOP;

  INSERT INTO public.profiles (id, username, display_name, modality, character_id)
  VALUES (NEW.id, v_candidate, v_display_name, v_modality, v_character_id)
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.handle_new_user() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION private.handle_new_user();

-- ----------------------------------------------------------------------------
-- 2. Trigger de proteção das colunas gerenciadas pelo servidor em profiles
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.protect_profile_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.username IS NOT NULL THEN
    NEW.username := lower(trim(NEW.username));
  END IF;

  -- Apenas chamadas diretas de clientes (anon/authenticated) são bloqueadas.
  -- service_role e funções SECURITY DEFINER (postgres) podem atualizar estatísticas.
  IF current_user IN ('anon', 'authenticated') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.xp := 0;
      NEW.level := 1;
      NEW.wallet := 0;
      NEW.total_distance_m := 0;
      NEW.total_moving_s := 0;
      NEW.total_activities := 0;
      NEW.total_coins_value := 0;
      NEW.total_coins_count := 0;
      NEW.total_captures := 0;
      NEW.total_cells := 0;
      NEW.achievements_count := 0;
    ELSIF TG_OP = 'UPDATE' THEN
      IF NEW.xp IS DISTINCT FROM OLD.xp
         OR NEW.level IS DISTINCT FROM OLD.level
         OR NEW.wallet IS DISTINCT FROM OLD.wallet
         OR NEW.total_distance_m IS DISTINCT FROM OLD.total_distance_m
         OR NEW.total_moving_s IS DISTINCT FROM OLD.total_moving_s
         OR NEW.total_activities IS DISTINCT FROM OLD.total_activities
         OR NEW.total_coins_value IS DISTINCT FROM OLD.total_coins_value
         OR NEW.total_coins_count IS DISTINCT FROM OLD.total_coins_count
         OR NEW.total_captures IS DISTINCT FROM OLD.total_captures
         OR NEW.total_cells IS DISTINCT FROM OLD.total_cells
         OR NEW.achievements_count IS DISTINCT FROM OLD.achievements_count
      THEN
        RAISE EXCEPTION 'Colunas de progressão e carteira só podem ser alteradas pelo servidor'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.protect_profile_columns() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_profiles_protect_columns
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION private.protect_profile_columns();

-- ----------------------------------------------------------------------------
-- 3. Trigger de transições válidas em friendships (anti-bypass de bloqueio)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.protect_friendships_transitions()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Não autenticado' USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.requester_id <> v_uid THEN
      RAISE EXCEPTION 'Somente o remetente pode iniciar a relação' USING ERRCODE = '42501';
    END IF;
    IF NEW.status = 'accepted' THEN
      RAISE EXCEPTION 'Amizade não pode ser criada diretamente como aceita' USING ERRCODE = '42501';
    END IF;
    IF NEW.status = 'blocked' THEN
      NEW.blocked_by := v_uid;
    ELSE
      NEW.blocked_by := NULL;
    END IF;
    RETURN NEW;
  END IF;

  -- TG_OP = 'UPDATE'
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.requester_id IS DISTINCT FROM OLD.requester_id
     OR NEW.addressee_id IS DISTINCT FROM OLD.addressee_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Identificadores da amizade são imutáveis' USING ERRCODE = '42501';
  END IF;

  IF OLD.status = 'blocked' THEN
    IF OLD.blocked_by IS DISTINCT FROM v_uid THEN
      RAISE EXCEPTION 'Somente quem bloqueou pode alterar o bloqueio' USING ERRCODE = '42501';
    END IF;
    IF NEW.status <> 'blocked' THEN
      RAISE EXCEPTION 'Remova o bloqueio antes de enviar novo convite' USING ERRCODE = '22023';
    END IF;
    NEW.blocked_by := OLD.blocked_by;
    RETURN NEW;
  END IF;

  IF NEW.status = 'blocked' THEN
    IF v_uid NOT IN (OLD.requester_id, OLD.addressee_id) THEN
      RAISE EXCEPTION 'Sem permissão para bloquear' USING ERRCODE = '42501';
    END IF;
    NEW.blocked_by := v_uid;
    RETURN NEW;
  END IF;

  IF OLD.status = 'pending' AND NEW.status = 'accepted' THEN
    IF v_uid <> OLD.addressee_id THEN
      RAISE EXCEPTION 'Somente o destinatário pode aceitar o convite' USING ERRCODE = '42501';
    END IF;
    NEW.blocked_by := NULL;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Transição de status inválida (% -> %)', OLD.status, NEW.status USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.protect_friendships_transitions() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_friendships_protect_transitions
  BEFORE INSERT OR UPDATE ON public.friendships
  FOR EACH ROW EXECUTE FUNCTION private.protect_friendships_transitions();

-- ----------------------------------------------------------------------------
-- 4. Habilitar RLS em todas as 11 tabelas
-- ----------------------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_cities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_captures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_achievements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_fog_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_boost_usages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_ledger ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 5. Privilégios mínimos (Least Privilege) + Políticas RLS
-- ----------------------------------------------------------------------------

-- [profiles] Dono lê e edita apenas colunas seguras; leituras entre jogadores usam RPCs
REVOKE ALL ON public.profiles FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON public.profiles FROM authenticated;
GRANT SELECT ON public.profiles TO authenticated;
GRANT INSERT (id, username, display_name, modality, character_id, avatar_config, is_public, settings)
  ON public.profiles TO authenticated;
GRANT UPDATE (username, display_name, modality, character_id, avatar_config, is_public, settings, updated_at)
  ON public.profiles TO authenticated;

CREATE POLICY profiles_select_own ON public.profiles
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = id);

CREATE POLICY profiles_insert_own ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = id);

CREATE POLICY profiles_update_own ON public.profiles
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = id)
  WITH CHECK ((select auth.uid()) = id);

-- [activities] Somente leitura do dono; escrita exclusiva via Edge Function (service_role)
REVOKE ALL ON public.activities FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON public.activities FROM authenticated;
GRANT SELECT ON public.activities TO authenticated;

CREATE POLICY activities_select_own ON public.activities
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

-- [user_cities] Dono lê, insere e atualiza suas cidades
REVOKE ALL ON public.user_cities FROM PUBLIC, anon;
REVOKE DELETE ON public.user_cities FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON public.user_cities TO authenticated;

CREATE POLICY user_cities_select_own ON public.user_cities
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY user_cities_insert_own ON public.user_cities
  FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY user_cities_update_own ON public.user_cities
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

-- [user_captures] Dono lê, insere e atualiza (para upsert idempotente) suas capturas
REVOKE ALL ON public.user_captures FROM PUBLIC, anon;
REVOKE DELETE ON public.user_captures FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON public.user_captures TO authenticated;

CREATE POLICY user_captures_select_own ON public.user_captures
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY user_captures_insert_own ON public.user_captures
  FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY user_captures_update_own ON public.user_captures
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

-- [user_achievements] Somente leitura do dono; desbloqueio via claim_achievement RPC
REVOKE ALL ON public.user_achievements FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON public.user_achievements FROM authenticated;
GRANT SELECT ON public.user_achievements TO authenticated;

CREATE POLICY user_achievements_select_own ON public.user_achievements
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

-- [user_fog_state] Somente leitura do dono; atualização otimista via upsert_fog_state RPC
REVOKE ALL ON public.user_fog_state FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON public.user_fog_state FROM authenticated;
GRANT SELECT ON public.user_fog_state TO authenticated;

CREATE POLICY user_fog_state_select_own ON public.user_fog_state
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

-- [friendships] Partes leem/criam/atualizam/removem respeitando trigger de transição
REVOKE ALL ON public.friendships FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.friendships TO authenticated;

CREATE POLICY friendships_select_party ON public.friendships
  FOR SELECT TO authenticated
  USING ((select auth.uid()) IN (requester_id, addressee_id));

CREATE POLICY friendships_insert_requester ON public.friendships
  FOR INSERT TO authenticated
  WITH CHECK (
    (select auth.uid()) = requester_id
    AND status IN ('pending', 'blocked')
  );

CREATE POLICY friendships_update_party ON public.friendships
  FOR UPDATE TO authenticated
  USING (
    (select auth.uid()) IN (requester_id, addressee_id)
    AND (status <> 'blocked' OR blocked_by = (select auth.uid()))
  )
  WITH CHECK ((select auth.uid()) IN (requester_id, addressee_id));

CREATE POLICY friendships_delete_party ON public.friendships
  FOR DELETE TO authenticated
  USING (
    (select auth.uid()) IN (requester_id, addressee_id)
    AND (status <> 'blocked' OR blocked_by = (select auth.uid()))
  );

-- [store_items] Catálogo público apenas leitura
REVOKE ALL ON public.store_items FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.store_items FROM anon, authenticated;
GRANT SELECT ON public.store_items TO anon, authenticated;

CREATE POLICY store_items_select_all ON public.store_items
  FOR SELECT TO anon, authenticated
  USING (true);

-- [user_inventory] Somente leitura do dono; escrita via purchase_store_item / commit_verified_activity
REVOKE ALL ON public.user_inventory FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON public.user_inventory FROM authenticated;
GRANT SELECT ON public.user_inventory TO authenticated;

CREATE POLICY user_inventory_select_own ON public.user_inventory
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

-- [user_boost_usages] Dono lê e registra ativação (consumed_at sempre NULL pelo cliente)
REVOKE ALL ON public.user_boost_usages FROM PUBLIC, anon;
REVOKE UPDATE, DELETE ON public.user_boost_usages FROM authenticated;
GRANT SELECT, INSERT ON public.user_boost_usages TO authenticated;

CREATE POLICY user_boost_usages_select_own ON public.user_boost_usages
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY user_boost_usages_insert_own ON public.user_boost_usages
  FOR INSERT TO authenticated
  WITH CHECK (
    (select auth.uid()) = user_id
    AND consumed_at IS NULL
  );

-- [wallet_ledger] Extrato append-only; leitura do dono, escrita exclusiva do servidor
REVOKE ALL ON public.wallet_ledger FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON public.wallet_ledger FROM authenticated;
GRANT SELECT ON public.wallet_ledger TO authenticated;

CREATE POLICY wallet_ledger_select_own ON public.wallet_ledger
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);
