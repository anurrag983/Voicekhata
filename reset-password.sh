#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "Backend environment not found. Start the backend once with ./start.sh first."
  exit 1
fi
exec .venv/bin/python -m app.reset_password
