# Sicherheit

## Unterstützte Versionen

Sicherheitskorrekturen gibt es für die jeweils neueste veröffentlichte Version.

## Sicherheitslücke melden

Bitte melde Sicherheitsprobleme **nicht** als öffentliches Issue, sondern vertraulich über
**„Security“ → „Report a vulnerability“** in diesem Repository.

Hilfreich sind: betroffene Version, Beschreibung, Schritte zum Nachstellen und mögliche Auswirkungen. Ich bestätige den Eingang so bald wie möglich und melde mich mit einer Einschätzung.

## Sicherheitsmodell in Kürze

- RetroHub ist für den Betrieb **im Heimnetz** gedacht, nicht für die direkte Erreichbarkeit aus dem Internet.
- Der Server lauscht nur lokal (127.0.0.1:3000) hinter nginx; App und Emulatoren laufen auf getrennten Ursprüngen (Ports 80/443 bzw. 8080/8443).
- Strenge Content-Security-Policy, keine Anfragen ins Internet zur Laufzeit; Emulator-Pakete sind per SHA-256 festgelegt.
- Uploads, URL-Downloads und Ordner-Importe nur für Admins; URL-Downloads blockieren Adressen des Servers selbst; Pfade beim Import und bei der Wiederherstellung werden geprüft.
- Kinderprofile sehen nur freigegebene Spiele; die Sperre gilt serverseitig für alle Zugriffswege.
