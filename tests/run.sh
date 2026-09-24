#!/usr/bin/env bash
# Прогон gjs-тестов ядра (tests/*.test.js). Gvc лежит в приватном каталоге Shell.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export GI_TYPELIB_PATH=/usr/lib/gnome-shell${GI_TYPELIB_PATH:+:$GI_TYPELIB_PATH}
export LD_LIBRARY_PATH=/usr/lib/gnome-shell${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}

status=0
for t in tests/*.test.js; do
  echo "== $t"
  timeout 60 gjs -m "$t" || status=1
done
exit $status
