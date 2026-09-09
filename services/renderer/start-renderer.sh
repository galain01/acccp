#!/bin/sh
set -eu

# Vercel shares project variables across services. Never pass unrelated app
# secrets, proxy settings, or runtime injection flags to document processors.
if [ -z "${GOTENBERG_USERNAME:-}" ] || [ -z "${GOTENBERG_PASSWORD:-}" ]; then
  echo "Word renderer authentication is not configured." >&2
  exit 1
fi
case "$GOTENBERG_USERNAME" in
  *:*)
    echo "Word renderer authentication is invalid." >&2
    exit 1
    ;;
esac

worker_port="${PORT:-80}"
case "$worker_port" in
  ''|*[!0-9]*)
    echo "Word renderer port is invalid." >&2
    exit 1
    ;;
esac
if [ "${#worker_port}" -gt 5 ] || [ "$worker_port" -lt 1 ] || [ "$worker_port" -gt 65535 ]; then
  echo "Word renderer port is invalid." >&2
  exit 1
fi

exec /usr/bin/env -i \
  PATH=/opt/java/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  HOME=/home/gotenberg \
  TZ=UTC \
  LANG=C.UTF-8 \
  LC_ALL=C.UTF-8 \
  TMPDIR=/tmp \
  PDFTK_BIN_PATH=/usr/bin/pdftk \
  QPDF_BIN_PATH=/usr/bin/qpdf \
  EXIFTOOL_BIN_PATH=/usr/bin/exiftool \
  PDFCPU_BIN_PATH=/usr/bin/pdfcpu \
  GOTENBERG_VERSIONS_DIR_PATH=/opt/gotenberg/versions \
  LIBREOFFICE_BIN_PATH=/usr/lib/libreoffice/program/soffice.bin \
  UNOCONVERTER_BIN_PATH=/usr/bin/unoconverter \
  OTEL_TRACES_EXPORTER=none \
  OTEL_METRICS_EXPORTER=none \
  OTEL_LOGS_EXPORTER=none \
  LOG_LEVEL=error \
  API_PORT="$worker_port" \
  API_ENABLE_BASIC_AUTH=true \
  GOTENBERG_API_BASIC_AUTH_USERNAME="$GOTENBERG_USERNAME" \
  GOTENBERG_API_BASIC_AUTH_PASSWORD="$GOTENBERG_PASSWORD" \
  API_BODY_LIMIT=5MB \
  API_TIMEOUT=60s \
  API_DISABLE_DOWNLOAD_FROM=true \
  API_ENABLE_DEBUG_ROUTE=false \
  LIBREOFFICE_AUTO_START=true \
  LIBREOFFICE_START_TIMEOUT=30s \
  LIBREOFFICE_MAX_QUEUE_SIZE=2 \
  LIBREOFFICE_DENY_LIST='.*' \
  WEBHOOK_DISABLE=true \
  PDFENGINES_DISABLE_ROUTES=true \
  /usr/bin/tini -- /usr/bin/gotenberg
