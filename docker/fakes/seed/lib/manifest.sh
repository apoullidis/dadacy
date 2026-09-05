# shellcheck shell=bash
#
# THE LOCALSTACK SEED MANIFEST — the single source of truth for what the `aws`
# profile contains. Ticket: T-017 (platform-infrastructure). DOCKER.md §7.
#
# Sourced by BOTH `ready.d/10-seed.sh` (which creates these) and
# `lib/verify.sh` (which asserts they exist). One file, so the seed and the
# check can never disagree — a verifier with its own copy of the list is a
# verifier that passes after somebody edits only the seed.
#
# NOTHING HERE IS A CREDENTIAL AND NOTHING HERE EVER WILL BE. Every secret
# value below is the literal string `local-fake-not-a-credential:<name>`.
# LocalStack sits on `kinvara-int`, `internal: true`; a packet cannot leave
# this host. A ticket that appears to need a live key is BLOCKED and escalated,
# never improvised (PROTOCOL.md §9.9).

# ---------------------------------------------------------------------------
# S3 — SA §DA-12, verbatim. Five buckets, and the fifth (`kinvara-static`) is
# the one with no CMK: build assets are S3-managed encryption.
# ---------------------------------------------------------------------------
KINVARA_BUCKETS=(
    "kinvara-idv-ephemeral"   # IDV document images/biometric artefacts. Hard delete at 30d (§L2). Versioning OFF — versions would defeat deletion.
    "kinvara-evidence"        # Case evidence, DSAR exports, audit anchors. 7 years, Object Lock compliance mode. The only bucket replicated to eu-west-1.
    "kinvara-user-media"      # Verified profile photos, PFA certificate scans. Versioning ON.
    "kinvara-analytics"       # Parquet exports, aged audit partitions. 7 years, Glacier IR after 90d.
    "kinvara-static"          # Build assets. S3-managed encryption; no CMK.
)

# Buckets whose real counterpart has versioning ON (SA §DA-12). LocalStack does
# implement versioning, so it is applied — and the two OMISSIONS are as
# important as the inclusions: `kinvara-idv-ephemeral` must NOT be versioned
# (a version would survive the 30-day hard delete, defeating §L2) and
# `kinvara-static` has no requirement either way.
KINVARA_VERSIONED_BUCKETS=(
    "kinvara-evidence"
    "kinvara-user-media"
    "kinvara-analytics"
)

# ---------------------------------------------------------------------------
# KMS — one CMK per data class the specs name.
#
# THE COUNT IS SEVEN, NOT SIX, AND THAT IS DELIBERATE — see OD-11.
# SA §SEC-2 enumerates five envelope CMKs ('child_health', 'messages', 'idv',
# 'credential', 'evidence'); SA §DA-12 names two more as bucket keys (`media`,
# `analytics`) which SEC-2's list does not contain. DOCKER.md §7 and the SA
# cost model both say "six", but no six-element set is derivable from either
# section — the two lists overlap on `idv` and `evidence` and union to seven.
# The seed creates every purpose the specs NAME rather than guessing which one
# to drop; T-004 owns the definitive set and can delete a line here.
#
# Format: alias|description
# ---------------------------------------------------------------------------
KINVARA_CMKS=(
    "child_health|SA SEC-2 envelope CMK. One DEK per HOUSEHOLD. Crypto-shred target for DG-4 erasure. The >200 decrypts/5min alarm (SEC-2 property 3) is on this key."
    "messages|SA SEC-2 envelope CMK. One DEK per THREAD (message bodies)."
    "idv|SA SEC-2 envelope CMK + SA DA-12 bucket key for kinvara-idv-ephemeral. One DEK per SITTER."
    "credential|SA SEC-2 envelope CMK. The credential task role can decrypt this and nothing else (SEC-2 property 4)."
    "evidence|SA SEC-2 envelope CMK + SA DA-12 bucket key for kinvara-evidence."
    "media|SA DA-12 bucket key for kinvara-user-media. Named in DA-12 but not in SEC-2's five."
    "analytics|SA DA-12 bucket key for kinvara-analytics. Named in DA-12 but not in SEC-2's five."
)

