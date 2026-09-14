-- @phase: expand
-- T-152 rework 1 (OD-109, QA-F1): qa-verification's two-policy table, verbatim from its attack set 3
-- (state/EP-2/T-152.md § QA verification, set3.up.sql), without that set's two materialized views.
-- scripts/negative-tests/db-introspect.sh plants this whole file as a migration's up file. Its
-- `-- down:` line is that migration's down file. Its `-- expect:` lines are the pgPolicy entries
-- db/schema.ts must then contain. They are derived from the SQL below, PostgreSQL 18's deparse of it
-- (pg_get_expr, as QA's pg_policy query printed it) and drizzle-kit 0.31.10's pgPolicy template
-- (bin.cjs 85875-85890), not copied from a rendering.
CREATE TABLE public.qa_secure (id bigint PRIMARY KEY, owner_id text NOT NULL);
ALTER TABLE public.qa_secure ENABLE ROW LEVEL SECURITY;
CREATE POLICY qa_secure_zulu ON public.qa_secure FOR SELECT TO app_rw USING (owner_id = current_user);
CREATE POLICY qa_secure_alpha ON public.qa_secure FOR INSERT TO app_rw WITH CHECK (owner_id = current_user);
-- expect: pgPolicy("qa_secure_alpha", { as: "permissive", for: "insert", to: ["app_rw"], withCheck: sql`(owner_id = CURRENT_USER)`  })
-- expect: pgPolicy("qa_secure_zulu", { as: "permissive", for: "select", to: ["app_rw"], using: sql`(owner_id = CURRENT_USER)` })
-- down: DROP TABLE public.qa_secure;
