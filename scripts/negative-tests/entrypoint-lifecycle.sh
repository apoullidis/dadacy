#!/usr/bin/env bash
# T-180: docker/app-runtime/entrypoint.mjs's group-drain deadline, judged by
# running it. The cases and what they do NOT cover are in the .mjs beside this
# file. This wrapper exists because gate:negative-suites runs `bash <suite>`.
# It plants nothing in the working tree: the fixture app lives in a temp dir.
set -uo pipefail
cd "$(dirname "$0")/../.."
exec node scripts/negative-tests/entrypoint-lifecycle.mjs
