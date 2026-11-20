# RetroHub

**Deine eigene Retro-Spielesammlung im Heimnetz.** RetroHub läuft als Container auf Proxmox VE und macht deine Spieldateien im Browser spielbar – auf Laptop, Handy und Fernseher. Ohne Cloud, ohne Konto bei Dritten, offline.

[Installationsleitfaden](INSTALLATIONSLEITFADEN.md) · [Änderungen](CHANGELOG.md) · [Testbericht](docs/TESTBERICHT.md) · [English summary](README.en.md)

![Startseite von RetroHub](docs/screenshots/start.png)

> [!IMPORTANT]
> RetroHub enthält **keine Spiele, ROMs oder BIOS-Dateien** und lädt auch keine aus dem Internet. Du fügst nur Dateien hinzu, an denen du die Rechte hast – zum Beispiel Sicherungen eigener Module, Homebrew oder frei lizenzierte Spiele.

## Was RetroHub kann

| | |
|---|---|
| **Emulatoren** | 35 Systeme im Browser (EmulatorJS 4.2.3), offline – von NES bis PlayStation Portable |
| **Spiele hinzufügen** | Upload bis 2 GB, Download von einer URL oder Import aus einem NAS-Ordner; mehrere Dateien je Spiel (z. B. CUE + BIN) |
| **Bibliothek** | Cover, Beschreibung, Jahr, Genre, Suche und Filter; mehrere Discs je Spiel mit Disc-Wechsel |
| **Spielstände** | Auf dem Server, drei Speicherplätze, automatisches Speichern beim Beenden, „Weiterspielen“ auf jedem Gerät |
| **Kinderprofile** | Altersfreigabe je Spiel; Kinder sehen nur Freigegebenes, Eltern stellen die Grenze ein |
| **Couch-Modus** | Ein Bildschirm zeigt das Spiel, bis zu vier Handys werden per QR-Code zu Controllern |
| **Netplay** | Gemeinsam spielen, jede Person am eigenen Gerät – über einen eigenen Server im Heimnetz *(experimentell)* |
| **Gemeinsam** | Konten, Freunde, Chat, Mitteilungen, Turniere |
| **Betrieb** | Installer mit Trockenlauf, Update ohne Datenverlust, tägliche Sicherung, vollständige Sicherung mit Spieldateien, Installation ohne Internet |

<p align="center">
  <img src="docs/screenshots/bibliothek.png" alt="Spielebibliothek mit Cover und Systemkürzeln" width="62%">
  <img src="docs/screenshots/controller.png" alt="Handy als Controller im Couch-Modus" width="22%">
</p>

## Unterstützte Systeme

| Hersteller | Systeme |
|---|---|
| Nintendo | NES, SNES, Nintendo 64, Game Boy / Color, Game Boy Advance, Nintendo DS, Virtual Boy |
| Sony | PlayStation, PlayStation Portable |
| Sega | Master System, Mega Drive, Game Gear, Mega-CD, 32X, Saturn |
| Atari | 2600, 5200, 7800, Lynx, Jaguar |
| Weitere Konsolen | PC Engine, PC-FX, Neo Geo Pocket, WonderSwan, ColecoVision, 3DO |
| Arcade | FinalBurn Neo, MAME 2003+ |
| Computer | Amiga, Commodore 64, C128, PET, Plus/4, VIC-20, MS-DOS |

Nicht möglich im Browser: GameCube, Wii und PlayStation 2. Mega-CD, Lynx, PC-FX, ColecoVision und 3DO brauchen eine BIOS-Datei des Original-Geräts.

## Installation in Kürze

Voraussetzung: ein Proxmox-VE-Host (Version 8 oder neuer) mit Internetzugang für die Erstinstallation.

1. Unter **[Releases](../../releases)** die Dateien `RetroHub-vX.Y.Z-AutoInstaller.tar.gz` und `….tar.gz.sha256` herunterladen und auf den Proxmox-Host kopieren.
2. In der Shell des Proxmox-Hosts:
   ```bash
   sha256sum -c RetroHub-v*-AutoInstaller.tar.gz.sha256
   tar -xzf RetroHub-v*-AutoInstaller.tar.gz
   cd RetroHub-v*/
   ./install.sh --dry-run
   ./install.sh
   ```
3. Im Browser die angezeigte Adresse öffnen, mit dem **Einrichtungscode** das Admin-Konto anlegen und unter **Administration → Spiele hinzufügen** loslegen.

Alle Optionen, NAS-Import, Installation ohne Internet, Update, Fehlerbehebung: **[Installationsleitfaden](INSTALLATIONSLEITFADEN.md)**.

## Wie es aufgebaut ist

- Ein **Installer** auf dem Proxmox-Host legt einen unprivilegierten LXC-Container (Debian) an, richtet nginx, den RetroHub-Server (Node.js) und HTTPS mit lokaler Zertifizierungsstelle ein und prüft am Ende alles mit einem Selbsttest.
- Die **Emulatoren** werden bei der Installation aus der npm-Registry geladen, per SHA-256 geprüft und laufen danach ohne Internet. Sie laufen auf einem eigenen, von der App getrennten Ursprung (Port 8080/8443).
- **Sicherheit:** strenge Content-Security-Policy, keine Anfragen ins Internet zur Laufzeit, Uploads und Importe nur für Admins, Altersfreigabe serverseitig durchgesetzt. Details in [SECURITY.md](SECURITY.md).

## Stand

RetroHub wurde gegen eine nachgebildete Proxmox-Umgebung und in Chromium getestet – mit Spielen auf NES, Game Boy Advance, Nintendo DS und PSP. Rückmeldungen von echten Proxmox-Hosts, aus Firefox, Safari und von Mobilgeräten sind sehr willkommen: bitte als [Issue](../../issues).

## Mitmachen

Fehlermeldungen und Verbesserungen sind willkommen – siehe [CONTRIBUTING.md](CONTRIBUTING.md). Bitte niemals Spieldateien, ROMs oder BIOS-Dateien in Issues oder Pull Requests anhängen.

## Lizenz

RetroHub steht unter der [MIT-Lizenz](LICENSE). Emulatoren und Kerne werden bei der Installation geladen und stehen unter ihren eigenen Lizenzen (EmulatorJS: GPL-3.0) – siehe [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Alle genannten Marken gehören ihren Inhabern. RetroHub steht in keiner Verbindung zu Nintendo, Sony, Sega, Atari oder anderen Herstellern.
