#!/usr/bin/env bash
# The example project's teardown: stops the database private to this worktree, the compose project
# example-project-local-<cksum of the worktree path>, and removes its volumes. The ticket runner's tests run it with a
# fake docker.
# Usage: scripts/local-db.sh down
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
path_hash="$(printf '%s' "$root" | cksum | cut -d' ' -f1)"
export COMPOSE_PROJECT_NAME="example-project-local-$path_hash"

if [[ "${1:-}" != down ]]; then
  echo "Usage: scripts/local-db.sh down" >&2
  exit 2
fi
docker compose --file "$root/database/compose.yml" down --volumes --remove-orphans >&2
