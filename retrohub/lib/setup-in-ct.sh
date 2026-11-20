#!/usr/bin/env bash
# RetroHub 9.1.1 – Einrichtung IM Container. Wird von install.sh per "pct exec" aufgerufen.
# Aufruf: setup-in-ct.sh <staging-verzeichnis>
# Umgebungsvariablen: RH_VERSION, RH_TLS (0|1), RH_HOSTNAME, RH_ADDR, RH_FORCE_APT (0|1), RH_UNATTENDED (0|1),
#                     RH_APT_PROXY, RH_GAMES (0|1), RH_GAMES_MIRROR
set -Eeuo pipefail
STAGE=${1:?Staging-Verzeichnis fehlt}
RH_VERSION=${RH_VERSION:-unbekannt}; RH_TLS=${RH_TLS:-1}; RH_HOSTNAME=${RH_HOSTNAME:-$(hostname)}
RH_ADDR=${RH_ADDR:-}; RH_FORCE_APT=${RH_FORCE_APT:-0}; RH_UNATTENDED=${RH_UNATTENDED:-1}; RH_APT_PROXY=${RH_APT_PROXY:-}
RH_GAMES=${RH_GAMES:-1}; RH_GAMES_MIRROR=${RH_GAMES_MIRROR:-}; RH_EMULATORS=${RH_EMULATORS:-all}
WEBROOT=/var/www/retrohub; TLSDIR=/etc/retrohub/tls; OPT=/opt/retrohub; DATA=/var/lib/retrohub; SVC_USER=retrohub
export DEBIAN_FRONTEND=noninteractive LC_ALL=C.UTF-8 LANG=C.UTF-8
log() { printf '[container] %s\n' "$*"; }
warn() { printf '[container] WARNUNG: %s\n' "$*"; }
fail() { printf '[container] FEHLER: %s\n' "$1" >&2; exit "${2:-1}"; }
trap 'fail "Abbruch in Zeile ${LINENO} (Befehl: ${BASH_COMMAND})" 50' ERR
HAVE_SYSTEMD=0; [[ -d /run/systemd/system ]] && HAVE_SYSTEMD=1

for f in web/index.html server/server.js tools/retrohub-games.js games/sources.json nginx/retrohub-common.conf nginx/retrohub-games.conf systemd/retrohub.service; do
  [[ -f "${STAGE}/${f}" ]] || fail "Datei fehlt im Staging: ${f}" 51
done

# --- 1. Pakete (nur wenn nötig, damit Updates offline funktionieren) ---
[[ -n "${RH_APT_PROXY}" ]] && printf 'Acquire::http::Proxy "%s";\n' "${RH_APT_PROXY}" > /etc/apt/apt.conf.d/01retrohub-proxy
need_apt=0
for bin in nginx openssl node; do command -v "${bin}" >/dev/null 2>&1 || need_apt=1; done
[[ "${RH_UNATTENDED}" == 1 ]] && ! dpkg -s unattended-upgrades >/dev/null 2>&1 && need_apt=1
if [[ "${need_apt}" == 1 || "${RH_FORCE_APT}" == 1 ]]; then
  log "Paketlisten aktualisieren"
  ok=0
  for attempt in 1 2 3; do
    if apt-get -o Acquire::Retries=3 -q update; then ok=1; break; fi
    log "apt-get update fehlgeschlagen (Versuch ${attempt}/3), neuer Versuch in 5 s"; sleep 5
  done
  [[ "${ok}" == 1 ]] || fail "Paketquellen nicht erreichbar. Netzwerk/DNS/Gateway des Containers prüfen oder APT_PROXY setzen." 30
  pkgs=(nginx openssl ca-certificates nodejs)
  [[ "${RH_UNATTENDED}" == 1 ]] && pkgs+=(unattended-upgrades)
  log "Pakete installieren: ${pkgs[*]}"
  apt-get -q install -y --no-install-recommends "${pkgs[@]}" || fail "Paketinstallation fehlgeschlagen" 31
else
  log "Pakete bereits vorhanden, apt wird übersprungen"
