# Änderungsprotokoll

## 9.1.1

Ergebnis einer vollständigen Prüfung aller Ansichten und Funktionen auf Handy (hoch/quer), Tablet (hoch/quer) und PC (1366/1920 px).

### Behoben
- **Tablet und Handy quer:** Die Seitenleiste blendete in der Symbolansicht ihre Beschriftungen vollständig aus – 12 Links hatten für Screenreader keinen Namen. Beschriftungen bleiben jetzt für Screenreader erhalten; jedes Symbol hat einen Tooltip, das Logo eine Beschriftung.
- **Handy quer:** Die Spielfläche nutzte nur 150 von 337 px Höhe (alte Querformat-Regel der früheren Spiele stellte die Bühne auf Zeilenlayout). Jetzt volle Höhe, schmalere Kopfleiste.
- **Profil:** Die Farbwahl für den Avatar war wirkungslos, weil das neue Design alle Avatare neutral färbte. Jetzt gedämpfte, unterscheidbare Farbtöne (Kontrast geprüft, hell und dunkel).
- **Profil:** Die Kennzahl „Netzwerk-Siege“ bezog sich auf die entfernten Netzwerkspiele und blieb immer 0 – ersetzt durch „Gespielte Spiele“. „1 Runden“ → „1 Runde“.
- **Turniere:** Das gewählte Spiel wurde gespeichert, aber nie angezeigt; ohne Angabe setzte der Server noch das entfernte Spiel „tictactoe“. Jetzt „Gespielt wird: …“ im Turnier, kein Altwert mehr.
- **Touch-Geräte:** Knöpfe, Auswahllisten, Eingabefelder, Filter-Chips und das Favoriten-Herz sind mindestens 44 px groß; Dateiauswahl am PC mindestens 40 px (vorher 23 px).
- **Turnier-Formular:** heller Rahmen um die Teilnehmerfelder an das ruhige Design angepasst.

### Projekt
- Veröffentlichung auf GitHub: README mit Bildschirmfotos und englischer Kurzfassung, Hinweise zu Drittsoftware, Beitrags- und Sicherheitsrichtlinien, Verhaltensregeln.
- Release-Archiv wird aus dem Quellcode gebaut (`scripts/build-release.sh`, Abhängigkeiten über Lockfiles); GitHub Actions prüfen jeden Push und veröffentlichen Releases bei Versions-Tags; Dependabot hält Abhängigkeiten aktuell.
- Der Installer erkennt einen Git-Klon und erklärt, wie man das Release-Archiv erhält oder baut.


## 9.1.0

### Neu
- **Altersfreigabe:** Freigabe je Spiel (ab 0/6/12/16/18). Kinderprofile sehen und starten nur Spiele bis zu ihrer Grenze (Standard 6, von den Eltern im Profil einstellbar); nicht eingestufte Spiele bleiben für Kinder verborgen. Gilt auch für Spieldaten, Cover, Couch-Modus und Netplay.
- **Metadaten:** Cover (PNG/JPEG/WebP bis 2 MB, Dateikopf geprüft), Beschreibung, Erscheinungsjahr, Genre; Suche berücksichtigt Genre und Jahr; Bearbeiten-Bereich für Admins.
- **Mehrere Discs:** Spiele desselben Systems lassen sich zusammenführen (Spielstände werden mitgenommen); RetroHub legt automatisch eine Disc-Liste (.m3u) ins Archiv – Disc-Wechsel im Emulator-Menü (PlayStation).
- **Vollständige Sicherung:** TAR-Archiv mit Daten, Spielständen, hochgeladenen Spieldateien, Covern und BIOS (lange Dateinamen per PAX); Wiederherstellung im Admin-Bereich mit Pfadprüfung und automatischer Sicherung vorher.

### Netplay repariert
- EmulatorJS 4.2.3 taktet seine Netplay-Bildschleife über `Module.postMainLoop`, das der Kern-Build nicht aufruft – Netplay hatte dadurch nie einen Bildtakt. RetroHub ruft die Schleife jetzt je neuem Bild selbst auf.
- Drei Folgefehler in EmulatorJS korrigiert (leere Bildmarken verworfen, Absturz bei fehlenden Daten, falsch berechnetes Startbild). Die Korrekturen werden beim Laden nur angewendet, wenn jede Fundstelle genau einmal vorkommt.
- Ergebnis im Test: Gastgeber und Gast laufen im Gleichschritt, Eingaben kommen in beide Richtungen an. Netplay bleibt als experimentell gekennzeichnet.

