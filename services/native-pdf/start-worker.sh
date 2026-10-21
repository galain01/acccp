#!/bin/sh
set -eu
worker_port="${PORT:-80}"
case "$worker_port" in ''|*[!0-9]*) echo 'Native PDF port is invalid.' >&2; exit 1;; esac
if [ "${#worker_port}" -gt 5 ] || [ "$worker_port" -lt 1 ] || [ "$worker_port" -gt 65535 ]; then
  echo 'Native PDF port is invalid.' >&2; exit 1
fi
worker_key="${NATIVE_PDF_API_KEY:-}"
if [ "${#worker_key}" -lt 32 ]; then
  echo 'Native PDF authentication is not configured.' >&2; exit 1
fi
# Project variables are shared by Vercel services. Only the supervisor needs
# this one credential and the public storage origin. A signed per-object URL
# arrives in the authenticated request; document processors get a clean env.
exec /usr/bin/env -i \
  PATH=/usr/local/bin:/usr/bin:/bin \
  HOME=/home/pdfworker \
  LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC \
  PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
  NATIVE_PDF_API_KEY="$worker_key" \
  SUPABASE_URL="${SUPABASE_URL:-}" \
  /usr/bin/tini -- /usr/local/bin/python /app/services/native-pdf/server.py \
  --host 0.0.0.0 --port "$worker_port"