fi
node -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' || fail "Node.js $(node -v) ist zu alt (mindestens 18 nötig; Debian 12 oder neuer verwenden)" 32
log "Node.js $(node -v)"
if [[ "${RH_UNATTENDED}" == 1 ]]; then
  printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades
fi

# --- 2. Dienstkonto und Verzeichnisse ---
id -u "${SVC_USER}" >/dev/null 2>&1 || useradd --system --home-dir "${DATA}" --no-create-home --shell /usr/sbin/nologin "${SVC_USER}"
install -d -m 0711 -o "${SVC_USER}" -g "${SVC_USER}" "${DATA}"
install -d -m 0700 -o "${SVC_USER}" -g "${SVC_USER}" "${DATA}/data" "${DATA}/quarantine" "${DATA}/games-cache"
install -d -m 0755 -o "${SVC_USER}" -g "${SVC_USER}" "${DATA}/games"
install -d -m 0750 -o "${SVC_USER}" -g "${SVC_USER}" "${DATA}/roms" "${DATA}/library" "${DATA}/bios"
install -d -m 0755 -o "${SVC_USER}" -g "${SVC_USER}" "${DATA}/emu"

# --- 3. Anwendung (/opt/retrohub) und Webdateien atomar austauschen ---
swap_dir() { # $1 = Ziel, $2 = neues Verzeichnis
  rm -rf "$1.old"; [[ -d "$1" ]] && mv "$1" "$1.old"; mv "$2" "$1"; rm -rf "$1.old"
}
log "Server nach ${OPT} installieren"
NEWOPT="${OPT}.new"; rm -rf "${NEWOPT}"; install -d "${NEWOPT}" "${NEWOPT}/games"
cp -r "${STAGE}/server" "${STAGE}/tools" "${STAGE}/tests" "${STAGE}/emu" "${NEWOPT}/"; cp "${STAGE}/games/sources.json" "${NEWOPT}/games/"; cp "${STAGE}/VERSION" "${NEWOPT}/"
[[ -f "${STAGE}/README.md" ]] && cp "${STAGE}/README.md" "${NEWOPT}/"
chown -R root:root "${NEWOPT}"; find "${NEWOPT}" -type d -exec chmod 0755 {} +; find "${NEWOPT}" -type f -exec chmod 0644 {} +
chmod 0755 "${NEWOPT}/tools/"*.js
swap_dir "${OPT}" "${NEWOPT}"
printf '#!/bin/sh\nexec runuser -u %s -- /usr/bin/env NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt node %s/tools/retrohub-games.js "$@" --data %s\n' "${SVC_USER}" "${OPT}" "${DATA}" > /usr/local/bin/retrohub-games
printf '#!/bin/sh\nexec /usr/bin/env node %s/tools/retrohub-cli.js "$@"\n' "${OPT}" > /usr/local/bin/retrohub-cli
chmod 0755 /usr/local/bin/retrohub-games /usr/local/bin/retrohub-cli

log "Webdateien installieren nach ${WEBROOT}"
install -d -m 0755 /var/www
NEW="${WEBROOT}.new"; rm -rf "${NEW}"; cp -r "${STAGE}/web" "${NEW}"

