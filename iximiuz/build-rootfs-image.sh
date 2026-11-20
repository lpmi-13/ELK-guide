#!/usr/bin/env bash
# Build a rootfs from tracked project files and preload all Compose images.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${repo_root}/iximiuz/versions.sh"
image_tag="${IMAGE_TAG:-${ROOTFS_IMAGE_TAG}}"
rootfs_image="${ROOTFS_IMAGE_OVERRIDE:-${ROOTFS_IMAGE_REPO}:${image_tag}}"
rootfs_release="${ROOTFS_RELEASE:-${IXIMIUZ_ROOTFS_RELEASE}}"

build_context="$(mktemp -d "${TMPDIR:-/tmp}/elk-guide-rootfs.XXXXXX")"
trap 'rm -rf "${build_context}"' EXIT
mkdir -p "${build_context}/ELK-guide"

# Copy the working-tree contents of tracked files, including local edits, without
# writing to .git. Untracked .env, logs, recordings, and caches stay out.
tar -C "${repo_root}" --null -T <(
  while IFS= read -r -d '' path; do
    if [[ -e "${repo_root}/${path}" || -L "${repo_root}/${path}" ]]; then
      printf '%s\0' "${path}"
    fi
  done < <(git -C "${repo_root}" ls-files -z)
) -cf - \
  | tar -C "${build_context}/ELK-guide" -xf -
# Include the current iximiuz scripts without nesting a second copy of the directory.
cp -a "${repo_root}/iximiuz/." "${build_context}/ELK-guide/iximiuz/"
# Include the new setup entrypoint in working-tree snapshots before its first commit.
cp "${repo_root}/kibana/setup.py" "${build_context}/ELK-guide/kibana/setup.py"
cp "${repo_root}/iximiuz/Dockerfile" "${build_context}/Dockerfile"

echo "Building the Compose images from the publication snapshot..."
docker compose --project-directory "${build_context}/ELK-guide" -f "${build_context}/ELK-guide/docker-compose.yml" build
mapfile -t images < <(docker compose --project-directory "${build_context}/ELK-guide" -f "${build_context}/ELK-guide/docker-compose.yml" config --images | sort -u)
for image in "${images[@]}"; do
  if ! docker image inspect "${image}" >/dev/null 2>&1; then
    echo "Pulling ${image}..."
    docker pull "${image}"
  fi
done

echo "Saving ${#images[@]} images into the rootfs build context..."
docker save -o "${build_context}/images.tar" "${images[@]}"
chmod 0644 "${build_context}/images.tar"

echo "Building ${rootfs_image} on ubuntu-docker-${rootfs_release}..."
docker build --build-arg ROOTFS_RELEASE="${rootfs_release}" \
  --label "org.opencontainers.image.description=Adaptive Kibana learning lab for iximiuz Labs" \
  -t "${rootfs_image}" "${build_context}"

if [[ "${PUSH_ROOTFS_IMAGE:-0}" == "1" ]]; then
  for attempt in 1 2 3; do
    echo "Pushing ${rootfs_image} (attempt ${attempt}/3)..."
    if docker push "${rootfs_image}"; then
      break
    fi
    if [[ "${attempt}" == 3 ]]; then
      echo "error: push failed after three attempts." >&2
      exit 1
    fi
    sleep "$((attempt * ${PUSH_RETRY_DELAY:-15}))"
  done
fi

echo "Built ${rootfs_image}"
