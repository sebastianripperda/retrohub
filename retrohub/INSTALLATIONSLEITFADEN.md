# Installationsleitfaden

Dieser Leitfaden führt Schritt für Schritt durch Installation, Einrichtung und Betrieb von RetroHub auf Proxmox VE.

**Inhalt**
1. [Voraussetzungen](#1-voraussetzungen)
2. [Installer herunterladen und auf den Host bringen](#2-installer-herunterladen-und-auf-den-host-bringen)
3. [Prüfen und Trockenlauf](#3-prüfen-und-trockenlauf)
4. [Installieren](#4-installieren)
5. [Erste Einrichtung im Browser](#5-erste-einrichtung-im-browser)
6. [Spiele hinzufügen](#6-spiele-hinzufügen)
7. [Konten und Kinderprofile](#7-konten-und-kinderprofile)
8. [Spielen, Couch-Modus und Netplay](#8-spielen-couch-modus-und-netplay)
9. [Spiele von der NAS (Import-Ordner)](#9-spiele-von-der-nas-import-ordner)
10. [Installation ohne Internet](#10-installation-ohne-internet)
11. [Aktualisieren](#11-aktualisieren)
12. [Sicherung und Wiederherstellung](#12-sicherung-und-wiederherstellung)
13. [Entfernen](#13-entfernen)
14. [Alle Installer-Optionen](#14-alle-installer-optionen)
15. [Fehlerbehebung](#15-fehlerbehebung)

---

## 1. Voraussetzungen

| | |
|---|---|
| **Proxmox VE** | Version 8 oder neuer, Zugriff auf die Shell des Hosts als `root` |
| **Ressourcen** | Standard: 2 CPU-Kerne, 1 GB RAM, 16 GB Speicher (für Emulatoren rund 0,2 GB, der Rest für deine Spiele) |
| **Storage** | Ein Storage für Container (Standard `local-lvm`) und einer für Vorlagen (Standard `local`) |
| **Netzwerk** | Netzwerkbrücke (Standard `vmbr0`) mit DHCP oder einer festen Adresse; Internet für die Erstinstallation |
| **Browser** | Aktueller Chrome, Edge, Firefox oder Safari. PSP und MS-DOS brauchen ein leistungsfähiges Gerät |

RetroHub ist für das **Heimnetz** gedacht. Mach es nicht direkt aus dem Internet erreichbar.

---

## 2. Installer herunterladen und auf den Host bringen

Auf der Seite **Releases** dieses Repositorys liegen zu jeder Version zwei Dateien:

- `RetroHub-vX.Y.Z-AutoInstaller.tar.gz` – der Installer
- `RetroHub-vX.Y.Z-AutoInstaller.tar.gz.sha256` – die Prüfsumme

**Weg A – direkt auf dem Host (am einfachsten):** In der Proxmox-Weboberfläche den Host auswählen → **Shell**. Auf der Releases-Seite mit der rechten Maustaste auf die Datei klicken → „Link kopieren“, dann in der Shell:

```bash
cd /root
wget <kopierter Link zur .tar.gz>
wget <kopierter Link zur .sha256>
```

**Weg B – vom eigenen Rechner kopieren:** Beide Dateien herunterladen und per `scp` übertragen …

```bash
scp RetroHub-v*-AutoInstaller.tar.gz* root@<proxmox-ip>:/root/
```

… oder unter Windows mit [WinSCP](https://winscp.net) in den Ordner `/root` ziehen.

---

## 3. Prüfen und Trockenlauf

```bash
cd /root
sha256sum -c RetroHub-v*-AutoInstaller.tar.gz.sha256     # muss „OK“ melden
tar -xzf RetroHub-v*-AutoInstaller.tar.gz
cd RetroHub-v*/
./install.sh --dry-run
```

Der **Trockenlauf** prüft alles, ohne etwas zu verändern: Proxmox-Version, Storage und freien Platz, Netzwerkbrücke, freie Container-ID, Vorlage und die Prüfsummen aller Paketdateien. Am Ende steht, was angelegt würde. Erscheint ein **FEHLER**, nennt der Installer die Ursache – siehe auch [Fehlerbehebung](#15-fehlerbehebung).

> Bitte immer das **Release-Archiv** verwenden, nicht den Quellcode aus dem Repository („Code → Download ZIP“). Dem Quellcode fehlen Prüfsummen und Abhängigkeiten; der Installer weist darauf hin.

---

## 4. Installieren

Mit Standardwerten (DHCP, nächste freie Container-ID):

```bash
./install.sh
```

Häufige Varianten – Optionen werden einfach vor den Befehl geschrieben:

```bash
# feste Container-ID
VMID=120 ./install.sh

# feste IP-Adresse im VLAN 10
VMID=120 IP_CONFIG=192.168.10.50/24 GATEWAY=192.168.10.1 VLAN=10 ./install.sh

# mit Spieleordner von der NAS (siehe Abschnitt 9)
VMID=120 IMPORT_DIR=/mnt/pve/nas/spiele ./install.sh

# mehr Platz für viele Disc-Spiele
VMID=120 ROOT_DISK_GB=64 ./install.sh
```

Der Installer legt den Container an, installiert nginx und Node.js, lädt die Emulatoren (rund 200 MB, jede Datei per SHA-256 geprüft), richtet HTTPS ein und führt einen **Selbsttest** durch. Das dauert je nach Leitung 3 bis 10 Minuten. Geht etwas schief, wird der halbfertige Container wieder entfernt.

Am Ende erscheint eine Zusammenfassung, zum Beispiel:

```
RetroHub 9.1.1 ist installiert.

  Container   120 (retrohub), unprivilegiert, Autostart an
  Aufrufen    http://192.168.1.50/
              https://192.168.1.50/  (Zertifikat der lokalen CA: http://192.168.1.50/retrohub-ca.crt)
  Emulatoren  32 Kerne installiert (Ports 8080/8443)
  …
  Einrichtungscode: 7KQ2-M9XA
```

Der Installer schreibt ein Protokoll nach `/var/log/retrohub-install-<datum>.log` auf dem Host.

---

## 5. Erste Einrichtung im Browser

1. Die angezeigte Adresse im Browser öffnen.
2. **Zertifikatswarnung:** RetroHub verwendet eine eigene, lokale Zertifizierungsstelle. Du kannst die Warnung einmalig bestätigen – oder sie dauerhaft beseitigen, indem du das Zertifikat unter `http://<adresse>/retrohub-ca.crt` herunterlädst und auf deinen Geräten als vertrauenswürdige Zertifizierungsstelle installierst. Ohne Verschlüsselung funktioniert auch `http://<adresse>/`.
3. Den **Einrichtungscode** eingeben und das erste Konto anlegen. Es wird **Administrator**.

Einrichtungscode vergessen? Auf dem Proxmox-Host:

```bash
pct exec <VMID> -- retrohub-cli setup-code
```

---

## 6. Spiele hinzufügen

RetroHub bringt **keine Spiele** mit. Unter **Administration → Spiele hinzufügen** gibt es drei Wege. Bei jedem bestätigst du, dass du die Rechte an den Dateien besitzt.

| Weg | Wann sinnvoll |
|---|---|
| **Upload** | Dateien vom eigenen Rechner, bis 2 GB je Datei. Mehrere Dateien auf einmal ergeben ein Spiel (z. B. `spiel.cue` + `spiel.bin`) |
| **Von URL** | Die Datei liegt auf einem eigenen Webserver oder einer NAS mit Web-Freigabe. Der Server lädt sie im Hintergrund |
| **Aus Ordner** | Viele Spiele von der NAS. Dateien werden nicht kopiert, sondern dort gelesen (siehe [Abschnitt 9](#9-spiele-von-der-nas-import-ordner)) |

Wichtig dabei:

- **System richtig wählen.** Die Dateiendung muss zum System passen (z. B. `.sfc` für SNES, `.gba` für Game Boy Advance, `.cue`/`.chd` für PlayStation). Archive (`.zip`, `.7z`) sind für alle Systeme erlaubt; bei **Arcade** muss die ZIP-Datei den Original-Romset-Namen tragen.
- **Einstufen.** Unter **Administration → Spiele → Bearbeiten** eine **Altersfreigabe** wählen. **Nicht eingestufte Spiele sind für Kinderprofile unsichtbar.** Dort lassen sich auch Titel, Beschreibung, Jahr, Genre und ein **Cover** (PNG, JPEG oder WebP bis 2 MB) setzen.
- **Mehrere Discs:** Jede Disc einzeln hinzufügen, dann bei Disc 1 unter **Bearbeiten → Weitere Disc übernehmen** die anderen zusammenführen. Bei PlayStation wechselst du die Disc im Emulator-Menü.
- **BIOS:** Mega-CD, Lynx, PC-FX, ColecoVision und 3DO starten erst mit einer BIOS-Datei des Original-Geräts – **Administration → BIOS-Dateien**. Welche Datei gebraucht wird, steht dort jeweils dabei.

---

## 7. Konten und Kinderprofile

- **Weitere Erwachsene:** Unter **Administration → Konten** anlegen oder unter **Registrierung** die Selbstanmeldung öffnen.
- **Kinderprofile** legen Erwachsene unter **Profil → Kinderprofile** an (mit kurzer PIN). Dort stellst du auch die **Freigabegrenze** ein: Spiele ab 0, 6, 12 oder 16 (Standard: ab 6). Kinder sehen und starten nur Spiele bis zu dieser Grenze – auch im Couch-Modus und beim Netplay.
- **Passwort vergessen:** Ein Admin setzt es unter **Administration → Konten** zurück. Für das Admin-Konto selbst auf dem Proxmox-Host:
  ```bash
  pct exec <VMID> -- retrohub-cli reset-password <benutzername>
  ```

---

## 8. Spielen, Couch-Modus und Netplay

- **Steuerung:** Tastatur, Gamepad (per USB oder Bluetooth am jeweiligen Gerät) oder Touch-Steuerung auf dem Handy. Die Tastenbelegung lässt sich im Emulator-Menü (Zahnrad) anpassen.
- **Spielstände:** Im Spiel unten auf **Spielstände** – drei Speicherplätze. Beim Schließen speichert RetroHub automatisch; beim nächsten Start erscheint **Weiterspielen**, auch auf einem anderen Gerät.
- **Couch-Modus:** Am Fernseher oder Laptop **Couch-Modus** öffnen, Spiel wählen, **Session starten**. Bis zu vier Handys scannen den QR-Code (oder geben den Code unter **Controller** ein) und werden zu Controllern. Dann **Spiel auf diesem Bildschirm starten**.
- **Netplay (experimentell):** Jede Person spielt am eigenen Gerät. Spiel öffnen → in der Emulator-Leiste das Globus-Symbol → **Raum erstellen**. Andere sehen den Raum unter **Netplay** und treten bei. Braucht ein stabiles Netz und auf allen Geräten genug Leistung; für das Spielen an einem Bildschirm ist der Couch-Modus die robustere Wahl.

---

## 9. Spiele von der NAS (Import-Ordner)

RetroHub kann einen Ordner des Proxmox-Hosts **nur lesend** einbinden – zum Beispiel eine NAS-Freigabe, die in Proxmox bereits als Storage eingebunden ist (`/mnt/pve/<name>/…`).

**Bei der Installation:**

```bash
IMPORT_DIR=/mnt/pve/nas/spiele ./install.sh
```

**Nachträglich** für einen bestehenden Container:

```bash
pct set <VMID> -mp0 /mnt/pve/nas/spiele,mp=/srv/retrohub-import,ro=1
pct reboot <VMID>
```

**Berechtigungen:** Der Container ist unprivilegiert und sieht Host-Dateien als „andere“. Ordner brauchen daher Lese- und Ausführungsrecht, Dateien Leserecht für alle:

```bash
chmod -R o+rX /mnt/pve/nas/spiele
```

Bei NFS- oder SMB-Freigaben werden die Rechte oft auf der NAS festgelegt – dort Lesezugriff für alle aktivieren (bzw. die Freigabe entsprechend einhängen). Der Installer prüft die Lesbarkeit und nennt eine betroffene Datei, falls etwas nicht passt.

Danach unter **Administration → Spiele hinzufügen → Aus Ordner → Ordner einlesen**: Dateien auswählen, System und Titel prüfen, **Ausgewählte importieren**. Zu einer `.cue`-Datei gehörende `.bin`-Dateien werden automatisch mitgenommen.

---

## 10. Installation ohne Internet

Auf einem Rechner **mit** Internet (Linux, macOS mit Bash, WSL oder der Proxmox-Host selbst, solange er Internet hat) die Emulator-Pakete vorab laden – das Skript liegt im entpackten Release:

```bash
tools/emulatoren-vorab-laden.sh /pfad/emulator-pakete                       # alle, ca. 200 MB
tools/emulatoren-vorab-laden.sh /pfad/emulator-pakete core-fceumm,core-mgba  # nur Auswahl
```

Den Ordner auf den Proxmox-Host bringen. Die Debian-Vorlage muss dort bereits vorhanden sein (Proxmox-Weboberfläche → Storage `local` → **CT-Vorlagen** → **Vorlagen** → Debian 12 laden). Dann:

```bash
GAMES_DIR=/pfad/emulator-pakete ./install.sh
```

---

## 11. Aktualisieren

1. Empfohlen: vorher eine Sicherung des Containers anlegen (Proxmox → Container → **Backup → Jetzt sichern**).
2. Neues Release herunterladen, prüfen und entpacken wie in Abschnitt 2 und 3.
3. Im neuen Ordner:
   ```bash
   VMID=<id> ./install.sh --update
   ```

Konten, Spiele, Cover, BIOS, Spielstände und Einstellungen bleiben erhalten. Fehlende oder aktualisierte Emulatoren werden nachgeladen; der Selbsttest läuft erneut.

---

## 12. Sicherung und Wiederherstellung

| Art | Inhalt | Wo |
|---|---|---|
| **Automatisch** | Konten, Daten, Spielstände – täglich | im Container unter `/var/lib/retrohub/data/backups` |
| **Sicherung** | wie oben, als Datei | Administration → **Sicherung herunterladen** |
| **Vollständige Sicherung** | zusätzlich hochgeladene Spieldateien, Cover und BIOS (TAR, kann mehrere GB groß sein) | Administration → **Vollständige Sicherung herunterladen** |
| **Proxmox-Backup** | der ganze Container | Proxmox → Container → Backup (vzdump) |

Wiederherstellen: **Administration → Wiederherstellen …** (normale Sicherung) bzw. **Vollständig wiederherstellen …** (TAR). Vor jeder Wiederherstellung legt RetroHub automatisch eine Sicherung des aktuellen Stands an. Spiele aus dem Import-Ordner sind nicht enthalten – sie liegen ja auf der NAS.

---

## 13. Entfernen

```bash
VMID=<id> ./install.sh --uninstall
```

Der Installer fragt nach (**ja** eingeben) und entfernt nur Container, die er selbst angelegt hat (Kennzeichnung `retrohub`). Dabei werden **alle Daten im Container gelöscht** – vorher sichern. Dateien im Import-Ordner auf der NAS bleiben unberührt.

---

## 14. Alle Installer-Optionen

Optionen werden als Umgebungsvariablen vor den Befehl geschrieben, z. B. `VMID=120 CORES=4 ./install.sh`. Übersicht jederzeit mit `./install.sh --help`.

| Option | Bedeutung | Standard |
|---|---|---|
| `VMID` | Container-ID | nächste freie |
| `CT_HOSTNAME` | Hostname | `retrohub` |
| `STORAGE` | Storage für die Root-Disk | `local-lvm` |
| `TEMPLATE_STORAGE` | Storage für Vorlagen | `local` |
| `TEMPLATE` | Vorlage, z. B. `debian-12-standard_12.7-1_amd64.tar.zst` | automatisch |
| `BRIDGE` | Netzwerkbrücke | `vmbr0` |
| `VLAN` | VLAN-Tag 1–4094 | kein VLAN |
| `IP_CONFIG` | `dhcp` oder IPv4/CIDR, z. B. `192.168.1.50/24` | `dhcp` |
| `GATEWAY` | IPv4-Gateway, Pflicht bei fester IP | – |
| `IP6_CONFIG` | leer, `auto`, `dhcp` oder IPv6/CIDR | leer |
| `NAMESERVER`, `SEARCHDOMAIN` | DNS-Server und Suchdomain | vom Host |
| `CORES` | CPU-Kerne | `2` |
| `MEMORY` | RAM in MiB (mindestens 256) | `1024` |
| `SWAP` | Swap in MiB | `512` |
| `ROOT_DISK_GB` | Speicher in GiB (mindestens 4) | `16` |
| `ONBOOT` | Mit dem Host starten (0/1) | `1` |
| `TLS` | HTTPS mit lokaler Zertifizierungsstelle (0/1) | `1` |
| `UNATTENDED_UPGRADES` | Automatische Sicherheitsupdates (0/1) | `1` |
| `APT_PROXY` | APT-Proxy, z. B. `http://192.168.1.10:3142` | – |
| `GAMES` | Emulatoren bei der Installation laden (0/1) | `1` |
| `EMULATORS` | `all` oder Auswahl, z. B. `core-fceumm,core-snes9x,core-mgba` | `all` |
| `GAMES_MIRROR` | Eigene Quelle für Emulator-Pakete statt npm | – |
| `GAMES_DIR` | Ordner mit vorab geladenen Emulator-Paketen | – |
| `IMPORT_DIR` | Ordner mit Spieldateien, nur lesend eingebunden | – |
| `SSH_PUBLIC_KEY_FILE` | Öffentlicher SSH-Schlüssel für root im Container | – |
| `NET_TIMEOUT` | Sekunden Wartezeit auf das Netzwerk | `90` |
| `KEEP_ON_FAILURE` | `1` = Container bei Fehler zur Analyse behalten | `0` |

Schalter: `--dry-run` (nur prüfen), `--update` (aktualisieren), `--uninstall` (entfernen), `--yes` (Rückfragen automatisch bestätigen), `--help`.

**Ports im Container:** 80/443 für die App, 8080/8443 für Emulatoren und Netplay. Wenn eine Firewall dazwischen liegt, alle vier freigeben.

---

## 15. Fehlerbehebung

| Problem | Lösung |
|---|---|
| `CORES` / `MEMORY` „ungültig“ | Der Wert ist größer als der Host hergibt – kleineren Wert angeben, z. B. `CORES=1`. |
| Storage nicht gefunden oder zu wenig Platz | `pvesm status` zeigt die vorhandenen Storages; mit `STORAGE=…` einen passenden wählen oder `ROOT_DISK_GB` verkleinern. |
| „Dies ist ein Quellcode-Stand“ | Es wurde der Quellcode statt des Release-Archivs entpackt – Datei aus **Releases** verwenden. |
| „Prüfsummen stimmen nicht“ | Download unvollständig oder verändert – erneut herunterladen. |
| Keine IP-Adresse per DHCP | DHCP-Server und Brücke prüfen oder feste Adresse: `IP_CONFIG=… GATEWAY=…`. |
| „vom Host nicht erreichbar“ | Der Container läuft, aber der Host erreicht ihn nicht – Firewall oder VLAN prüfen. Im Container selbst lief der Selbsttest erfolgreich. |
| Installation bricht ab, Ursache unklar | Protokoll unter `/var/log/retrohub-install-*.log` ansehen; mit `KEEP_ON_FAILURE=1 ./install.sh` bleibt der Container zur Analyse erhalten. |
| Spiel zeigt „Emulator fehlt“ | **Administration → Emulatoren → Laden** (oder „Alle fehlenden laden“). |
| Spiel zeigt „BIOS fehlt“ | **Administration → BIOS-Dateien** – eigene BIOS-Datei hochladen. |
| Spiel startet nicht | System und Dateiformat prüfen (z. B. Arcade nur mit passendem Romset, CD-Spiele als CUE+BIN oder CHD). Manche Spiele laufen mit einzelnen Kernen nicht. |
| PSP oder MS-DOS startet nicht oder ruckelt | Aktuellen Browser verwenden; diese Systeme brauchen ein leistungsfähiges Gerät. |
| Kind sieht ein Spiel nicht | Das Spiel ist nicht eingestuft oder liegt über der Freigabegrenze – unter **Administration → Spiele → Bearbeiten** einstufen bzw. Grenze im **Profil** anheben. |
| Import-Ordner leer oder Dateien fehlen | Berechtigungen prüfen (siehe [Abschnitt 9](#9-spiele-von-der-nas-import-ordner)); nur Dateien mit bekannten Endungen werden angezeigt. |
| Upload bricht ab | Größengrenze des Systems beachten (z. B. Game Boy 8 MB, PlayStation 2 GB); bei großen Dateien stabile Verbindung. |
| Dienst neu starten oder Protokoll ansehen | `pct exec <VMID> -- systemctl restart retrohub` · `pct exec <VMID> -- journalctl -u retrohub -n 100` |

Hilft das nicht weiter, freue ich mich über ein [Issue](../../issues) mit Version, Installer-Ausgabe oder Protokoll (Passwörter und Einrichtungscodes vorher entfernen).
