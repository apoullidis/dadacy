-- apps/worker/tools/pgboss-catalogue.sql — the SHAPE of schema pgboss, one sorted line per fact,
-- for refusals.sh's before/after comparison (T-148 refusal (i): no run-time self-migration).
-- Covers: the schema's owner and ACL; every relation (kind, persistence, owner, ACL, partition
-- bound); every column (type, not-null, default); every index and constraint definition; every
-- function (signature, body digest, SECURITY DEFINER, owner, ACL); every type and enum label;
-- every trigger; and pgboss.version.version. NOT covered: row data other than the version number
-- (jobs, queues and the timekeeper's cron_on/maintained_on stamps change in normal operation).
SELECT line FROM (
  SELECT format('schema %s owner=%s acl=%s', n.nspname, pg_get_userbyid(n.nspowner), n.nspacl) AS line
    FROM pg_namespace n WHERE n.nspname = 'pgboss'
  UNION ALL
  SELECT format('rel %s kind=%s persistence=%s owner=%s acl=%s bound=%s', c.relname, c.relkind,
                c.relpersistence, pg_get_userbyid(c.relowner), c.relacl,
                pg_get_expr(c.relpartbound, c.oid))
    FROM pg_class c WHERE c.relnamespace = 'pgboss'::regnamespace
  UNION ALL
  SELECT format('col %s.%s %s notnull=%s default=%s', c.relname, a.attname,
                format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid))
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE c.relnamespace = 'pgboss'::regnamespace AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT format('idx %s', pg_get_indexdef(i.indexrelid))
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relnamespace = 'pgboss'::regnamespace
  UNION ALL
  SELECT format('con %s.%s %s', c.relname, k.conname, pg_get_constraintdef(k.oid))
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
   WHERE k.connamespace = 'pgboss'::regnamespace
  UNION ALL
  SELECT format('fn %s md5=%s secdef=%s owner=%s acl=%s', p.oid::regprocedure, md5(p.prosrc),
                p.prosecdef, pg_get_userbyid(p.proowner), p.proacl)
    FROM pg_proc p WHERE p.pronamespace = 'pgboss'::regnamespace
  UNION ALL
  SELECT format('type %s %s', t.typname, t.typtype)
    FROM pg_type t WHERE t.typnamespace = 'pgboss'::regnamespace
  UNION ALL
  SELECT format('enum %s %s %s', t.typname, e.enumsortorder, e.enumlabel)
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
   WHERE t.typnamespace = 'pgboss'::regnamespace
  UNION ALL
  SELECT format('trg %s.%s %s', c.relname, g.tgname, pg_get_triggerdef(g.oid))
    FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
   WHERE c.relnamespace = 'pgboss'::regnamespace AND NOT g.tgisinternal
  UNION ALL
  SELECT format('version %s', v.version) FROM pgboss.version v
) facts ORDER BY line COLLATE "C";