### Behoben
- Zwei Routen mit derselben Adresse für Kinderprofile – die PIN-Änderung wäre ignoriert worden (vor Auslieferung gefunden, Test ergänzt).
- ZIP- und TAR-Strom hängten für jeden Schreibvorgang einen Fehler-Beobachter an (Speicherleck-Warnung bei großen Sicherungen).


## 9.0.0

Grundlegender Umbau: RetroHub ist jetzt eine Plattform für Emulatoren und eigene Spieldateien. (Die nie veröffentlichte 8.2.0 ist hierin aufgegangen.)

### Entfernt
- Alle vorinstallierten Spiele: eingebaute Spiele, nachgeladene HTML5-Spiele, Homebrew-ROMs, Tic-Tac-Toe online, Button Duel.
- Separater NES-Emulator jsnes (NES läuft jetzt über EmulatorJS), Lobbys alter Art, Schriftart Bricolage Grotesque.

### Neu
- 35 Systeme über 32 Emulator-Kerne (EmulatorJS 4.2.3), aus der npm-Registry geladen und per SHA-256 geprüft; einzeln nachladbar im Admin-Bereich.
- Spielebibliothek: Spiele mit einer oder mehreren Dateien je System; Hinzufügen per Upload (bis 2 GB, mit Fortschritt), Download von einer URL (Hintergrundauftrag, Weiterleitungen, Sperre für Server-eigene Adressen) und Import aus einem eingebundenen Ordner (nur lesend, Pfadschutz, CUE mit zugehörigen BIN-Dateien).
- Mehrteilige Spiele werden als ZIP an den Emulator geliefert; Dubletten werden per SHA-256 erkannt; Dateikopf-Prüfung für eindeutige Formate.
- BIOS-Verwaltung je System (Pflicht bei Mega-CD, Lynx, PC-FX, ColecoVision, 3DO).
- Binäre Spielstände bis 160 MB und spielinterner Speicher; 3 Speicherplätze, automatisches Speichern beim Beenden, „Weiterspielen“.
- Couch-Modus neu: Handys werden echte Controller für den Emulator am Fernseher (Steuerkreuz, A/B/X/Y, L/R, Start/Select, Mehrfachberührung).
- Netplay (experimentell) mit lokalem Server nach dem EmulatorJS-Protokoll, nur für angemeldete Konten; Raumübersicht in RetroHub.
- Cross-Origin-Isolation der App (nötig für PSP und MS-DOS).
- Neues, ruhiges Design („Sammlungsarchiv“): Graphit und Stahlblau, Systemschrift, Systemkürzel statt Emojis.
- Migration: eigene, in 8.x hochgeladene ROMs werden samt Spielständen in die Bibliothek übernommen.

### Installer
- Standard-Disk 16 GB (vorher 8 GB).
- Neue Optionen `EMULATORS` (Auswahl) und `IMPORT_DIR` (Bind-Mount, nur lesend) mit Prüfung, ob der Ordner für den unprivilegierten Container lesbar ist.
- Installation ohne Internet: `tools/emulatoren-vorab-laden.sh` lädt und prüft die Emulator-Pakete, `GAMES_DIR` übernimmt sie.
- Selbsttest prüft zusätzlich Emulator-Seite und Netplay; Statusabfragen ohne Pipe (zuvor konnte der Selbsttest zufällig an SIGPIPE scheitern).
- Abschlussmeldung mit Emulatoren, Ports, Import-Ordner und Netplay-Hinweis.

### Behoben während der Entwicklung
- Größengrenzen liefen bei 2 GB über (32-Bit-Verschiebung).
- Emulator-Rahmen wurde bei Zugriff über eine IP-Adresse blockiert (Cross-Origin-Resource-Policy).
- Emulator startete nicht, weil die CSP interne blob:-Abrufe verbot; Startfehler wurden nicht gemeldet.
- Speichern aus dem Menü hing (Vorschaubild nur bei laufender Emulation); PSP-Zustand direkt nach dem Start nicht verfügbar.
- Netplay nutzte wegen eines falschen Einstellungsnamens den fremden Server statt des lokalen; Puffer für den Zustandsabgleich zu klein.
- Nachladewerkzeug lehnte Kerne mit Unterstrich im Namen ab.
- Ergebnis des Ordner-Imports verschwand sofort; Upload ohne Rechtebestätigung zeigte keine Meldung.


## 8.1.0

