#!/usr/bin/env bash
# =============================================================================
# RetroHub 9.1.1 – Installer für Proxmox VE (unprivilegierter LXC: nginx, RetroHub-Server, Emulatoren)
#
#   ./install.sh                 Neuinstallation (Werte per Umgebungsvariable)
#   ./install.sh --dry-run       Nur prüfen und anzeigen, nichts verändern
#   ./install.sh --update        Webdateien/Konfiguration in bestehendem CT erneuern
#   ./install.sh --uninstall     RetroHub-Container entfernen (fragt nach)
#   ./install.sh --help          Hilfe
#
# Beispiel:  VMID=920 IP_CONFIG=192.168.1.50/24 GATEWAY=192.168.1.1 ./install.sh
# =============================================================================
set -Eeuo pipefail
umask 022

readonly RH_VERSION="9.1.1"
DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
readonly DIR

# ---------- Standardwerte (alle per Umgebungsvariable überschreibbar) --------
VMID=${VMID:-}
CT_HOSTNAME=${CT_HOSTNAME:-retrohub}
STORAGE=${STORAGE:-local-lvm}
TEMPLATE_STORAGE=${TEMPLATE_STORAGE:-local}
TEMPLATE=${TEMPLATE:-}
BRIDGE=${BRIDGE:-vmbr0}
VLAN=${VLAN:-}
IP_CONFIG=${IP_CONFIG:-dhcp}
GATEWAY=${GATEWAY:-}
IP6_CONFIG=${IP6_CONFIG:-}
NAMESERVER=${NAMESERVER:-}
SEARCHDOMAIN=${SEARCHDOMAIN:-}
CORES=${CORES:-2}
MEMORY=${MEMORY:-1024}
SWAP=${SWAP:-512}
ROOT_DISK_GB=${ROOT_DISK_GB:-16}
ONBOOT=${ONBOOT:-1}
TLS=${TLS:-1}
UNATTENDED_UPGRADES=${UNATTENDED_UPGRADES:-1}
APT_PROXY=${APT_PROXY:-}
GAMES=${GAMES:-1}
GAMES_MIRROR=${GAMES_MIRROR:-}
GAMES_DIR=${GAMES_DIR:-}
EMULATORS=${EMULATORS:-all}
IMPORT_DIR=${IMPORT_DIR:-}
SSH_PUBLIC_KEY_FILE=${SSH_PUBLIC_KEY_FILE:-}
NET_TIMEOUT=${NET_TIMEOUT:-90}
KEEP_ON_FAILURE=${KEEP_ON_FAILURE:-0}
LOG_DIR=${LOG_DIR:-/var/log}
SYS_NET=${RH_SYS_NET:-/sys/class/net}   # nur für automatisierte Tests überschreibbar

MODE=install; DRY_RUN=0; ASSUME_YES=0; SETUP_CODE=""; GAMES_INSTALLED=""
CREATED=0; SUCCESS=0; TMP=""; CT_IP=""; LOG_FILE=""

# ---------- Ausgabe ----------------------------------------------------------
if [[ -t 1 ]]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; else B=""; G=""; Y=""; R=""; N=""; fi
step() { printf '\n%s==> %s%s\n' "${B}" "$*" "${N}"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '    %s✔%s %s\n' "${G}" "${N}" "$*"; }
warn() { printf '    %s!%s %s\n' "${Y}" "${N}" "$*" >&2; }
die()  { printf '\n%sFEHLER:%s %s\n' "${R}" "${N}" "$1" >&2; exit "${2:-1}"; }

