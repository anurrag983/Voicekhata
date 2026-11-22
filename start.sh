#!/bin/sh
set -eu

cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3.9 or newer is required. Install Python, then run this script again."
  exit 1
fi

if [ ! -d .venv ]; then
  python3 -m venv .venv
fi

if [ ! -f .env ]; then
  cp .env.example .env
  .venv/bin/python - <<'PY'
from pathlib import Path
import secrets

path = Path('.env')
text = path.read_text()
text = text.replace(
    'SECRET_KEY=replace-with-a-random-secret-at-least-32-characters-long',
    f'SECRET_KEY={secrets.token_urlsafe(48)}',
)
path.write_text(text)
PY
fi

if ! cmp -s requirements.txt .venv/.voicekhata-requirements.txt; then
  .venv/bin/python -m pip install -r requirements.txt
  cp requirements.txt .venv/.voicekhata-requirements.txt
  touch .venv/.voicekhata-dependencies-installed
fi

HOST="${HOST:-127.0.0.1}"
exec .venv/bin/python -m uvicorn app.main:app --reload --reload-dir app --host "$HOST" --port 8000
