#!/usr/bin/env bash
# Builds the test images. Optional: APT_PROXY=http://host:port APT_CA=/path/ca.crt
set -euo pipefail
cd "$(dirname "$0")"
if [[ -n ${APT_CA:-} ]]; then cp "$APT_CA" apt-ca.crt; else : >apt-ca.crt; fi
docker build --network host --build-arg APT_PROXY="${APT_PROXY:-}" -t sb-dest -f Dockerfile.dest .
docker build --network host --build-arg APT_PROXY="${APT_PROXY:-}" -t sb-node -f Dockerfile.server .
docker build -t sb-cardvault ../cardvault-standin
rm -f apt-ca.crt
