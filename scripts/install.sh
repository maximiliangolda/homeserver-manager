#!/usr/bin/env bash
set -euo pipefail

APP_NAME="homeserver-manager"
APP_DIR="${APP_DIR:-/opt/${APP_NAME}}"
APP_USER="${APP_USER:-${APP_NAME}}"
SERVICE_NAME="${SERVICE_NAME:-${APP_NAME}}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Dieses Skript muss als root ausgeführt werden (z. B. sudo bash scripts/install.sh)." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js >= 18 ist erforderlich. Bitte zuerst Node.js installieren." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 18 )); then
  echo "Node.js >= 18 ist erforderlich (gefunden: $(node --version))." >&2
  exit 1
fi

for command in npm systemctl; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "Benötigtes Programm fehlt: ${command}" >&2
    exit 1
  fi
done

if ! id "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --home-dir "${APP_DIR}" --shell /usr/sbin/nologin "${APP_USER}"
fi

install -d -o "${APP_USER}" -g "${APP_USER}" "${APP_DIR}" "${APP_DIR}/data"
cp -a --no-preserve=ownership \
  "${SOURCE_DIR}/package.json" \
  "${SOURCE_DIR}/package-lock.json" \
  "${SOURCE_DIR}/public" \
  "${SOURCE_DIR}/server" \
  "${APP_DIR}/"

chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
runuser -u "${APP_USER}" -- npm --prefix "${APP_DIR}" ci --omit=dev

install -d /etc/systemd/system
sed \
  -e "s|@@APP_DIR@@|${APP_DIR}|g" \
  -e "s|@@APP_USER@@|${APP_USER}|g" \
  -e "s|@@SERVICE_NAME@@|${SERVICE_NAME}|g" \
  "${SCRIPT_DIR}/homeserver-manager.service" > "/etc/systemd/system/${SERVICE_NAME}.service"

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.service"

echo
echo "Homeserver-Manager wurde installiert."
echo "Installationspfad: ${APP_DIR}"
echo "Dienststatus:       systemctl status ${SERVICE_NAME}"
echo "Dashboard:          http://<server>:4680"
