#!/usr/bin/env bash
# RetroHub – Repository für die Veröffentlichung vorbereiten (einmalig, vor dem ersten Push).
#
#   scripts/vorbereiten.sh "Dein Name" dein-github-name [repository-name] [--push]
#
# Trägt Namen und GitHub-Konto in LICENSE und Vorlagen ein, prüft auf übrige Platzhalter,
# legt das Git-Repository mit dem ersten Commit an und setzt den Remote.
# Mit --push wird zusätzlich hochgeladen und der Versions-Tag gesetzt (löst das Release aus).
set -Eeuo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd); cd "${ROOT}"
NAME=${1:-}; OWNER=${2:-}; REPO=${3:-retrohub}; PUSH=0
for a in "$@"; do [[ "$a" == --push ]] && PUSH=1; done
[[ "${REPO}" == --push ]] && REPO=retrohub
if [[ -z "${NAME}" || -z "${OWNER}" ]]; then
  echo "Aufruf: $0 \"Dein Name\" dein-github-name [repository-name] [--push]" >&2; exit 2
fi
[[ "${OWNER}" =~ ^[A-Za-z0-9-]{1,39}$ ]] || { echo "GitHub-Name ungültig: ${OWNER}" >&2; exit 2; }
[[ "${REPO}" =~ ^[A-Za-z0-9._-]{1,100}$ ]] || { echo "Repository-Name ungültig: ${REPO}" >&2; exit 2; }
command -v git >/dev/null || { echo "git fehlt" >&2; exit 2; }
V=$(tr -d '[:space:]' < VERSION)

echo "==> Platzhalter ersetzen"
esc() { printf '%s' "$1" | sed 's/[\/&|]/\\&/g'; }
sed -i "s|Copyright (c) 2026 DEIN NAME|Copyright (c) $(date +%Y) $(esc "${NAME}")|" LICENSE
sed -i "s|OWNER/REPO|${OWNER}/${REPO}|g" .github/ISSUE_TEMPLATE/config.yml README.md README.en.md docs/releases/*.md 2>/dev/null || true
left=$(grep -rIl --exclude-dir=node_modules --exclude-dir=.git --exclude=vorbereiten.sh -e 'DEIN NAME' -e 'OWNER/REPO' . || true)
[[ -z "${left}" ]] || { echo "Noch Platzhalter in: ${left}" >&2; exit 1; }
echo "    LICENSE: ${NAME}; Repository: ${OWNER}/${REPO}"

echo "==> Git-Repository anlegen"
if [[ ! -d .git ]]; then git init -q -b main; fi
git config user.name >/dev/null || { echo "Bitte zuerst: git config --global user.name \"${NAME}\" und user.email setzen" >&2; exit 1; }
git add -A
git diff --cached --quiet || git commit -q -m "RetroHub ${V} – erste Veröffentlichung"
git remote get-url origin >/dev/null 2>&1 || git remote add origin "git@github.com:${OWNER}/${REPO}.git"
echo "    Commit: $(git log -1 --format='%h %s')"
echo "    Remote: $(git remote get-url origin)"

if [[ "${PUSH}" == 1 ]]; then
  echo "==> Hochladen und Release auslösen"
  git push -u origin main
  git tag -a "v${V}" -m "RetroHub ${V}" 2>/dev/null || true
  git push origin "v${V}"
  echo "Fertig. Fortschritt unter https://github.com/${OWNER}/${REPO}/actions"
else
  echo
  echo "Nächste Schritte:"
  echo "  1. Auf GitHub ein LEERES Repository ${OWNER}/${REPO} anlegen (ohne README/LICENSE)."
  echo "  2. git push -u origin main"
  echo "  3. git tag -a v${V} -m \"RetroHub ${V}\" && git push origin v${V}   # baut und veröffentlicht das Release"
fi
