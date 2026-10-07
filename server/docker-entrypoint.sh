#!/bin/sh
# Arranque del contenedor: migraciones y servidor, sin privilegios de root.
set -e

MEDIA="${MEDIA_DIR:-/crm/server/data/media}"

# El contenedor arranca como root solo para dejar el volumen de medios a nombre de `node`
# (los volúmenes creados por versiones anteriores de la imagen son de root) y enseguida
# se vuelve a ejecutar como ese usuario.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$MEDIA"
  chown -R node:node "$MEDIA"
  exec su-exec node "$0" "$@"
fi

node src/migrate.ts
exec node src/index.ts
