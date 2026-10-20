#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('${ROOT_DIR}/package.json').version")"
OUT_DIR="${ROOT_DIR}/dist"
PACKAGE_NAME="homeserver-manager-${VERSION}"
STAGE_DIR="${OUT_DIR}/${PACKAGE_NAME}"

rm -rf "${STAGE_DIR}"
mkdir -p "${STAGE_DIR}"
cp -a \
  "${ROOT_DIR}/package.json" \
  "${ROOT_DIR}/package-lock.json" \
  "${ROOT_DIR}/README.md" \
  "${ROOT_DIR}/.gitignore" \
  "${ROOT_DIR}/public" \
  "${ROOT_DIR}/server" \
  "${ROOT_DIR}/scripts" \
  "${STAGE_DIR}/"
rm -rf "${STAGE_DIR}/dist"
chmod +x "${STAGE_DIR}/scripts/"*.sh

tar -C "${OUT_DIR}" -czf "${OUT_DIR}/${PACKAGE_NAME}.tar.gz" "${PACKAGE_NAME}"
rm -rf "${STAGE_DIR}"
echo "${OUT_DIR}/${PACKAGE_NAME}.tar.gz"
