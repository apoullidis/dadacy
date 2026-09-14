-- @phase: expand
-- T-152 rework 1 (OD-109): the policy attributes the policy step checks against pg_policy, each in a
-- non-default form. t152_ledger has three policies: RESTRICTIVE, FOR UPDATE with both USING and
-- WITH CHECK, two roles given out of name order; FOR ALL TO PUBLIC; FOR DELETE. t152_single has one
-- policy with both expressions, which drizzle-kit renders whole (the first row of its table).
-- Planted by scripts/negative-tests/db-introspect.sh exactly as db-introspect-policies-qa.sql is:
-- the file is the up file, `-- down:` lines are the down file, `-- expect:` lines must be in
-- db/schema.ts. They are derived from the SQL, PostgreSQL 18's deparse and drizzle-kit 0.31.10's
-- pgPolicy template (roles ordered by name, as the pg_policies view orders them).
CREATE TABLE public.t152_ledger (id integer PRIMARY KEY, owner_id text NOT NULL, amount integer NOT NULL);
ALTER TABLE public.t152_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY t152_ledger_update ON public.t152_ledger AS RESTRICTIVE FOR UPDATE TO app_rw, app_admin_rw USING (owner_id = current_user) WITH CHECK (amount >= 0);
CREATE POLICY t152_ledger_all ON public.t152_ledger FOR ALL TO PUBLIC USING (true);
CREATE POLICY t152_ledger_delete ON public.t152_ledger AS PERMISSIVE FOR DELETE TO app_admin_rw USING (owner_id <> 'system');
CREATE TABLE public.t152_single (id integer PRIMARY KEY, owner_id text NOT NULL);
ALTER TABLE public.t152_single ENABLE ROW LEVEL SECURITY;
CREATE POLICY t152_single_both ON public.t152_single FOR UPDATE TO app_rw USING (owner_id = current_user) WITH CHECK (owner_id = current_user);
-- expect: pgPolicy("t152_ledger_all", { as: "permissive", for: "all", to: ["public"], using: sql`true` })
-- expect: pgPolicy("t152_ledger_delete", { as: "permissive", for: "delete", to: ["app_admin_rw"], using: sql`(owner_id <> 'system'::text)` })
-- expect: pgPolicy("t152_ledger_update", { as: "restrictive", for: "update", to: ["app_admin_rw", "app_rw"], using: sql`(owner_id = CURRENT_USER)`, withCheck: sql`(amount >= 0)`  })
-- expect: pgPolicy("t152_single_both", { as: "permissive", for: "update", to: ["app_rw"], using: sql`(owner_id = CURRENT_USER)`, withCheck: sql`(owner_id = CURRENT_USER)`  })
-- down: DROP TABLE public.t152_single;
-- down: DROP TABLE public.t152_ledger;
