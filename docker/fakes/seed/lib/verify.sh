#!/usr/bin/env bash
#
# Verify the LocalStack seed. Ticket: T-017.
#
#   scripts/svc exec <ticket> localstack /opt/kinvara/seed/verify.sh
#
# Reads the SAME manifest.sh the seed does, so the two cannot drift: a bucket
# added to the manifest is checked here without anyone remembering to.
#
# ANTI-VACUOUS BY CONSTRUCTION. `gate:trivy` once passed while resolving zero
# packages, and `pg_stat_statements` once installed while being dead (OD-7).
# So this script asserts a NON-ZERO expected count for each of the four
# resource classes before it checks anything, and fails if the manifest is
# empty. A verifier that checks nothing must not be able to print PASS.

set -uo pipefail

SEED_LIB="${SEED_LIB:-/opt/kinvara/seed}"
# shellcheck source=manifest.sh
. "${SEED_LIB}/manifest.sh"

export AWS_DEFAULT_REGION="${KINVARA_AWS_REGION}"
export AWS_REGION="${KINVARA_AWS_REGION}"

fail=0
problem() { printf '  MISSING  %s\n' "$*"; fail=$((fail + 1)); }
ok() { printf '  ok       %s\n' "$*"; }

if [ "${#KINVARA_BUCKETS[@]}" -eq 0 ] || [ "${#KINVARA_CMKS[@]}" -eq 0 ] ||
    [ "${#KINVARA_SECRETS[@]}" -eq 0 ] || [ "${#KINVARA_SES_IDENTITIES[@]}" -eq 0 ]; then
    printf 'SEED FAIL — the manifest is empty for at least one resource class.\n' >&2
    printf 'A verifier that checks nothing must not print PASS.\n' >&2
    exit 1
fi

printf 'S3 buckets (SA DA-12) — expecting %s\n' "${#KINVARA_BUCKETS[@]}"
for bucket in "${KINVARA_BUCKETS[@]}"; do
    if awslocal s3api head-bucket --bucket "${bucket}" >/dev/null 2>&1; then
        ok "s3://${bucket}"
    else
        problem "s3://${bucket}"
    fi
done

printf '\nS3 versioning (SA DA-12) — expecting %s, and kinvara-idv-ephemeral NOT versioned\n' \
    "${#KINVARA_VERSIONED_BUCKETS[@]}"
for bucket in "${KINVARA_VERSIONED_BUCKETS[@]}"; do
    status="$(awslocal s3api get-bucket-versioning --bucket "${bucket}" \
        --query 'Status' --output text 2>/dev/null)"
    if [ "${status}" = "Enabled" ]; then ok "${bucket} versioning=Enabled"; else
        problem "${bucket} versioning=${status:-none}"
    fi
done
idv_status="$(awslocal s3api get-bucket-versioning --bucket kinvara-idv-ephemeral \
    --query 'Status' --output text 2>/dev/null)"
if [ "${idv_status}" = "Enabled" ]; then
    problem "kinvara-idv-ephemeral IS versioned — a version survives the 30-day hard delete and defeats §L2"
else
    ok "kinvara-idv-ephemeral versioning=${idv_status:-none} (correct — versions would defeat §L2 deletion)"
fi

printf '\nKMS CMKs — expecting %s (see manifest.sh: seven purposes are named by the specs, OD-11)\n' \
    "${#KINVARA_CMKS[@]}"
for entry in "${KINVARA_CMKS[@]}"; do
    purpose="${entry%%|*}"
    alias_name="alias/kinvara-${purpose}"
    key_id="$(awslocal kms describe-key --key-id "${alias_name}" \
        --query 'KeyMetadata.KeyId' --output text 2>/dev/null)"
    if [ -n "${key_id}" ] && [ "${key_id}" != "None" ]; then
        ok "${alias_name} -> ${key_id}"
    else
        problem "${alias_name}"
    fi
done

printf '\nSecrets Manager — expecting %s\n' "${#KINVARA_SECRETS[@]}"
for entry in "${KINVARA_SECRETS[@]}"; do
    name="${entry%%|*}"
    if awslocal secretsmanager describe-secret --secret-id "${name}" >/dev/null 2>&1; then
        ok "${name}"
    else
        problem "${name}"
    fi
done

printf '\nSES identities — expecting %s\n' "${#KINVARA_SES_IDENTITIES[@]}"
for identity in "${KINVARA_SES_IDENTITIES[@]}"; do
    # Queried one at a time rather than substring-matched against a listing.
    # `--output text` separates a list with TABS, and " ${list} " =~ " ${x} "
    # therefore never matched — this check reported three missing identities
    # that were present all along. A verifier's own false positive is still a
    # false result.
    found="$(awslocal ses list-identities \
        --query "Identities[?@=='${identity}'] | [0]" --output text 2>/dev/null)"
    if [ "${found}" = "${identity}" ]; then ok "${identity}"; else problem "${identity}"; fi
done

total=$((${#KINVARA_BUCKETS[@]} + ${#KINVARA_CMKS[@]} + ${#KINVARA_SECRETS[@]} + ${#KINVARA_SES_IDENTITIES[@]}))
printf '\n'
if [ "${fail}" -eq 0 ]; then
    printf 'SEED PASS — %s resources present across 4 classes.\n' "${total}"
    exit 0
fi
printf 'SEED FAIL — %s of %s resources missing.\n' "${fail}" "${total}" >&2
exit 1
