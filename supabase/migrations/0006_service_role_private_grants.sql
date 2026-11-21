-- ============================================================================
-- 0006_service_role_private_grants.sql
-- Permite que commit_verified_activity (SECURITY INVOKER via service_role)
-- chame private.level_from_xp(integer), mantendo anon/authenticated bloqueados.
-- ============================================================================

GRANT USAGE ON SCHEMA private TO service_role;
GRANT EXECUTE ON FUNCTION private.level_from_xp(integer) TO service_role;