# --- 4. TLS mit lokaler CA ---
if [[ "${RH_TLS}" == 1 ]]; then
  install -d -m 0700 "${TLSDIR}"
  if [[ ! -s "${TLSDIR}/ca.key" || ! -s "${TLSDIR}/ca.crt" ]]; then
    log "Lokale Zertifizierungsstelle erzeugen"
    openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 3650 \
      -subj "/CN=RetroHub lokale CA (${RH_HOSTNAME})" \
      -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" \
      -keyout "${TLSDIR}/ca.key" -out "${TLSDIR}/ca.crt" 2>/dev/null
  fi
  san="DNS:${RH_HOSTNAME},DNS:${RH_HOSTNAME}.local,DNS:localhost,IP:127.0.0.1"
  [[ -n "${RH_ADDR}" ]] && san+=",IP:${RH_ADDR}"
  current=""
  [[ -s "${TLSDIR}/server.crt" ]] && current=$(openssl x509 -in "${TLSDIR}/server.crt" -noout -ext subjectAltName 2>/dev/null | tail -n +2 | tr -d ' ' || true)
  wanted=$(printf '%s' "${san}" | sed 's/IP:/IPAddress:/g')
  if [[ "${current}" != "${wanted}" ]] || ! openssl x509 -checkend 2592000 -noout -in "${TLSDIR}/server.crt" >/dev/null 2>&1; then
    log "Serverzertifikat ausstellen (${san})"
    openssl req -new -newkey rsa:2048 -nodes -sha256 -subj "/CN=${RH_HOSTNAME}" -keyout "${TLSDIR}/server.key" -out "${TLSDIR}/server.csr" 2>/dev/null
    printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=%s\n' "${san}" > "${TLSDIR}/server.ext"
    openssl x509 -req -in "${TLSDIR}/server.csr" -CA "${TLSDIR}/ca.crt" -CAkey "${TLSDIR}/ca.key" -CAcreateserial \
      -days 825 -sha256 -extfile "${TLSDIR}/server.ext" -out "${TLSDIR}/server.crt" 2>/dev/null
    rm -f "${TLSDIR}/server.csr"
  fi
  chmod 0600 "${TLSDIR}"/*.key
  install -m 0644 "${TLSDIR}/ca.crt" "${NEW}/retrohub-ca.crt"
fi

# --- 5. Statusdatei und Webroot tauschen ---
# shellcheck source=/dev/null
os=$(. /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-unbekannt}")
json_str() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
tls_json=false; [[ "${RH_TLS}" == 1 ]] && tls_json=true
printf '{"version":"%s","installedAt":"%s","hostname":"%s","address":"%s","tls":%s,"os":"%s","nginx":"aktiv"}\n' \
  "$(json_str "${RH_VERSION}")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(json_str "${RH_HOSTNAME}")" "$(json_str "${RH_ADDR}")" \
  "${tls_json}" "$(json_str "${os}")" > "${NEW}/health.json"
chown -R root:root "${NEW}"; find "${NEW}" -type d -exec chmod 0755 {} +; find "${NEW}" -type f -exec chmod 0644 {} +
swap_dir "${WEBROOT}" "${NEW}"

# --- 6. Spiele nachladen (Quarantäne, Prüfsumme, Freigabe) ---
if [[ "${RH_GAMES}" == 1 ]]; then
  if [[ -d "${STAGE}/games-cache" ]] && compgen -G "${STAGE}/games-cache/*.tgz" >/dev/null; then
    log "Emulator-Pakete aus mitgebrachtem Zwischenspeicher übernehmen"
    install -o "${SVC_USER}" -g "${SVC_USER}" -m 0644 "${STAGE}"/games-cache/*.tgz "${DATA}/games-cache/"
  fi
  log "Emulatoren nachladen und prüfen (${RH_EMULATORS})"
  margs=(); [[ -n "${RH_GAMES_MIRROR}" ]] && margs=(--mirror "${RH_GAMES_MIRROR}")
  if [[ "${RH_EMULATORS}" != all ]]; then margs+=(--only "emulatorjs,${RH_EMULATORS}"); fi
  # Systemzertifikate zusätzlich nutzen (z. B. Firmen-Proxy mit eigener CA)
  ca_env=(); [[ -s /etc/ssl/certs/ca-certificates.crt ]] && ca_env=(NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt)
  if runuser -u "${SVC_USER}" -- env "${ca_env[@]}" node "${OPT}/tools/retrohub-games.js" install --sources "${OPT}/games/sources.json" --data "${DATA}" "${margs[@]}"; then grc=0; else grc=$?; fi
  case "${grc}" in
    0) log "Emulatoren installiert" ;;
    2) warn "Nicht alle Emulatoren konnten geladen werden. Nachholen: Admin-Bereich (Emulatoren) oder 'retrohub-games install'." ;;
    *) warn "Emulatoren-Nachladen fehlgeschlagen (Exitcode ${grc}). RetroHub läuft, Spiele starten aber erst mit Emulatoren." ;;
  esac
else
  log "Emulatoren-Nachladen ist abgeschaltet (GAMES=0)"
fi

# --- 7. RetroHub-Dienst ---
http_status() { # $1 Port, $2 Pfad, [$3 Zusatzheader] – nur die Statuszeile (ohne Pipe, kein SIGPIPE-Risiko)
  local line=""
  exec 4<>"/dev/tcp/127.0.0.1/$1" || return 1
  printf 'GET %s HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n%s\r\n' "$2" "${3:-}" >&4
  IFS= read -r -t 5 line <&4 || true
  exec 4>&-
  printf '%s' "${line%$'\r'}"
}
http_get() { # $1 Port, $2 Pfad, [$3 Zusatzheader]
  local resp
  exec 3<>"/dev/tcp/127.0.0.1/$1" || return 1
  printf 'GET %s HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n%s\r\n' "$2" "${3:-}" >&3
  resp=$(timeout 5 cat <&3 || true); exec 3>&-
  printf '%s' "${resp}"
}
log "RetroHub-Dienst einrichten"
if [[ "${HAVE_SYSTEMD}" == 1 ]]; then
  install -m 0644 "${STAGE}/systemd/retrohub.service" /etc/systemd/system/retrohub.service
  systemctl daemon-reload; systemctl enable retrohub >/dev/null 2>&1
  systemctl restart retrohub || true
  sleep 2
  if ! systemctl is-active --quiet retrohub; then
    warn "Dienst startet mit voller Härtung nicht (häufig in älteren Containern) – reduzierte Härtung wird gesetzt"
    install -d /etc/systemd/system/retrohub.service.d
    printf '[Service]\nPrivateTmp=no\nProtectSystem=no\nProtectHome=no\nReadWritePaths=\n' > /etc/systemd/system/retrohub.service.d/compat.conf
    systemctl daemon-reload; systemctl restart retrohub || true; sleep 2
    systemctl is-active --quiet retrohub || { journalctl -u retrohub -n 30 --no-pager || true; fail "RetroHub-Dienst startet nicht" 45; }
  fi
else
  # Fallback ohne systemd (Testumgebungen)
  if [[ -s /run/retrohub-server.pid ]]; then kill "$(cat /run/retrohub-server.pid)" 2>/dev/null || true; sleep 0.5; fi
  runuser -u "${SVC_USER}" -- env RETROHUB_DATA="${DATA}" NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt nohup node "${OPT}/server/server.js" >>/var/log/retrohub-server.log 2>&1 &
  echo $! > /run/retrohub-server.pid
  sleep 1.5
fi
ok=0
for _ in $(seq 1 15); do [[ "$(http_get 3000 /api/health)" == "HTTP/1.1 200"* ]] && { ok=1; break; }; sleep 1; done
[[ "${ok}" == 1 ]] || fail "RetroHub-Server antwortet nicht auf 127.0.0.1:3000" 46

# --- 8. nginx konfigurieren ---
log "nginx konfigurieren"
install -d /etc/nginx/snippets /etc/nginx/sites-available /etc/nginx/sites-enabled
install -m 0644 "${STAGE}/nginx/retrohub-common.conf" /etc/nginx/snippets/retrohub-common.conf
install -m 0644 "${STAGE}/nginx/retrohub-games.conf" /etc/nginx/snippets/retrohub-games.conf
v6=0; [[ -e /proc/net/if_inet6 ]] && v6=1
server_block() { # $1 Port, $2 ssl(0|1), $3 Snippet
  echo "server {"
  if [[ "$2" == 1 ]]; then echo "    listen $1 ssl;"; [[ "${v6}" == 1 ]] && echo "    listen [::]:$1 ssl;"
  else echo "    listen $1;"; [[ "${v6}" == 1 ]] && echo "    listen [::]:$1;"; fi
  echo "    server_name _;"
  if [[ "$2" == 1 ]]; then
    echo "    ssl_certificate ${TLSDIR}/server.crt;"; echo "    ssl_certificate_key ${TLSDIR}/server.key;"
    echo "    ssl_protocols TLSv1.2 TLSv1.3;"; echo "    ssl_session_cache shared:RetroHubTLS:2m;"; echo "    ssl_session_timeout 1h;"
  fi
  echo "    include snippets/$3;"
  echo "}"
}
{
  echo "# RetroHub ${RH_VERSION} – erzeugt von setup-in-ct.sh"
  server_block "80 default_server" 0 retrohub-common.conf
  server_block 8080 0 retrohub-games.conf
  if [[ "${RH_TLS}" == 1 ]]; then server_block "443 default_server" 1 retrohub-common.conf; server_block 8443 1 retrohub-games.conf; fi
} > /etc/nginx/sites-available/retrohub
ln -sfn /etc/nginx/sites-available/retrohub /etc/nginx/sites-enabled/retrohub
rm -f /etc/nginx/sites-enabled/default
nginx -t || fail "nginx-Konfiguration ist ungültig (siehe Ausgabe oben)" 40
if [[ "${HAVE_SYSTEMD}" == 1 ]]; then
  systemctl enable nginx >/dev/null 2>&1; systemctl restart nginx || fail "nginx konnte nicht gestartet werden: journalctl -u nginx" 41
else
  if [[ -s /run/nginx.pid ]] && kill -0 "$(cat /run/nginx.pid)" 2>/dev/null; then nginx -s reload; else nginx; fi
  sleep 1
fi

# --- 9. Selbsttest ---
ok=0
for _ in 1 2 3 4 5; do r=$(http_get 80 / || true); [[ "${r}" == "HTTP/1.1 200"* && "${r}" == *"<title>RetroHub</title>"* ]] && { ok=1; break; }; sleep 1; done
[[ "${ok}" == 1 ]] || fail "Selbsttest: Startseite liefert nicht RetroHub" 42
[[ "$(http_status 80 /assets/app.js)" == "HTTP/1.1 200"* ]] || fail "Selbsttest: /assets/app.js nicht erreichbar" 43
[[ "$(http_status 80 /gibt-es-nicht)" == "HTTP/1.1 404"* ]] || fail "Selbsttest: unbekannte URL liefert keine 404" 44
[[ "$(http_get 80 /api/health)" == *'"ok":true'* ]] || fail "Selbsttest: API über nginx nicht erreichbar" 47
ws=$(http_status 80 /ws $'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n')
[[ "${ws}" == "HTTP/1.1 401"* ]] || fail "Selbsttest: WebSocket-Weiterleitung fehlerhaft (${ws})" 48
cores=0; [[ -s "${DATA}/emu-manifest.json" ]] && cores=$(node -e 'const m=require(process.argv[1]);console.log((m.packages||[]).filter(p=>p.core).length)' "${DATA}/emu-manifest.json")
[[ "$(http_status 8080 /../roms/)" != "HTTP/1.1 200"* ]] || fail "Selbsttest: Datenverzeichnis ist öffentlich erreichbar" 50
[[ "$(http_status 8080 /_emu/host.html)" == "HTTP/1.1 200"* ]] || fail "Selbsttest: Emulator-Seite (Port 8080) nicht erreichbar" 51
if [[ -s "${DATA}/emu/ejs/loader.js" ]]; then [[ "$(http_status 8080 /_emu/ejs/loader.js)" == "HTTP/1.1 200"* ]] || fail "Selbsttest: Emulator-Dateien nicht erreichbar" 52; fi
[[ "$(http_status 8080 '/socket.io/?EIO=4&transport=polling')" == "HTTP/1.1 200"* ]] || fail "Selbsttest: Netplay (Socket.IO) über Port 8080 nicht erreichbar" 53
[[ "$(http_status 8080 /netplay/list)" == "HTTP/1.1 401"* ]] || fail "Selbsttest: Netplay-Raumliste nicht geschützt" 54
import_info="kein Import-Ordner"; [[ -d /srv/retrohub-import ]] && import_info="Import-Ordner /srv/retrohub-import"
log "Selbsttest erfolgreich (App, Assets, 404, API, WebSocket, Emulator-Seite, Netplay, ${cores} Emulator-Kerne, ${import_info})"
games=${cores}
printf 'RH_GAMES_INSTALLED=%s\n' "${games}"
if [[ -s "${DATA}/data/setup-code" ]]; then printf 'RH_SETUP_CODE=%s\n' "$(cat "${DATA}/data/setup-code")"; fi
