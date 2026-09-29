#!/bin/sh
set -eu

: "${DSH_HOME:=/data}"
export DSH_HOME

if [ "$DSH_HOME" != "/data" ]; then
    echo "DSH_HOME must be /data; refusing to initialize an unexpected path: $DSH_HOME" >&2
    exit 64
fi

mkdir -p /data /workspace

if [ ! -e /data/.initialized ]; then
    cp -a /opt/dsh-seed/. /data/
    : > /data/.initialized
    chown -R node:node /data
fi

# A Docker named volume is normally root-owned when first mounted.  Make its
# mount point writable before dropping privileges, without recursively changing
# a long-lived agent workspace on every start.
chown node:node /workspace
cd /workspace

exec setpriv --reuid=node --regid=node --init-groups -- "$@"
