#!/usr/bin/env bash
#
# LocalStack ready-hook — creates the buckets, CMKs, secrets and SES identities
# of lib/manifest.sh. Ticket: T-017. Mounted at
# /etc/localstack/init/ready.d/10-seed.sh and run once, after LocalStack is up.
#
# It is IDEMPOTENT: everything it creates is checked for first, so a container
# restart re-runs it harmlessly.
#
# It is also FAIL-LOUD: `set -euo pipefail`, and the last thing it does is run
# the same verifier a human runs. A seed that half-worked and reported success
# would be exactly the "green step measuring nothing" defect this programme has
# now hit three times (OD-1, OD-7, the Trivy zero-package case).

set -euo pipefail

SEED_LIB="${SEED_LIB:-/opt/kinvara/seed}"
# shellcheck source=../lib/manifest.sh
. "${SEED_LIB}/manifest.sh"

export AWS_DEFAULT_REGION="${KINVARA_AWS_REGION}"
export AWS_REGION="${KINVARA_AWS_REGION}"

log() { printf '[kinvara-seed] %s\n' "$*"; }

log "region ${KINVARA_AWS_REGION} (SA TS-8r — a compliance fact, not a default)"

# --- S3 --------------------------------------------------------------------
for bucket in "${KINVARA_BUCKETS[@]}"; do
    if awslocal s3api head-bucket --bucket "${bucket}" >/dev/null 2>&1; then
        log "bucket ${bucket} already present"
    else
        awslocal s3api create-bucket \
            --bucket "${bucket}" \
            --create-bucket-configuration "LocationConstraint=${KINVARA_AWS_REGION}" \
            >/dev/null
        log "bucket ${bucket} created"
    fi
    # Public access blocked at the account level in AWS (SA DA-12). LocalStack
    # has no account-level control, so it is applied per bucket — recorded in
    # T-019's parity list as a property compose CANNOT prove.
    awslocal s3api put-public-access-block \
        --bucket "${bucket}" \
        --public-access-block-configuration \
        "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" \
        >/dev/null 2>&1 || log "WARNING: put-public-access-block unsupported for ${bucket}"
done

for bucket in "${KINVARA_VERSIONED_BUCKETS[@]}"; do
    awslocal s3api put-bucket-versioning \
        --bucket "${bucket}" --versioning-configuration Status=Enabled >/dev/null
    log "bucket ${bucket} versioning enabled"
done

# --- KMS -------------------------------------------------------------------
#
# Aliased, because an alias is the only stable handle: a CMK's key id differs
# on every fresh project, so `packages/crypto` must address a key by
# `alias/kinvara-<purpose>` and never by id. That is the whole reason the alias
# names are part of the published contract.
for entry in "${KINVARA_CMKS[@]}"; do
    purpose="${entry%%|*}"
    description="${entry#*|}"
    alias_name="alias/kinvara-${purpose}"
    if awslocal kms describe-key --key-id "${alias_name}" >/dev/null 2>&1; then
        log "cmk ${alias_name} already present"
        continue
    fi
    key_id="$(awslocal kms create-key \
        --description "${description}" \
        --key-usage ENCRYPT_DECRYPT \
        --tags "TagKey=kinvara:purpose,TagValue=${purpose}" \
        --query 'KeyMetadata.KeyId' --output text)"
    awslocal kms create-alias --alias-name "${alias_name}" --target-key-id "${key_id}" >/dev/null
    log "cmk ${alias_name} created (${key_id})"
done

# --- Secrets Manager -------------------------------------------------------
#
# EVERY VALUE IS THE SAME OBVIOUS PLACEHOLDER. It is not a weak secret, it is
# a NON-secret: anything that reads one and works has proved it can read a
# secret, and anything that expects it to authenticate against a real endpoint
# is reaching for the internet from a network that has none — which is the
# finding, not an obstacle (DOCKER.md §7).
for entry in "${KINVARA_SECRETS[@]}"; do
    name="${entry%%|*}"
    description="${entry#*|}"
    value="local-fake-not-a-credential:${name}"
    if awslocal secretsmanager describe-secret --secret-id "${name}" >/dev/null 2>&1; then
        awslocal secretsmanager put-secret-value \
            --secret-id "${name}" --secret-string "${value}" >/dev/null
        log "secret ${name} already present (value re-put)"
    else
        awslocal secretsmanager create-secret \
            --name "${name}" --description "${description}" --secret-string "${value}" >/dev/null
        log "secret ${name} created"
    fi
done

# --- SES -------------------------------------------------------------------
for identity in "${KINVARA_SES_IDENTITIES[@]}"; do
    awslocal ses verify-email-identity --email-address "${identity}" >/dev/null 2>&1 \
        || awslocal ses verify-domain-identity --domain "${identity}" >/dev/null 2>&1 \
        || log "WARNING: could not verify SES identity ${identity}"
    log "ses identity ${identity} verified"
done

# --- and prove it ----------------------------------------------------------
#
# The verifier runs here, not just when a human asks. `set -e` means a failed
# verify never reaches the `touch` below, the marker file is never written, the
# container never reports healthy, and `scripts/svc up` fails with a timeout
# instead of handing somebody a half-seeded LocalStack.
log "seed complete; verifying"
"${SEED_LIB}/verify.sh"

# THE READY MARKER, and why the healthcheck reads it.
#
# LocalStack reports healthy the moment its own services are up — which is
# BEFORE this ready-hook has finished. Without this marker, `svc up <t> aws`
# returns, the agent immediately lists buckets, and gets a partially-seeded
# account: exactly the race that produced this file's first failing run. The
# compose healthcheck therefore requires BOTH LocalStack's own health endpoint
# AND this file, so "healthy" means "seeded and verified".
touch /tmp/kinvara-seed-complete
log "ready marker written; the aws profile is seeded and verified"
