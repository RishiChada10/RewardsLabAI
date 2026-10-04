#!/bin/bash
cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is required. Install it from https://www.python.org/downloads/, then run this file again."
  read -r -p "Press Enter to close."
  exit 1
fi

if [ ! -x .venv/bin/python ]; then
  echo "First run: setting up a private Python environment..."
  python3 -m venv .venv || { read -r -p "Could not create the environment. Press Enter to close."; exit 1; }
fi
.venv/bin/python -m pip install --quiet --disable-pip-version-check -r requirements.txt \
  || echo "Could not install the Claude SDK (offline?). The app will run in offline mode."

if [ ! -f .env ] && [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "No ANTHROPIC_API_KEY found. Copy .env.example to .env and add your key to enable live AI."
fi

(sleep 1.5; open "http://localhost:8080") &
.venv/bin/python server.py 8080