usage() {
  cat <<USAGE
RetroHub ${RH_VERSION} – Installer für Proxmox VE

Aufruf:  ./install.sh [--dry-run] [--update] [--uninstall] [--yes] [--help]

Einstellungen über Umgebungsvariablen (Standardwert in Klammern):
  VMID                Container-ID (nächste freie ID)
  CT_HOSTNAME         Hostname (retrohub)
  STORAGE             Storage für die Root-Disk (local-lvm)
  TEMPLATE_STORAGE    Storage für Templates (local)
  TEMPLATE            Template-Datei, z. B. debian-12-standard_12.7-1_amd64.tar.zst (automatisch)
  BRIDGE              Netzwerkbrücke (vmbr0)
  VLAN                VLAN-Tag 1–4094 (leer = kein VLAN)
  IP_CONFIG           dhcp oder IPv4/CIDR, z. B. 192.168.1.50/24 (dhcp)
  GATEWAY             IPv4-Gateway, Pflicht bei statischer IP
  IP6_CONFIG          leer, auto, dhcp oder IPv6/CIDR (leer)
  NAMESERVER          DNS-Server, mehrere mit Leerzeichen (vom Host)
  SEARCHDOMAIN        Suchdomain (vom Host)
  CORES               CPU-Kerne (2)
  MEMORY              RAM in MiB, mindestens 256 (1024)
  SWAP                Swap in MiB (512)
  ROOT_DISK_GB        Root-Disk in GiB, mindestens 4 (16) – Platz für Emulatoren (~0,2 GB) und hochgeladene Spiele
  ONBOOT              Autostart mit dem Host, 0 oder 1 (1)
  TLS                 HTTPS mit lokaler CA, 0 oder 1 (1)
  UNATTENDED_UPGRADES automatische Sicherheitsupdates, 0 oder 1 (1)
  APT_PROXY           APT-Proxy, z. B. http://192.168.1.10:3142 (leer)
  GAMES               Emulatoren bei der Installation nachladen, 0 oder 1 (1)
  EMULATORS           all oder Auswahl, z. B. core-fceumm,core-snes9x,core-mgba (all)
  GAMES_MIRROR        eigene Quelle für Emulator-Pakete statt npm, z. B. http://nas.lan/retrohub (leer)
  GAMES_DIR           Ordner auf dem Host mit vorab geladenen Emulator-Paketen (*.tgz), siehe
                      tools/emulatoren-vorab-laden.sh – für Installationen ohne Internet (leer)
  IMPORT_DIR          Ordner auf dem Host mit Spieldateien (z. B. NAS-Freigabe); wird nur lesend
                      nach /srv/retrohub-import eingebunden und im Admin-Bereich importiert (leer)
  SSH_PUBLIC_KEY_FILE öffentlicher SSH-Schlüssel für root (leer)
  NET_TIMEOUT         Sekunden Wartezeit auf Netzwerk/DHCP (90)
  KEEP_ON_FAILURE     1 = Container bei Fehler zur Analyse behalten (0)

Beispiele:
  ./install.sh --dry-run
  VMID=920 ./install.sh
  VMID=920 IP_CONFIG=192.168.10.50/24 GATEWAY=192.168.10.1 VLAN=10 ./install.sh
  VMID=920 ./install.sh --update
USAGE
}

# ---------- Aufräumen bei Fehlern -------------------------------------------
on_exit() {
  local rc=$?
  [[ -n "${TMP}" && -d "${TMP}" ]] && rm -rf "${TMP}"
  if [[ "${SUCCESS}" != 1 && "${CREATED}" == 1 ]]; then
    if [[ "${KEEP_ON_FAILURE}" == 1 ]]; then
      warn "Container ${VMID} bleibt zur Analyse erhalten (KEEP_ON_FAILURE=1). Entfernen: pct stop ${VMID}; pct destroy ${VMID} --purge"
    else
      printf '\n%s==> Rollback:%s halbfertigen Container %s entfernen\n' "${Y}" "${N}" "${VMID}" >&2
      pct stop "${VMID}" >/dev/null 2>&1 || true
      if pct destroy "${VMID}" --purge 1 >/dev/null 2>&1 || pct destroy "${VMID}" >/dev/null 2>&1; then
        printf '    Container %s wurde entfernt. Die Installation kann erneut gestartet werden.\n' "${VMID}" >&2
      else
        printf '    Container %s konnte nicht entfernt werden: pct destroy %s --purge\n' "${VMID}" "${VMID}" >&2
      fi
    fi
  fi
  if [[ "${SUCCESS}" != 1 && "${rc}" != 0 && -n "${LOG_FILE}" ]]; then printf '    Protokoll: %s\n' "${LOG_FILE}" >&2; fi
  exit "${rc}"
}
on_err() { printf '\n%sFEHLER:%s Befehl fehlgeschlagen (Zeile %s, Exitcode %s): %s\n' "${R}" "${N}" "$2" "$1" "${BASH_COMMAND}" >&2; }
trap 'on_err $? ${LINENO}' ERR
trap on_exit EXIT
trap 'exit 130' INT TERM

