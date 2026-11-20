# Mitwirken

Danke für dein Interesse an RetroHub! Fehlermeldungen, Testberichte von echter Hardware und Pull Requests sind willkommen.

## Grundregeln

- **Keine Spieldateien:** Bitte niemals ROMs, BIOS-Dateien, Disc-Abbilder oder Links darauf in Issues, Pull Requests oder Tests. Für Tests eignen sich selbst erzeugte Dateien oder frei lizenzierte Homebrew-Programme, die nicht ins Repository kommen.
- **Sicherheitslücken** bitte vertraulich melden (siehe [SECURITY.md](SECURITY.md)).
- Die Oberfläche ist auf Deutsch; Texte bitte klar und ohne Fachjargon formulieren.

## Entwicklungsumgebung

```bash
npm ci
(cd server && npm ci --omit=dev)
npm run check
npm test
```

Benötigt: Node.js ≥ 18, npm, `shellcheck`, `unzip`.

## Richtlinien für Code

- Kein Build-Schritt, keine Frameworks in der Oberfläche; neue Laufzeit-Abhängigkeiten nur nach Absprache.
- Barrierefreiheit: Bedienbar per Tastatur, sinnvolle Beschriftungen für Screenreader, Touch-Ziele mindestens 44 px, ausreichender Kontrast in hellem und dunklem Modus.
- Sicherheit: Content-Security-Policy nicht aufweichen, keine Anfragen ins Internet zur Laufzeit, Eingaben serverseitig prüfen.
- Neue Funktionen bekommen Prüfungen in `tests/api-test.js`.
- Shell-Skripte müssen ShellCheck ohne Befund bestehen.

## Pull Requests

1. Fork anlegen, Branch erstellen.
2. Änderung mit Test, `npm run check` und `npm test` lokal ausführen.
3. Sichtbare Änderungen in `CHANGELOG.md` eintragen.
4. Pull Request mit kurzer Beschreibung öffnen.

## Release veröffentlichen (für Betreuende)

1. Versionsnummer in `VERSION`, `package.json`, `server/package.json` und `install.sh` (`RH_VERSION`) anpassen und einen Abschnitt in `CHANGELOG.md` ergänzen – `npm run check` prüft die Übereinstimmung.
2. Optional einen eigenen Release-Text als `docs/releases/vX.Y.Z.md` anlegen.
3. Auf GitHub **Actions → Release → Run workflow** starten (oder per Git: `git tag vX.Y.Z && git push --tags`). Die Action prüft, baut das Archiv und legt das Release an.

Mit dem Einreichen eines Pull Requests stimmst du zu, dass dein Beitrag unter der MIT-Lizenz des Projekts veröffentlicht wird.
