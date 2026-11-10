#!/bin/sh
# Запуск редактора на Linux/macOS: ./run.sh [порт], по умолчанию 8090
PORT="${1:-8090}"
cd "$(dirname "$0")"
(sleep 1; xdg-open "http://localhost:$PORT" 2>/dev/null || open "http://localhost:$PORT") &
python3 -m http.server "$PORT"
