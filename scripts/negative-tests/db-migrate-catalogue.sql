-- T-136 — the catalogue reading taken after each db:migrate step in the evidence.
-- Each row names objects that 0001 or 0002 creates, so a step's effect is read from the
-- catalogue, not inferred from the runner's exit status.
--
--   ./scripts/svc run <ticket> -- psql -X -f scripts/negative-tests/db-migrate-catalogue.sql
SELECT 'roles (0001)' AS reading,
       coalesce(string_agg(rolname, ',' ORDER BY rolname), '<none>') AS value
  FROM pg_roles
 WHERE rolname IN ('app_rw', 'app_admin_rw', 'app_safety_rw', 'app_ddl', 'answering_service')
UNION ALL
SELECT 'extensions other than plpgsql (0001)',
       coalesce(string_agg(extname, ',' ORDER BY extname), '<none>')
  FROM pg_extension
 WHERE extname <> 'plpgsql'
UNION ALL
SELECT 'event triggers (0001)',
       coalesce(string_agg(evtname || ':' || evtenabled::text, ',' ORDER BY evtname), '<none>')
  FROM pg_event_trigger
UNION ALL
SELECT 'guard functions; check17 = body reads k_stat_extensions (0002)',
       coalesce(string_agg(p.proname || ' check17=' || (p.prosrc LIKE '%k_stat_extensions%')::text,
                           ',' ORDER BY p.proname), '<none>')
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('assert_answering_service_write_only', 'trg_assert_answering_service_write_only')
UNION ALL
SELECT 'owner of schema public (0001)', pg_get_userbyid(nspowner)::text
  FROM pg_namespace
 WHERE nspname = 'public'
UNION ALL
SELECT 'db:migrate record (database comment)',
       coalesce(shobj_description(oid, 'pg_database'), '<none>')
  FROM pg_database
 WHERE datname = current_database();
