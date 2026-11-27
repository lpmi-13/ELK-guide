#!/usr/bin/env bash
# publish-rootfs-image.sh increments this tag after a successful push.
# v0 means the first published image will be v1.
readonly ROOTFS_IMAGE_REPO="ghcr.io/lpmi-13/elk-guide-rootfs"
readonly ROOTFS_IMAGE_TAG="v9"
readonly ROOTFS_IMAGE="ghcr.io/lpmi-13/elk-guide-rootfs:v9"
# Same Docker playground rootfs release used by rstudio-guide.
readonly IXIMIUZ_ROOTFS_RELEASE="c36cb070"