# ---------------------------------------------------------------------------
# Secrets Manager — SA §SEC-10, §INT-5.5, §INT-8, §INT-10.
#
# §SEC-10 is "Secrets management" and it is the section every rotation claim
# below comes from. It is NOT §SEC-11, which is "Fraud prevention" — an earlier
# revision of this file cited SEC-11 five times and `qa-verification` caught it
# (QA-F3). The same mis-citation is still live in db/migrations/0001 and in
# T-020's published contract; recorded as OD-13, not fixed here, because
# db/migrations is tech-lead's outright.
#
# Format: name|description
#
# Database credentials: one per LOGIN PRINCIPAL, matching the five group roles
# T-020's 0001 creates. The roles themselves are NOLOGIN and have no password
# — "a password in a migration is a password in git" — so the login principals
# are created outside the migration and their credentials live here, rotating
# every 30 days (SA §SEC-10).
# ---------------------------------------------------------------------------
KINVARA_SECRETS=(
    "kinvara/db/app_rw|Login principal granted app_rw. Rotates 30d (SEC-10)."
    "kinvara/db/app_admin_rw|Login principal granted app_admin_rw. Rotates 30d."
    "kinvara/db/app_safety_rw|Login principal granted app_safety_rw. Rotates 30d."
    "kinvara/db/app_ddl|Migration principal. BREAK-GLASS CHECKOUT ONLY (SD DB-13 rule 6, SA I-6). No application connects as it."
    "kinvara/db/answering_service|The SA INT-10 vendor principal: INSERT on out_of_hours_report, SELECT on nothing. Rotated on any change of VENDOR PERSONNEL as well, because it is held outside our staff boundary (SEC-10)."
    "kinvara/provider/stripe|Stripe API key. Quarterly rotation and on any staff departure with access."
    "kinvara/provider/stripe/webhook|Stripe webhook signing secret. Verified BEFORE any parsing (SEC-10)."
    "kinvara/provider/telephony|Twilio — primary SMS + voice (INT-5.5)."
    "kinvara/provider/telephony/webhook|Telephony webhook signing secret."
    "kinvara/provider/telephony-secondary|The second SMS provider behind the same NotificationChannel adapter, activated by the router on primary error-rate breach (INT-5.5)."
    "kinvara/provider/idv|IDV vendor API key."
    "kinvara/provider/idv/webhook|IDV webhook signing secret."
    "kinvara/provider/address|Address/postcode provider API key."
    "kinvara/provider/answering-service|The out-of-hours answering service's own API credential (distinct from its DB principal above)."
    "kinvara/provider/pagerduty/eng|eng-oncall routing key. SEPARATE service and rota from T&S (INT-8) — an infrastructure incident and a safeguarding incident must not share a queue."
    "kinvara/provider/pagerduty/ts|ts-oncall routing key. The safeguarding paging path."
    "kinvara/provider/sentry|Sentry DSN."
    "kinvara/app/webpush-vapid|Self-hosted VAPID keypair. No push vendor is in the notification path (INT-5.5)."
    "kinvara/app/session-cookie-key|__Host- session cookie signing key (SEC-1)."
    "kinvara/app/e164-hash-salt|Salt for out_of_hours_call.from_e164_hash. The safety line NEVER stores a raw number (SD, EV-1 privacy posture)."
)

# ---------------------------------------------------------------------------
# SES — the identities the real SES account would have verified.
# ---------------------------------------------------------------------------
KINVARA_SES_IDENTITIES=(
    "no-reply@kinvara.test"
    "safeguarding@kinvara.test"
    "kinvara.test"
)

# The region is a COMPLIANCE FACT, not a default (SA §TS-8r). eu-central-1
# Frankfurt; DR destination eu-west-1 Ireland; both in the EU, so no Chapter V
# transfer on any path. Never us-east-1.
KINVARA_AWS_REGION="${AWS_DEFAULT_REGION:-eu-central-1}"
