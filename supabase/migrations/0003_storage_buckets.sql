-- ============================================================================
-- 0003_storage_buckets.sql
-- Buckets privados fog-snapshots e activity-tracks + RLS em storage.objects.
-- ============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  (
    'fog-snapshots',
    'fog-snapshots',
    false,
    10485760, -- 10 MiB
    ARRAY['application/octet-stream', 'application/gzip', 'application/x-gzip']
  ),
  (
    'activity-tracks',
    'activity-tracks',
    false,
    5242880, -- 5 MiB
    ARRAY['application/octet-stream', 'application/gzip', 'application/x-gzip']
  )
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Upsert no Storage exige SELECT + INSERT + UPDATE; DELETE permite limpeza pelo dono.
CREATE POLICY storage_desbrava_select_own ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id IN ('fog-snapshots', 'activity-tracks')
    AND (storage.foldername(name))[1] = (select auth.uid()::text)
  );

CREATE POLICY storage_desbrava_insert_own ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id IN ('fog-snapshots', 'activity-tracks')
    AND (storage.foldername(name))[1] = (select auth.uid()::text)
  );

CREATE POLICY storage_desbrava_update_own ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id IN ('fog-snapshots', 'activity-tracks')
    AND (storage.foldername(name))[1] = (select auth.uid()::text)
  )
  WITH CHECK (
    bucket_id IN ('fog-snapshots', 'activity-tracks')
    AND (storage.foldername(name))[1] = (select auth.uid()::text)
  );

CREATE POLICY storage_desbrava_delete_own ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id IN ('fog-snapshots', 'activity-tracks')
    AND (storage.foldername(name))[1] = (select auth.uid()::text)
  );
