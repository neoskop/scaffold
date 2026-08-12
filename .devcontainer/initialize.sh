#!/usr/bin/env bash
#
# initialize.sh — host-side bootstrap, run by devcontainer.json `initializeCommand`
# BEFORE the image is built. Runs on the HOST (Linux/macOS), not in the container.
#
# Single job: write .devcontainer/.env with
#   * the host user's UID/GID + workspace path, so the container user matches you and
#     the bind mount uses the same absolute path, and
#   * a SearXNG secret for the search sidecar (reused across restarts when present;
#     it only signs SearXNG-internal HMAC tokens, nothing durable depends on it).
#
# SECURITY NOTE: this script executes on the host, which is why .devcontainer is
# ro-mounted inside the container (see docker-compose.yml) — nothing running in the
# container may be able to edit it.

set -euo pipefail

# Workspace folder is passed as $1 (${localWorkspaceFolder}); fall back to CWD.
workspace="${1:-$PWD}"
here="${workspace}/.devcontainer"

secret=""
if [ -f "${here}/.env" ]; then
    secret="$(sed -n 's/^SEARXNG_SECRET=//p' "${here}/.env")"
fi
if [ -z "${secret}" ]; then
    secret="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
fi

printf 'USER_UID=%s\nUSER_GID=%s\nLOCAL_WORKSPACE_FOLDER=%s\nSEARXNG_SECRET=%s\n' \
    "$(id -u)" "$(id -g)" "${workspace}" "${secret}" > "${here}/.env"
