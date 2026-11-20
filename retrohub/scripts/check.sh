#!/usr/bin/env bash
# RetroHub – statische Prüfungen (ShellCheck, JavaScript-Syntax, CSS, Versionsangaben)
set -Eeuo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd); cd "${ROOT}"
command -v shellcheck >/dev/null || { echo "shellcheck fehlt – bitte installieren (z. B. apt install shellcheck)." >&2; exit 2; }
[[ -d node_modules/css-tree ]] || { echo "Entwicklungswerkzeuge fehlen – bitte zuerst im Projektordner 'npm ci' ausführen." >&2; exit 2; }
echo "==> ShellCheck"
shellcheck install.sh lib/*.sh tools/*.sh scripts/*.sh
echo "==> JavaScript-Syntax"
find server tools web emu tests -name '*.js' -not -path '*/node_modules/*' -print0 | xargs -0 -n1 node --check
echo "==> CSS"
node -e "const t=require('css-tree');const e=[];t.parse(require('fs').readFileSync('web/assets/app.css','utf8'),{onParseError:x=>e.push(x.message)});if(e.length){console.error(e);process.exit(1)}"
echo "==> JSON"
node -e "for (const f of ['games/sources.json','package.json','server/package.json']) JSON.parse(require('fs').readFileSync(f,'utf8'))"
echo "==> Versionsangaben"
V=$(tr -d '[:space:]' < VERSION)
grep -q "\"version\": \"${V}\"" package.json || { echo "package.json passt nicht zu VERSION ${V}"; exit 1; }
grep -q "\"version\": \"${V}\"" server/package.json || { echo "server/package.json passt nicht zu VERSION ${V}"; exit 1; }
grep -q "readonly RH_VERSION=\"${V}\"" install.sh || { echo "install.sh passt nicht zu VERSION ${V}"; exit 1; }
grep -q "^## ${V}$" CHANGELOG.md || { echo "CHANGELOG.md hat keinen Abschnitt ${V}"; exit 1; }
echo "Alle Prüfungen bestanden."
