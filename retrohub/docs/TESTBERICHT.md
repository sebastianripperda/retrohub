# Testbericht RetroHub 9.1.1

Getestet am 16.11.2026: frische Installation aus dem Release-Archiv 9.1.1, alle Testreihen gegen diese Installation. Zusätzlich wurde das Archiv aus dem Git-Repository mit `scripts/build-release.sh` gebaut und daraus installiert (identischer Weg wie die GitHub Action). Die Ergebnisse für 9.1.0 (Update von 9.0.0) gelten unverändert.

Umgebung: Ubuntu 24.04 als Container-Ersatz, nginx 1.24, Node.js 22, Chromium (Playwright) mit Software-Grafik, axe-core 4.10.2, ShellCheck 0.11. Testdateien: ausschließlich frei lizenzierte Homebrew-Programme sowie selbst erzeugte Test-Discs und -Bilder; nicht im Paket.

## Was real und was simuliert getestet wurde

| Teil | Art des Tests |
|---|---|
| Container-Seite: Pakete, Dienst, Server, Download und Prüfung von 33 Emulator-Paketen inkl. Netplay-Korrekturen, TLS, nginx, Selbsttest | **real** (Ubuntu statt Debian; ohne systemd → Ersatzstart) |
| Proxmox-Befehle | **Attrappe** – kein Proxmox-Host verfügbar |
| Bind-Mount des Import-Ordners | Installer-Aufruf geprüft; im Container per Verknüpfung nachgebildet |
| Server, Emulatoren, Spielstände, Couch, Netplay, Altersfreigabe, Cover, Sicherung, Oberfläche | **real**, mehrere Browser gleichzeitig |
| Debian 12/13, systemd-Härtung, HTTPS im Browser, Firefox, Safari, echte Handys/Gamepads/GPU | **nicht getestet** |

## Ergebnisse

| Bereich | Ergebnis |
|---|---|
| Archiv, ShellCheck, Syntax, CSS, HTML, Versionsangaben (`npm run check`) | sauber |
| Release-Bau aus dem Repository (`npm run build`) und Installation daraus | erfolgreich, Selbsttest grün |
| Installer aus einem Git-Klon gestartet | bricht mit Anleitung ab (Release-Archiv verwenden oder bauen) |
| Backend-Test (`tests/api-test.js`) | **145 von 145** |
| Frische Installation aus dem Archiv | 33 Pakete geprüft, 3 Netplay-Korrekturen angewendet, Selbsttest grün |
| Update 9.0.0 → 9.1.0 mit Daten | erfolgreich, Daten erhalten |
| Browsertest Grundfunktionen (Einrichtung, Upload, URL, Ordner, 4 Systeme, Spielstände, Couch mit Handy, Netplay-Raum) | **31 von 31** |
| Browsertest 9.1 (Bearbeiten, Cover, Discs zusammenführen, Kinderkonto mit Freigabe, Grenze im Profil ändern, Vollsicherung) | **12 von 12** |
| Netplay mit zwei Browsern | **8 von 8** – Gleichschritt (beide Bild 291), Eingaben in beide Richtungen, keine Fehler in der Netplay-Schleife |
| axe-core: 14 Ansichten, hell/dunkel, 1366/390 px | **0 Verstöße**, kein seitlicher Überlauf |
| Netzwerk | keine Anfragen ins Internet, keine CSP-Verletzungen, keine JS-Ausnahmen |

Neue Prüfungen im Backend-Test (Auszug): Kind sieht nicht eingestufte Spiele nicht; Spieldaten, Cover, Couch und Netplay-Räume respektieren die Freigabe; nur Eltern/Admins ändern die Grenze; Cover nur PNG/JPEG/WebP bis 2 MB (SVG/Text abgelehnt); Discs nur innerhalb eines Systems zusammenführbar; `.m3u` im Archiv mit natürlicher Sortierung; Vollsicherung mit `tar -tf` lesbar, inklusive langer Namen; vollständige Wiederherstellung stellt Spiele, Dateien und BIOS her; Archive mit `../`, ohne Datendatei oder beschädigt werden abgelehnt, ohne den Bestand zu verändern.

## Während der Entwicklung gefunden und behoben

1. **Netplay ohne Bildtakt:** EmulatorJS 4.2.3 erwartet `Module.postMainLoop`, das der Kern-Build nicht aufruft. RetroHub taktet die Netplay-Schleife jetzt selbst; drei Folgefehler in EmulatorJS werden beim Laden gezielt korrigiert.
2. **Doppelte Route für Kinderprofile:** Die neue Freigabe-Route hätte die PIN-Änderung verdeckt. Zusammengeführt, Test ergänzt.
3. **Fehler-Beobachter je Schreibvorgang** im ZIP- und TAR-Strom (Speicherleck-Warnung bei großen Sicherungen).

## Bekannte Grenzen

- **Netplay ist experimentell:** getestet mit NES im lokalen Netz auf einem Rechner; über WLAN mit Verzögerung und bei anspruchsvollen Systemen (PSP, N64) nicht geprüft.
- **Disc-Wechsel:** Die Disc-Liste wird erzeugt und von EmulatorJS bei PlayStation bevorzugt; mit echten Mehrdisc-Spielen konnte mangels freier Abbilder nicht getestet werden. Bei anderen CD-Systemen startet Disc 1.
- **Vollsicherung:** Import-Ordner-Spiele sind nicht enthalten (sie liegen auf der NAS); Emulatoren werden nach einer Wiederherstellung bei Bedarf neu geladen.
- **Getestete Systeme:** NES, GBA, DS und PSP liefen mit Spielen; die übrigen Kerne sind installiert und geprüft.
- **Nicht möglich:** GameCube, Wii, PS2. Mega-CD, Lynx, PC-FX, ColecoVision und 3DO brauchen eine BIOS-Datei.
