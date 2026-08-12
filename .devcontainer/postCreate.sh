#!/usr/bin/env bash


set -euo pipefail

if [ -f pnpm-lock.yaml ]; then
    pnpm install --frozen-lockfile;
else
    npm ci;
fi
mkdir -p .codegraph
sudo chown -R node:node .codegraph
codegraph init
