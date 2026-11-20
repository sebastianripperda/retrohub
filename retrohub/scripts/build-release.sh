#!/usr/bin/env bash
# RetroHub – Release-Archiv aus dem Quellcode bauen.
# Ergebnis: dist/RetroHub-v<VERSION>-AutoInstaller.tar.gz (+ .sha256, RELEASE_NOTES.md)
# Benötigt: bash, Node.js >= 18, npm, tar, sha256sum
set -Eeuo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
V=$(tr -d '[:space:]' < "${ROOT}/VERSION")
NAME="RetroHub-v${V}"
OUT="${ROOT}/dist"
STAGE=$(mktemp -d)
trap 'rm -rf "${STAGE}"' EXIT
[[ "${V}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "VERSION ungültig: ${V}" >&2; exit 2; }
grep -q "\"version\": \"${V}\"" "${ROOT}/server/package.json" || { echo "server/package.json hat nicht Version ${V}" >&2; exit 2; }
mkdir -p "${OUT}" "${STAGE}/${NAME}"
echo "==> Paketinhalt zusammenstellen (${NAME})"
for item in install.sh lib nginx server tools games systemd tests emu web docs VERSION README.md INSTALLATIONSLEITFADEN.md LICENSE THIRD_PARTY_NOTICES.md CHANGELOG.md; do
  cp -r "${ROOT}/${item}" "${STAGE}/${NAME}/"
done
rm -rf "${STAGE}/${NAME}/server/node_modules" "${STAGE}/${NAME}/docs/screenshots" "${STAGE}/${NAME}/docs/social-preview.png" "${STAGE}/${NAME}/docs/releases"   # nur fürs Repository
echo "==> Server-Abhängigkeiten installieren (npm ci, nur Laufzeit)"
(cd "${STAGE}/${NAME}/server" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
# Nur Typdefinitionen – zur Laufzeit nicht nötig
rm -rf "${STAGE}/${NAME}/server/node_modules/@types" "${STAGE}/${NAME}/server/node_modules/undici-types" "${STAGE}/${NAME}/server/node_modules/.package-lock.json"
echo "==> Rechte setzen und Prüfsummen erzeugen"
find "${STAGE}/${NAME}" -type d -exec chmod 0755 {} +
find "${STAGE}/${NAME}" -type f -exec chmod 0644 {} +
chmod 0755 "${STAGE}/${NAME}/install.sh" "${STAGE}/${NAME}/lib/setup-in-ct.sh" "${STAGE}/${NAME}/tools/retrohub-games.js" "${STAGE}/${NAME}/tools/emulatoren-vorab-laden.sh"
(cd "${STAGE}/${NAME}" && find . -type f -printf '%P\n' | LC_ALL=C sort | xargs -d '\n' sha256sum > "${STAGE}/SHA256SUMS" && mv "${STAGE}/SHA256SUMS" SHA256SUMS)
echo "==> Archiv packen"
EPOCH=${SOURCE_DATE_EPOCH:-$(git -C "${ROOT}" log -1 --format=%ct 2>/dev/null || date +%s)}
tar --owner=0 --group=0 --numeric-owner --sort=name --mtime="@${EPOCH}" -czf "${OUT}/${NAME}-AutoInstaller.tar.gz" -C "${STAGE}" "${NAME}"
(cd "${OUT}" && sha256sum "${NAME}-AutoInstaller.tar.gz" > "${NAME}-AutoInstaller.tar.gz.sha256")
# Release-Notizen: Abschnitt dieser Version aus CHANGELOG.md
awk -v v="## ${V}" '$0==v{f=1;next} /^## /{if(f)exit} f' "${ROOT}/CHANGELOG.md" > "${OUT}/RELEASE_NOTES.md"
echo "Fertig: ${OUT}/${NAME}-AutoInstaller.tar.gz"
cat "${OUT}/${NAME}-AutoInstaller.tar.gz.sha256"