### Neu
- NES-Emulator (jsnes 2.1.0, Apache-2.0, lokal eingebunden – keine CDN): Bild, Ton, Tastatur, Touch-Steuerung, Gamepads, zweiter Spieler.
- ROM-Quellen in `games/sources.json`: 3 freie NES-Homebrew-Spiele, geladen per festem Link, geprüft per SHA-256 und Dateikopf, freigegeben über die Quarantäne.
- ROM-Upload für Admins (NES, bis 4 MB) mit Rechtebestätigung, Prüfung des Dateikopfs, Dublettenerkennung per SHA-256, Löschen/Ausblenden.
- Spielstände: je Spiel 3 Speicherplätze plus automatisches Speichern beim Beenden, mit Vorschaubild, komprimiert auf dem Server; Lights Out setzt angefangene Rätsel fort; Übersicht und Löschen im Profil; Spielstände sind Teil des Backups.
- Couch-Modus mit echtem QR-Code (eigener Encoder, ISO/IEC 18004): Scannen öffnet RetroHub, nach der Anmeldung tritt das Handy automatisch bei.
- Benutzerverwaltung: Admins können jetzt auch Anzeigenamen ändern.

### Behoben
- Kurze Tastendrücke und schnelles Antippen gingen im Emulator verloren (Drücken und Loslassen zwischen zwei Frames) – werden jetzt mindestens einen Frame gehalten.
- Protokollfenster im Admin-Bereich war per Tastatur nicht scrollbar.
- Auf Handys lag der Schließen-Knopf im Spiel außerhalb des Bildschirms – Spielerleiste kürzt jetzt den Titel.
- Die Knopf-Klasse überschrieb das `hidden`-Attribut (seit 7.3): ausgeblendete Knöpfe wie „Nochmal spielen“ (Higher or Lower) oder „Spielstände“ bei Nicht-ROM-Spielen waren sichtbar.
- Mitgelieferte Tests werden jetzt in den Container übernommen (`/opt/retrohub/tests`).

## 8.0.0

### Neu
- RetroHub-Server (Node.js ≥ 18, ohne npm-Pakete) als systemd-Dienst mit eigenem Dienstkonto und Härtung.
- Konten: Ersteinrichtung mit Einrichtungscode, Anmeldung mit HttpOnly-Sitzungscookie, scrypt-Passwörter, Registrierung durch Admin freigebbar, Kinderprofile, Passwortänderung, CLI zum Zurücksetzen.
- Freunde, Online-Status, Chat-Kanäle, Direktnachrichten, Mitteilungen, serverseitige Turniere – in Echtzeit über eine eigene WebSocket-Implementierung.
- Netzwerk-Multiplayer mit serverseitiger Spiellogik: Tic-Tac-Toe online, Button Duel (2–8 Spieler, Fehlstart-Erkennung), Lobbys, Einladungen, Beitritt per Code.
- Couch-Modus mit echter Verbindung: Fernseher als Anzeige, Handys als Controller.
- Spiele nachladen: 9 quelloffene Spiele, festgelegt auf Commit und Inhalts-Prüfsumme, Quarantäne, Freigabe; Spiegel- und Offline-Archiv-Option; Nachladen aus dem Admin-Bereich.
- Spiele laufen auf eigenem Ursprung (8080/8443) mit eigener CSP; Tracking, Werbung und CDNs der Fremdspiele werden blockiert.
- Administration: Konten, Rollen, Sperren, Passwort-Reset, Registrierung, Systemstatus, Sicherung/Wiederherstellung, Audit-Protokoll, tägliche automatische Sicherung.
- Spielstände, Favoriten und Statistiken serverseitig – auf allen Geräten gleich.

### Behoben während der Prüfung
- Spiele-Download-Fehler brach die Installation ab (ERR-Falle trotz `set +e`) – jetzt nur Warnung.
- Node.js nutzte die System-Zertifikate nicht (Firmen-Proxy) – `NODE_EXTRA_CA_CERTS` gesetzt.
- Browser versuchte nach beendeter Sitzung endlos neu zu verbinden – prüft jetzt die Sitzung und zeigt die Anmeldung.
- Anmeldesperre zählte auch erfolgreiche Anmeldungen – zählt jetzt nur Fehlversuche.
- Administration lief auf Handys über den Rand (lange Quellenangaben) – Listen umbrechen jetzt.
- Neustart des Servers ohne systemd beendete Prozesse per Namensmuster – jetzt über PID-Datei.

## 7.3.0
Siehe Vorgängerversion: Installer mit Validierung und Rollback, responsive Oberfläche, 5 lokale Spiele, strikte CSP, lokale CA.
