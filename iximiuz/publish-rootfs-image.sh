#!/usr/bin/env bash
# One command to build, push, increment the version, and sync the playground.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${repo_root}/iximiuz/versions.sh"
manifest="${repo_root}/iximiuz/manifest.yaml"

usage() {
  cat <<'EOF'
Usage: bash iximiuz/publish-rootfs-image.sh [new-image-tag]
       bash iximiuz/publish-rootfs-image.sh --sync-remote

Without a tag, read the current vN tag from versions.sh, build and push v(N+1),
then update versions.sh, manifest.yaml, and the remote iximiuz playground.
--sync-remote retries only playground creation or update.
EOF
}

sync_remote() {
  local name
  name="$(awk '/^name:[[:space:]]*/ { print $2; exit }' "${manifest}")"
  if [[ -z "${name}" ]]; then
    echo "error: missing playground name in ${manifest}." >&2
    exit 1
  fi
  if labctl playground manifest "${name}" >/dev/null 2>&1; then
    labctl playground update "${name}" --file "${manifest}"
  else
    echo "Creating remote playground from ${manifest}..."
    local created
    created="$(labctl playground create --base docker --file "${manifest}" --quiet "${name}")"
    [[ -n "${created}" ]] || { echo "error: labctl returned no playground name." >&2; exit 1; }
    sed -i -E "s/^name: .*/name: ${created}/" "${manifest}"
    echo "Created ${created}"
  fi
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi
if [[ "${1:-}" == "--sync-remote" && $# -eq 1 ]]; then
  sync_remote
  exit 0
fi
if [[ $# -gt 1 || "${1:-}" == -* ]]; then
  usage >&2
  exit 1
fi

if [[ $# -eq 1 ]]; then
  next_tag="$1"
else
  if [[ ! "${ROOTFS_IMAGE_TAG}" =~ ^v([0-9]+)$ ]]; then
    echo "error: cannot increment '${ROOTFS_IMAGE_TAG}'; pass a tag explicitly." >&2
    exit 1
  fi
  next_tag="v$((10#${BASH_REMATCH[1]} + 1))"
fi
if [[ ! "${next_tag}" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ || "${next_tag}" == "${ROOTFS_IMAGE_TAG}" ]]; then
  echo "error: invalid or current image tag '${next_tag}'." >&2
  exit 1
fi

echo "Publishing ${ROOTFS_IMAGE_REPO}:${next_tag}..."
IMAGE_TAG="${next_tag}" PUSH_ROOTFS_IMAGE=1 bash "${repo_root}/iximiuz/build-rootfs-image.sh"

image="${ROOTFS_IMAGE_REPO}:${next_tag}"
sed -i \
  -e "s#^readonly ROOTFS_IMAGE_TAG=\"[^\"]*\"#readonly ROOTFS_IMAGE_TAG=\"${next_tag}\"#" \
  -e "s#^readonly ROOTFS_IMAGE=\"[^\"]*\"#readonly ROOTFS_IMAGE=\"${image}\"#" \
  "${repo_root}/iximiuz/versions.sh"
sed -i -E "s#(source: oci://)${ROOTFS_IMAGE_REPO//./\\.}:[A-Za-z0-9_.-]+#\\1${image}#" "${manifest}"
grep -q "^readonly ROOTFS_IMAGE_TAG=\"${next_tag}\"" "${repo_root}/iximiuz/versions.sh"
grep -q "source: oci://${image}$" "${manifest}"

if ! sync_remote; then
  echo "Image pushed; remote sync failed. Retry: bash iximiuz/publish-rootfs-image.sh --sync-remote" >&2
  exit 1
fi
echo "Published ${image} and synchronized the playground."
