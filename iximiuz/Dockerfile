ARG ROOTFS_RELEASE=c36cb070
FROM ghcr.io/iximiuz/labs/rootfs:ubuntu-docker-${ROOTFS_RELEASE}

USER root
ENV HOME=/root

COPY --chown=laborant:laborant ELK-guide /home/laborant/ELK-guide
COPY images.tar /opt/elk-guide/images.tar

RUN <<'EOS'
set -eu
for cmd in bash docker python3 curl runuser sysctl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "missing tool: $cmd" >&2; exit 1; }
done
docker compose version >/dev/null
id laborant | grep -qw docker
runuser -u laborant -- test -r /opt/elk-guide/images.tar
runuser -u laborant -- test -x /home/laborant/ELK-guide/iximiuz/start-lab.sh
runuser -u laborant -- test -w /home/laborant/ELK-guide
EOS

USER laborant
ENV HOME=/home/laborant
