-- @phase: expand
-- T-165 (OD-84): the partitioned-table fixture db-introspect.sh plants for K50–K55.
--
-- A PARTITION BY RANGE parent with two partitions, a partitioned index, a CHECK, a bigserial
-- column (so the parent owns a sequence), a bigint column (OD-107) and two row-level security
-- policies — the shape SD's `audit_log` (PARTITION BY RANGE (occurred_at), monthly) will have.
--
-- Every `-- expect:` line below must appear in db/schema.ts verbatim (grep -F) and every
-- `-- absent:` line must appear nowhere in it. They are written from THIS SQL, from PostgreSQL's
-- own deparse of the two policy expressions and from drizzle-kit 0.31.10's template — never copied
-- out of a rendering. The `-- down:` lines are the down file.
CREATE TABLE public.t165_part (
  seq bigserial,
  at timestamptz NOT NULL,
  amount bigint NOT NULL,
  note text,
  CONSTRAINT t165_part_pkey PRIMARY KEY (seq, at),
  CONSTRAINT t165_part_nonneg_ck CHECK (amount >= 0)
) PARTITION BY RANGE (at);
CREATE TABLE public.t165_part_q1 PARTITION OF public.t165_part
  FOR VALUES FROM (TIMESTAMPTZ '2026-01-01Z') TO (TIMESTAMPTZ '2026-04-01Z');
CREATE TABLE public.t165_part_q2 PARTITION OF public.t165_part
  FOR VALUES FROM (TIMESTAMPTZ '2026-04-01Z') TO (TIMESTAMPTZ '2026-07-01Z');
CREATE INDEX t165_part_when_idx ON public.t165_part (at);
GRANT SELECT, INSERT ON public.t165_part TO app_rw;
ALTER TABLE public.t165_part ENABLE ROW LEVEL SECURITY;
CREATE POLICY t165_part_zulu ON public.t165_part FOR SELECT TO app_rw USING (amount > 0);
CREATE POLICY t165_part_omega ON public.t165_part FOR INSERT TO app_rw WITH CHECK (amount > 1);
--
-- The parent is rendered under its own name, with the PARENT's constraint and index names:
-- expect: export const t165Part = pgTable("t165_part", {
-- expect: name: "t165_part_pkey"
-- expect: index("t165_part_when_idx")
-- expect: check("t165_part_nonneg_ck", sql`amount >= 0`)
-- expect: pgSequence("t165_part_seq_seq"
-- The parent's policies, which no partition carries, as pg_policy has them:
-- expect: pgPolicy("t165_part_zulu", { as: "permissive", for: "select", to: ["app_rw"], using: sql`(amount > 0)` })
-- expect: pgPolicy("t165_part_omega", { as: "permissive", for: "insert", to: ["app_rw"], withCheck: sql`(amount > 1)`  })
-- No partition, and no partition's own constraint or index, is in the file:
-- absent: t165_part_q1
-- absent: t165_part_q2
-- absent: t165PartQ1
-- absent: t165PartQ2
-- down: DROP TABLE public.t165_part;
