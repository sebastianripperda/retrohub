#!/usr/bin/env bash
# RetroHub 9 – Emulator-Pakete vorab laden (für Installationen ohne Internet).
# Läuft auf jedem Linux-Rechner mit Internet (auch auf dem Proxmox-Host). Benötigt: bash, python3, curl, sha256sum.
#
#   tools/emulatoren-vorab-laden.sh ZIELORDNER [core-fceumm,core-snes9x,...]
#
# Danach installieren mit:  GAMES_DIR=ZIELORDNER ./install.sh
set -Eeuo pipefail
DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DEST=${1:-}; ONLY=${2:-}
[[ -n "${DEST}" ]] || { echo "Aufruf: $0 ZIELORDNER [core-a,core-b,...]" >&2; exit 2; }
for c in python3 curl sha256sum; do command -v "${c}" >/dev/null 2>&1 || { echo "FEHLER: '${c}' fehlt." >&2; exit 12; }; done
mkdir -p "${DEST}"
# Liste: id, sha256, url (nur Emulator-Pakete; die Oberfläche "emulatorjs" ist immer dabei)
mapfile -t ENTRIES < <(python3 - "${DIR}/games/sources.json" "${ONLY}" <<'PY'
import json, sys
src = json.load(open(sys.argv[1])); only = [x for x in sys.argv[2].split(',') if x]
for e in src.get('emulators', []):
    if only and e['id'] != 'emulatorjs' and e['id'] not in only: continue
    print(e['id'], e['sha256'], e['url'])
PY
)
ok=0; fail=0
for line in "${ENTRIES[@]}"; do
  read -r id sha url <<<"${line}"
  target="${DEST}/${id}-${sha:0:12}.tgz"
  if [[ -f "${target}" ]] && [[ "$(sha256sum "${target}" | cut -c1-64)" == "${sha}" ]]; then echo "= ${id}: bereits vorhanden"; ok=$((ok + 1)); continue; fi
  echo "↓ ${id}"
  if curl -fsSL --retry 3 -o "${target}.part" "${url}" && [[ "$(sha256sum "${target}.part" | cut -c1-64)" == "${sha}" ]]; then
    mv "${target}.part" "${target}"; echo "✔ ${id}: Prüfsumme korrekt"; ok=$((ok + 1))
  else
    rm -f "${target}.part"; echo "✘ ${id}: Download oder Prüfsumme fehlgeschlagen" >&2; fail=$((fail + 1))
  fi
done
echo "Ergebnis: ${ok} bereit, ${fail} fehlgeschlagen. Ordner: ${DEST}"
echo "Installieren ohne Internet:  GAMES_DIR=${DEST} ./install.sh"
[[ "${fail}" == 0 ]]