# ---------- Validierung ------------------------------------------------------
is_uint() { [[ "$1" =~ ^[0-9]+$ ]]; }
in_range() { is_uint "$1" && (( 10#$1 >= $2 && 10#$1 <= $3 )); }
valid_ipv4() {
  local ip=$1 o; [[ "${ip}" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  for o in "${BASH_REMATCH[@]:1}"; do [[ "${o}" =~ ^(0|[1-9][0-9]*)$ ]] && (( o <= 255 )) || return 1; done
}
ip2int() { local IFS=.; read -r a b c d <<<"$1"; echo $(( (a << 24) + (b << 16) + (c << 8) + d )); }
valid_ipv6_cidr() { local p; [[ "$1" =~ ^[0-9a-fA-F:]+:[0-9a-fA-F:]*/([0-9]{1,3})$ ]] || return 1; p=$(( 10#${BASH_REMATCH[1]} )); (( p >= 1 && p <= 128 )); }
valid_hostname() { [[ ${#1} -le 63 && "$1" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$ ]]; }

ERRORS=()
err() { ERRORS+=("$1"); }

validate_inputs() {
  step "Eingaben prüfen"
  [[ -z "${VMID}" ]] || in_range "${VMID}" 100 999999999 || err "VMID '${VMID}' ist ungültig (Zahl 100–999999999)."
  valid_hostname "${CT_HOSTNAME}" || err "CT_HOSTNAME '${CT_HOSTNAME}' ist ungültig (Buchstaben, Ziffern, Bindestrich, max. 63 Zeichen)."
  local host_cpus host_mem
  host_cpus=$(nproc 2>/dev/null || echo 1)
  host_mem=$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
  in_range "${CORES}" 1 "${host_cpus}" || err "CORES '${CORES}' ist ungültig (1–${host_cpus})."
  if ! is_uint "${MEMORY}" || (( 10#${MEMORY} < 256 )); then err "MEMORY '${MEMORY}' ist ungültig (mindestens 256 MiB)."
  elif (( host_mem > 0 && 10#${MEMORY} > host_mem )); then err "MEMORY ${MEMORY} MiB übersteigt den Host-RAM (${host_mem} MiB)."; fi
  in_range "${SWAP}" 0 65536 || err "SWAP '${SWAP}' ist ungültig (0–65536 MiB)."
  in_range "${ROOT_DISK_GB}" 4 4096 || err "ROOT_DISK_GB '${ROOT_DISK_GB}' ist ungültig (4–4096 GiB)."
  in_range "${NET_TIMEOUT}" 10 900 || err "NET_TIMEOUT '${NET_TIMEOUT}' ist ungültig (10–900 Sekunden)."
  local flag
  for flag in ONBOOT TLS UNATTENDED_UPGRADES KEEP_ON_FAILURE GAMES; do [[ "${!flag}" =~ ^[01]$ ]] || err "${flag} muss 0 oder 1 sein."; done
  [[ "${BRIDGE}" =~ ^[a-zA-Z0-9_.-]{1,15}$ ]] || err "BRIDGE '${BRIDGE}' ist ungültig."
  [[ -z "${VLAN}" ]] || in_range "${VLAN}" 1 4094 || err "VLAN '${VLAN}' ist ungültig (1–4094 oder leer)."
  if [[ "${IP_CONFIG}" != dhcp ]]; then
    local ip="" pfx=0
    if [[ "${IP_CONFIG}" =~ ^([^/]+)/([0-9]{1,2})$ ]]; then ip=${BASH_REMATCH[1]}; pfx=$(( 10#${BASH_REMATCH[2]} )); fi
    if [[ -n "${ip}" ]] && valid_ipv4 "${ip}" && (( pfx >= 1 && pfx <= 32 )); then
      if [[ -z "${GATEWAY}" ]]; then err "Bei statischer IP ist GATEWAY Pflicht (sonst erreicht der Container keine Paketquellen)."
      elif ! valid_ipv4 "${GATEWAY}"; then err "GATEWAY '${GATEWAY}' ist keine gültige IPv4-Adresse."
      else
        local mask=$(( (0xFFFFFFFF << (32 - pfx)) & 0xFFFFFFFF ))
        (( ($(ip2int "${ip}") & mask) == ($(ip2int "${GATEWAY}") & mask) )) || err "GATEWAY ${GATEWAY} liegt nicht im Netz ${IP_CONFIG}."
        [[ "${ip}" != "${GATEWAY}" ]] || err "IP-Adresse und GATEWAY sind identisch."
      fi
    else
      err "IP_CONFIG '${IP_CONFIG}' ist ungültig (dhcp oder z. B. 192.168.1.50/24)."
    fi
  elif [[ -n "${GATEWAY}" ]]; then
    warn "GATEWAY wird bei DHCP ignoriert."
  fi
  if [[ -n "${IP6_CONFIG}" && ! "${IP6_CONFIG}" =~ ^(auto|dhcp)$ ]] && ! valid_ipv6_cidr "${IP6_CONFIG}"; then err "IP6_CONFIG '${IP6_CONFIG}' ist ungültig (leer, auto, dhcp oder IPv6/CIDR)."; fi
  local ns
  for ns in ${NAMESERVER//,/ }; do valid_ipv4 "${ns}" || [[ "${ns}" =~ ^[0-9a-fA-F:]+$ && "${ns}" == *:* ]] || err "NAMESERVER-Eintrag '${ns}' ist keine IP-Adresse."; done
  [[ -z "${SEARCHDOMAIN}" || "${SEARCHDOMAIN}" =~ ^[a-zA-Z0-9.-]+$ ]] || err "SEARCHDOMAIN '${SEARCHDOMAIN}' ist ungültig."
  [[ -z "${APT_PROXY}" || "${APT_PROXY}" =~ ^https?://[^[:space:]\"]+$ ]] || err "APT_PROXY muss mit http:// oder https:// beginnen."
  [[ -z "${GAMES_MIRROR}" || "${GAMES_MIRROR}" =~ ^https?://[^[:space:]\"]+$ ]] || err "GAMES_MIRROR muss mit http:// oder https:// beginnen."
  [[ -z "${GAMES_DIR}" || -d "${GAMES_DIR}" ]] || err "GAMES_DIR '${GAMES_DIR}' ist kein Verzeichnis."
  [[ -z "${IMPORT_DIR}" || -d "${IMPORT_DIR}" ]] || err "IMPORT_DIR '${IMPORT_DIR}' ist kein Verzeichnis auf dem Host."
  [[ -z "${IMPORT_DIR}" || "${IMPORT_DIR}" == /* ]] || err "IMPORT_DIR muss ein absoluter Pfad sein."
  [[ "${IMPORT_DIR}" != *,* ]] || err "IMPORT_DIR darf kein Komma enthalten (Proxmox-Mountpoint-Syntax)."
  [[ "${EMULATORS}" == all || "${EMULATORS}" =~ ^core-[a-z0-9_]+(,core-[a-z0-9_]+)*$ ]] || err "EMULATORS muss 'all' oder eine Liste wie core-fceumm,core-snes9x sein."
  [[ -z "${SSH_PUBLIC_KEY_FILE}" || -r "${SSH_PUBLIC_KEY_FILE}" ]] || err "SSH_PUBLIC_KEY_FILE '${SSH_PUBLIC_KEY_FILE}' ist nicht lesbar."
  [[ -z "${TEMPLATE}" || "${TEMPLATE}" =~ ^[a-zA-Z0-9._-]+\.tar\.(zst|gz|xz)$ ]] || err "TEMPLATE '${TEMPLATE}' ist kein gültiger Template-Dateiname."
}

check_host() {
  step "Proxmox-Host prüfen"
  [[ ${EUID} -eq 0 ]] || die "Bitte als root auf dem Proxmox-Host ausführen." 11
  local c
  for c in pct pveam pvesm pvesh pveversion; do command -v "${c}" >/dev/null 2>&1 || die "'${c}' fehlt – das ist kein Proxmox-VE-Host." 12; done
  local ver major
  ver=$(pveversion 2>/dev/null | sed -n 's#^pve-manager/\([0-9][0-9.]*\).*#\1#p' | head -n1)
  major=${ver%%.*}
  [[ -n "${major}" ]] || die "Proxmox-Version nicht erkennbar (pveversion)." 13
  (( major >= 7 )) || die "Proxmox VE ${ver} wird nicht unterstützt (mindestens 7.x)." 13
  PVE_MAJOR=${major}; ok "Proxmox VE ${ver}"
  for c in tar sha256sum; do command -v "${c}" >/dev/null 2>&1 || die "'${c}' fehlt auf dem Host." 12; done
}

check_package() {
  step "Paketinhalt prüfen"
  local f
  for f in web/index.html web/assets/app.js web/assets/app.css lib/setup-in-ct.sh nginx/retrohub-common.conf nginx/retrohub-games.conf server/server.js server/lib/systems.js emu/host.html emu/host.js tools/retrohub-games.js games/sources.json systemd/retrohub.service; do
    [[ -f "${DIR}/${f}" ]] || die "Datei fehlt im Paket: ${f}" 14
  done
  if [[ ! -f "${DIR}/SHA256SUMS" || ! -f "${DIR}/server/node_modules/socket.io/package.json" ]]; then
    # Typischer Fall: direkt aus einem Git-Klon gestartet – dort fehlen Prüfsummen und Abhängigkeiten.
    if [[ -d "${DIR}/.git" || -f "${DIR}/scripts/build-release.sh" ]]; then
      die "Dies ist ein Quellcode-Stand (Git-Klon), kein Release-Paket. Bitte das Release-Archiv von GitHub verwenden oder selbst bauen: scripts/build-release.sh (benötigt Node.js und npm), danach das Archiv aus dist/ entpacken und dort ./install.sh starten." 15
    fi
    [[ -f "${DIR}/SHA256SUMS" ]] || die "SHA256SUMS fehlt im Paket." 15
    die "Abhängigkeit socket.io fehlt im Paket (server/node_modules). Bitte das vollständige Release-Archiv verwenden." 15
  fi
  (cd "${DIR}" && sha256sum --quiet -c SHA256SUMS) || die "Prüfsummen stimmen nicht – Paket beschädigt oder verändert." 15
  ok "Prüfsummen aller Paketdateien korrekt"
}

storage_active() { # $1=Name $2=Inhaltstyp
  pvesm status --content "$2" 2>/dev/null | awk -v s="$1" 'NR>1 && $1==s && $3=="active" {f=1} END{exit !f}'
}

check_resources() {
  step "Ressourcen prüfen"
  storage_active "${STORAGE}" rootdir || die "Storage '${STORAGE}' existiert nicht, ist inaktiv oder erlaubt keine Container-Disks. Verfügbar: $(pvesm status --content rootdir 2>/dev/null | awk 'NR>1{printf "%s ",$1}')" 21
  ok "Storage ${STORAGE} (Container-Disks)"
  storage_active "${TEMPLATE_STORAGE}" vztmpl || die "Template-Storage '${TEMPLATE_STORAGE}' existiert nicht oder erlaubt keine Templates. Verfügbar: $(pvesm status --content vztmpl 2>/dev/null | awk 'NR>1{printf "%s ",$1}')" 22
  ok "Template-Storage ${TEMPLATE_STORAGE}"
  local avail
  avail=$(pvesm status --content rootdir 2>/dev/null | awk -v s="${STORAGE}" 'NR>1 && $1==s {print $6}')
  if is_uint "${avail:-x}" && (( avail / 1024 / 1024 < ROOT_DISK_GB )); then
    warn "Auf ${STORAGE} sind nur $(( avail / 1024 / 1024 )) GiB frei (angefordert ${ROOT_DISK_GB} GiB)."
  fi
  if [[ ! -d "${SYS_NET}/${BRIDGE}" ]]; then
    local found=(); local d; for d in "${SYS_NET}"/vmbr*; do [[ -e "${d}" ]] && found+=("${d##*/}"); done
    die "Bridge '${BRIDGE}' existiert nicht. Vorhanden: ${found[*]:-keine vmbr-Bridge}" 23
  fi
  if [[ -d "${SYS_NET}/${BRIDGE}/bridge" ]]; then ok "Bridge ${BRIDGE}"
  elif command -v ovs-vsctl >/dev/null 2>&1 && ovs-vsctl br-exists "${BRIDGE}" 2>/dev/null; then ok "Bridge ${BRIDGE} (Open vSwitch)"
  else die "'${BRIDGE}' ist keine Linux- oder OVS-Bridge." 23; fi
  [[ -z "${VLAN}" ]] || ok "VLAN-Tag ${VLAN}"
  if [[ -n "${IMPORT_DIR}" ]]; then
    # Der unprivilegierte Container sieht Host-Dateien als „andere“: Ordner brauchen r+x, Dateien r für alle.
    local unreadable
    unreadable=$(find "${IMPORT_DIR}" -maxdepth 4 \( -type d ! -perm -o=rx -o -type f ! -perm -o=r \) -print -quit 2>/dev/null || true)
    if [[ -n "${unreadable}" ]]; then
      warn "Im Import-Ordner ist nicht alles für den Container lesbar, z. B.: ${unreadable}"
      warn "Abhilfe auf dem Host: chmod -R o+rX '${IMPORT_DIR}'  (oder passende ACLs/ID-Mapping)"
    else
      ok "Import-Ordner ${IMPORT_DIR} ist für den Container lesbar"
    fi
  fi
}

ct_exists() { pct status "$1" >/dev/null 2>&1 || compgen -G "/etc/pve/nodes/*/lxc/$1.conf" >/dev/null || compgen -G "/etc/pve/nodes/*/qemu-server/$1.conf" >/dev/null; }
is_retrohub_ct() { pct config "$1" 2>/dev/null | grep -Eq '^tags:.*\bretrohub\b'; }

check_vmid() {
  if [[ -z "${VMID}" ]]; then
    VMID=$(pvesh get /cluster/nextid 2>/dev/null) || die "Keine freie VMID ermittelbar (pvesh get /cluster/nextid)." 24
    ok "Nächste freie VMID: ${VMID}"; return
  fi
  if ct_exists "${VMID}" || ! pvesh get /cluster/nextid --vmid "${VMID}" >/dev/null 2>&1; then
    if is_retrohub_ct "${VMID}"; then die "VMID ${VMID} ist bereits ein RetroHub-Container. Aktualisieren mit: VMID=${VMID} ./install.sh --update" 20; fi
    die "VMID ${VMID} ist bereits belegt (Container oder VM im Cluster). Andere VMID wählen oder VMID weglassen." 20
  fi
  ok "VMID ${VMID} ist frei"
}

select_template() {
  step "Template wählen"
  local list
  list=$(pveam list "${TEMPLATE_STORAGE}" 2>/dev/null | awk 'NR>1{print $1}' | sed 's#^.*vztmpl/##' || true)
  if [[ -z "${TEMPLATE}" ]]; then
    local prefs=(debian-12-standard)
    (( PVE_MAJOR >= 9 )) && prefs=(debian-13-standard debian-12-standard)
    local p
    for p in "${prefs[@]}"; do
      TEMPLATE=$(grep -E "^${p}_" <<<"${list}" | sort -V | tail -n1 || true)
      [[ -n "${TEMPLATE}" ]] && { ok "Lokal vorhanden: ${TEMPLATE} (kein Download nötig)"; return; }
    done
    if [[ "${DRY_RUN}" == 1 ]]; then info "Template würde aus dem Proxmox-Katalog geladen (${prefs[*]})."; TEMPLATE="<${prefs[0]}-aktuell>"; return; fi
    info "Kein passendes Template lokal – Katalog aktualisieren"
    pveam update >/dev/null || die "Template-Katalog nicht erreichbar (keine Internetverbindung?). Template manuell nach ${TEMPLATE_STORAGE} laden oder TEMPLATE setzen." 25
    local avail
    avail=$(pveam available --section system 2>/dev/null | awk '{print $2}')
    for p in "${prefs[@]}"; do
      TEMPLATE=$(grep -E "^${p}_" <<<"${avail}" | sort -V | tail -n1 || true)
      [[ -n "${TEMPLATE}" ]] && break
    done
    [[ -n "${TEMPLATE}" ]] || die "Kein Debian-Template im Katalog gefunden (${prefs[*]})." 25
  elif grep -Fxq "${TEMPLATE}" <<<"${list}"; then
    ok "Lokal vorhanden: ${TEMPLATE}"; return
  elif [[ "${DRY_RUN}" == 1 ]]; then
    info "Template ${TEMPLATE} würde heruntergeladen."; return
  fi
  info "Lade ${TEMPLATE} nach ${TEMPLATE_STORAGE}"
  pveam download "${TEMPLATE_STORAGE}" "${TEMPLATE}" || die "Download von ${TEMPLATE} fehlgeschlagen." 25
  pveam list "${TEMPLATE_STORAGE}" 2>/dev/null | grep -Fq "vztmpl/${TEMPLATE}" || die "Template ${TEMPLATE} nach dem Download nicht auffindbar." 25
  ok "Template ${TEMPLATE} bereit"
}

build_create_args() {
  local net0="name=eth0,bridge=${BRIDGE},ip=${IP_CONFIG}"
  [[ "${IP_CONFIG}" != dhcp ]] && net0+=",gw=${GATEWAY}"
  [[ -n "${IP6_CONFIG}" ]] && net0+=",ip6=${IP6_CONFIG}"
  [[ -n "${VLAN}" ]] && net0+=",tag=${VLAN}"
  CREATE_ARGS=("${VMID}" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}"
    --hostname "${CT_HOSTNAME}" --ostype debian --unprivileged 1 --features nesting=1
    --cores "${CORES}" --memory "${MEMORY}" --swap "${SWAP}"
    --rootfs "${STORAGE}:${ROOT_DISK_GB}" --net0 "${net0}"
    --onboot "${ONBOOT}" --tags retrohub
    --description "RetroHub ${RH_VERSION} - installiert $(date '+%Y-%m-%d %H:%M')")
  [[ -n "${NAMESERVER}" ]] && CREATE_ARGS+=(--nameserver "${NAMESERVER//,/ }")
  [[ -n "${SEARCHDOMAIN}" ]] && CREATE_ARGS+=(--searchdomain "${SEARCHDOMAIN}")
  [[ -n "${SSH_PUBLIC_KEY_FILE}" ]] && CREATE_ARGS+=(--ssh-public-keys "${SSH_PUBLIC_KEY_FILE}")
  [[ -n "${IMPORT_DIR}" ]] && CREATE_ARGS+=(--mp0 "${IMPORT_DIR},mp=/srv/retrohub-import,ro=1")
  return 0
}

wait_for_ct() {
  local i
  for (( i = 0; i < 30; i++ )); do pct exec "${VMID}" -- true >/dev/null 2>&1 && return 0; sleep 1; done
  die "Container ${VMID} reagiert nach dem Start nicht." 26
}

wait_for_network() {
  step "Auf Netzwerk warten (max. ${NET_TIMEOUT} s)"
  local deadline=$(( SECONDS + NET_TIMEOUT ))
  CT_IP=""
  while (( SECONDS < deadline )); do
    CT_IP=$(pct exec "${VMID}" -- ip -4 -o addr show dev eth0 scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1 || true)
    [[ -n "${CT_IP}" ]] && break
    sleep 2
  done
  [[ -n "${CT_IP}" ]] || die "Container hat keine IPv4-Adresse erhalten. DHCP-Server, Bridge '${BRIDGE}'${VLAN:+ und VLAN ${VLAN}} prüfen oder IP_CONFIG statisch setzen." 27
  ok "IPv4-Adresse: ${CT_IP}"
  if ! pct exec "${VMID}" -- ip route show default 2>/dev/null | grep -q default; then
    warn "Keine Default-Route im Container – Paketinstallation wird vermutlich scheitern."
  fi
  if [[ -z "${APT_PROXY}" ]] && ! pct exec "${VMID}" -- sh -c 'command -v nginx' >/dev/null 2>&1; then
    while (( SECONDS < deadline )); do
      pct exec "${VMID}" -- getent hosts deb.debian.org >/dev/null 2>&1 && { ok "DNS funktioniert"; return 0; }
      sleep 2
    done
    die "DNS im Container funktioniert nicht (deb.debian.org nicht auflösbar). NAMESERVER setzen oder APT_PROXY nutzen." 28
  fi
}

push_and_setup() {
  local force_apt=${1:-0}
  step "RetroHub im Container einrichten"
  TMP=$(mktemp -d /tmp/retrohub.XXXXXX)
  local extra=()
  if [[ -n "${GAMES_DIR}" ]] && compgen -G "${GAMES_DIR}/*.tgz" >/dev/null; then
    mkdir -p "${TMP}/games-cache"; cp "${GAMES_DIR}"/*.tgz "${TMP}/games-cache/"; extra=(-C "${TMP}" games-cache)
    info "Emulator-Pakete aus ${GAMES_DIR} werden mitgegeben ($(find "${GAMES_DIR}" -maxdepth 1 -name '*.tgz' | wc -l) Dateien)"
  fi
  tar -czf "${TMP}/payload.tgz" -C "${DIR}" web lib nginx server tools games systemd tests emu VERSION README.md "${extra[@]}"
  pct exec "${VMID}" -- rm -rf /root/retrohub-stage /root/retrohub-payload.tgz
  pct push "${VMID}" "${TMP}/payload.tgz" /root/retrohub-payload.tgz --perms 0600
  pct exec "${VMID}" -- bash -c 'mkdir -p /root/retrohub-stage && tar -xzf /root/retrohub-payload.tgz -C /root/retrohub-stage'
  pct exec "${VMID}" -- env RH_VERSION="${RH_VERSION}" RH_TLS="${TLS}" RH_HOSTNAME="${CT_HOSTNAME}" RH_ADDR="${CT_IP}" \
    RH_FORCE_APT="${force_apt}" RH_UNATTENDED="${UNATTENDED_UPGRADES}" RH_APT_PROXY="${APT_PROXY}" \
    RH_GAMES="${GAMES}" RH_GAMES_MIRROR="${GAMES_MIRROR}" RH_EMULATORS="${EMULATORS}" \
    bash /root/retrohub-stage/lib/setup-in-ct.sh /root/retrohub-stage | tee "${TMP}/setup.out" \
    || die "Einrichtung im Container fehlgeschlagen (Details oben)." 29
  SETUP_CODE=$(sed -n 's/^RH_SETUP_CODE=//p' "${TMP}/setup.out" | tail -n1)
  GAMES_INSTALLED=$(sed -n 's/^RH_GAMES_INSTALLED=//p' "${TMP}/setup.out" | tail -n1)
  pct exec "${VMID}" -- rm -rf /root/retrohub-stage /root/retrohub-payload.tgz
}

verify_from_host() {
  step "Erreichbarkeit vom Host prüfen"
  if ! command -v curl >/dev/null 2>&1; then warn "curl fehlt auf dem Host – Prüfung übersprungen."; return 0; fi
  local body
  body=$(curl -fsS --max-time 8 "http://${CT_IP}/" 2>/dev/null || true)
  if curl -fsS --max-time 8 "http://${CT_IP}/api/health" 2>/dev/null | grep -q '"ok":true'; then ok "RetroHub-Server antwortet (http://${CT_IP}/api/health)"
  else warn "http://${CT_IP}/api/health antwortet nicht vom Host aus."; fi
  if [[ "${body}" == *"<title>RetroHub</title>"* ]]; then ok "http://${CT_IP}/ liefert RetroHub"
  else warn "http://${CT_IP}/ ist vom Host nicht erreichbar (Firewall/VLAN?). Im Container selbst lief der Selbsttest erfolgreich."; fi
  if [[ "${TLS}" == 1 ]]; then
    if curl -fsSk --max-time 8 "https://${CT_IP}/" 2>/dev/null | grep -q '<title>RetroHub</title>'; then ok "https://${CT_IP}/ antwortet (lokale CA)"
    else warn "https://${CT_IP}/ antwortet nicht."; fi
  fi
}

summary() {
  printf '\n%sRetroHub %s ist installiert.%s\n\n' "${G}${B}" "${RH_VERSION}" "${N}"
  printf '  Container   %s (%s), unprivilegiert, Autostart %s\n' "${VMID}" "${CT_HOSTNAME}" "$([[ ${ONBOOT} == 1 ]] && echo an || echo aus)"
  printf '  Aufrufen    http://%s/\n' "${CT_IP}"
  if [[ "${TLS}" == 1 ]]; then
    printf '              https://%s/  (Zertifikat der lokalen CA: http://%s/retrohub-ca.crt)\n' "${CT_IP}" "${CT_IP}"
  fi
  printf '  Emulatoren  %s Kerne installiert (Ports 8080/8443)\n' "${GAMES_INSTALLED:-0}"
  printf '  Spiele      keine vorinstalliert – im Admin-Bereich hinzufügen: Upload, URL oder Import-Ordner\n'
  [[ -n "${IMPORT_DIR}" ]] && printf '  Import      %s → /srv/retrohub-import (nur lesend)\n' "${IMPORT_DIR}"
  printf '  Netplay     experimentell (im Heimnetz getestet, braucht stabile Verbindung); Couch-Modus als robuste Alternative\n'
  if [[ -n "${SETUP_CODE}" ]]; then
    printf '\n  %sEinrichtungscode: %s%s\n' "${B}" "${SETUP_CODE}" "${N}"
    printf '  Öffne RetroHub im Browser und lege mit diesem Code das erste Konto an (es wird Administrator).\n'
    printf '  Code später anzeigen: pct exec %s -- retrohub-cli setup-code\n\n' "${VMID}"
  fi
  printf '  Aktualisieren  VMID=%s ./install.sh --update\n' "${VMID}"
  printf '  Sichern        vzdump %s --mode snapshot   (zusätzlich tägliche Server-Sicherung im Container)\n' "${VMID}"
  printf '  Passwort weg   pct exec %s -- retrohub-cli reset-password <benutzername>\n' "${VMID}"
  printf '  Entfernen      VMID=%s ./install.sh --uninstall\n' "${VMID}"
  [[ "${IP_CONFIG}" == dhcp ]] && printf '\n  Hinweis: Die Adresse kommt per DHCP. Für eine feste Adresse im Router reservieren oder IP_CONFIG setzen.\n'
  printf '  Protokoll   %s\n\n' "${LOG_FILE}"
}

start_log() {
  [[ "${DRY_RUN}" == 1 ]] && return 0
  mkdir -p "${LOG_DIR}" 2>/dev/null || true
  LOG_FILE="${LOG_DIR}/retrohub-install-$(date +%Y%m%d-%H%M%S).log"
  if touch "${LOG_FILE}" 2>/dev/null; then exec > >(tee -a "${LOG_FILE}") 2>&1; else LOG_FILE="(nicht schreibbar)"; fi
}

# ---------- Modi -------------------------------------------------------------
do_install() {
  validate_inputs
  if (( ${#ERRORS[@]} )); then printf '\n%sFEHLER:%s Ungültige Eingaben – es wurde nichts verändert:\n' "${R}" "${N}" >&2; printf '    - %s\n' "${ERRORS[@]}" >&2; exit 10; fi
  ok "Alle Eingaben gültig"
  check_host; check_package; check_resources
  step "VMID prüfen"; check_vmid
  select_template
  build_create_args
  if [[ "${DRY_RUN}" == 1 ]]; then
    step "Trockenlauf – geplanter Befehl"
    local a line="pct create"
    for a in "${CREATE_ARGS[@]}"; do if [[ "${a}" =~ [[:space:]] ]]; then line+=" '${a}'"; else line+=" ${a}"; fi; done
    printf '    %s\n' "${line}"
    info "Es wurde nichts verändert."; SUCCESS=1; return
  fi
  step "Container ${VMID} anlegen"
  pct create "${CREATE_ARGS[@]}" || die "pct create ist fehlgeschlagen." 26
  CREATED=1; ok "Container angelegt"
  pct start "${VMID}" || die "Container ${VMID} startet nicht." 26
  wait_for_ct; ok "Container läuft"
  wait_for_network
  push_and_setup 1
  verify_from_host
  SUCCESS=1; CREATED=0
  summary
}

do_update() {
  [[ -n "${VMID}" ]] || die "Für --update bitte VMID angeben: VMID=920 ./install.sh --update" 10
  in_range "${VMID}" 100 999999999 || die "VMID '${VMID}' ist ungültig." 10
  [[ "${TLS}" =~ ^[01]$ && "${UNATTENDED_UPGRADES}" =~ ^[01]$ ]] || die "TLS und UNATTENDED_UPGRADES müssen 0 oder 1 sein." 10
  check_host; check_package
  pct status "${VMID}" >/dev/null 2>&1 || die "Container ${VMID} existiert nicht." 20
  is_retrohub_ct "${VMID}" || die "Container ${VMID} ist kein RetroHub-Container (Tag 'retrohub' fehlt) – Abbruch zum Schutz fremder Container." 20
  CT_HOSTNAME=$(pct config "${VMID}" | awk -F': ' '/^hostname:/{print $2}')
  [[ "${DRY_RUN}" == 1 ]] && { info "Trockenlauf: Container ${VMID} (${CT_HOSTNAME}) würde aktualisiert."; SUCCESS=1; return; }
  if ! pct status "${VMID}" | grep -q running; then step "Container ${VMID} starten"; pct start "${VMID}"; fi
  wait_for_ct
  CT_IP=$(pct exec "${VMID}" -- ip -4 -o addr show dev eth0 scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1 || true)
  push_and_setup 0
  pct set "${VMID}" --description "RetroHub ${RH_VERSION} - aktualisiert $(date '+%Y-%m-%d %H:%M')" >/dev/null 2>&1 || true
  [[ -n "${CT_IP}" ]] && verify_from_host
  SUCCESS=1; summary
}

do_uninstall() {
  [[ -n "${VMID}" ]] || die "Für --uninstall bitte VMID angeben." 10
  check_host
  pct status "${VMID}" >/dev/null 2>&1 || die "Container ${VMID} existiert nicht." 20
  is_retrohub_ct "${VMID}" || die "Container ${VMID} trägt nicht das Tag 'retrohub' – wird zum Schutz nicht entfernt." 20
  if [[ "${DRY_RUN}" == 1 ]]; then info "Trockenlauf: Container ${VMID} würde entfernt."; SUCCESS=1; return; fi
  if [[ "${ASSUME_YES}" != 1 ]]; then
    read -r -p "Container ${VMID} mit allen Daten unwiderruflich löschen? [ja/NEIN] " answer
    [[ "${answer}" == ja ]] || { info "Abgebrochen."; SUCCESS=1; return; }
  fi
  pct stop "${VMID}" >/dev/null 2>&1 || true
  pct destroy "${VMID}" --purge 1
  SUCCESS=1; ok "Container ${VMID} entfernt"
}

# ---------- Hauptprogramm ----------------------------------------------------
for arg in "$@"; do
  case "${arg}" in
    --dry-run) DRY_RUN=1 ;;
    --update) MODE=update ;;
    --uninstall) MODE=uninstall ;;
    --yes|-y) ASSUME_YES=1 ;;
    --help|-h) usage; SUCCESS=1; exit 0 ;;
    *) usage >&2; die "Unbekannte Option: ${arg}" 2 ;;
  esac
done
PVE_MAJOR=0; CREATE_ARGS=()
start_log
printf '%sRetroHub %s – Proxmox-Installer%s%s\n' "${B}" "${RH_VERSION}" "$([[ ${DRY_RUN} == 1 ]] && echo ' (Trockenlauf)')" "${N}"
case "${MODE}" in
  install) do_install ;;
  update) do_update ;;
  uninstall) do_uninstall ;;
esac
