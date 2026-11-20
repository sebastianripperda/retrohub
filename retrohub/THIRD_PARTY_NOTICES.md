# Hinweise zu Drittsoftware

RetroHub selbst steht unter der MIT-Lizenz (siehe `LICENSE`). Dieses Repository enthält **keine** Emulatoren, Spiele, ROMs oder BIOS-Dateien.

## Bei der Installation geladen (nicht im Repository)

Der Installer lädt die folgenden Pakete aus der npm-Registry (Version 4.2.3, jede Datei per SHA-256 festgelegt in `games/sources.json`) und legt sie im Container unter `/var/lib/retrohub/emu` ab. Es gelten die Lizenzen der jeweiligen Projekte.

| Paket | Kern | Lizenz |
|---|---|---|
| EmulatorJS (Oberfläche) | `Oberfläche` | GPL-3.0 |
| Atari 5200 | `a5200` | GPL-2.0 |
| Virtual Boy | `beetle_vb` | GPL-2.0 |
| Nintendo DS | `melonds` | GPL-3.0 |
| Arcade (FinalBurn Neo) | `fbneo` | FBNeo (nicht-kommerziell) |
| NES / Famicom | `fceumm` | GPL-2.0 |
| Game Boy / Color | `gambatte` | GPL-2.0 |
| ColecoVision | `gearcoleco` | GPL-3.0 |
| Sega Master System, Mega Drive, Game Gear, Mega-CD | `genesis_plus_gx` | Genesis Plus GX (nicht-kommerziell) |
| Sega 32X | `picodrive` | MAME-artig (nicht-kommerziell) |
| Atari Lynx | `handy` | Zlib |
| Arcade (MAME 2003+) | `mame2003_plus` | MAME (nicht-kommerziell) |
| Neo Geo Pocket | `mednafen_ngp` | GPL-2.0 |
| PC Engine / TurboGrafx | `mednafen_pce` | GPL-2.0 |
| PC-FX | `mednafen_pcfx` | GPL-2.0 |
| PlayStation | `pcsx_rearmed` | GPL-2.0 |
| WonderSwan | `mednafen_wswan` | GPL-2.0 |
| Game Boy Advance | `mgba` | MPL-2.0 |
| Nintendo 64 | `mupen64plus_next` | GPL-2.0 |
| 3DO | `opera` | LGPL/nicht-kommerziell |
| PlayStation Portable | `ppsspp` | GPL-2.0+ |
| Atari 7800 | `prosystem` | GPL-2.0 |
| Super Nintendo | `snes9x` | Snes9x (nicht-kommerziell) |
| Atari 2600 | `stella2014` | GPL-2.0 |
| Atari Jaguar | `virtualjaguar` | GPL-3.0 |
| Sega Saturn | `yabause` | GPL-2.0 |
| Amiga | `puae` | GPL-2.0 |
| Commodore 64 | `vice_x64sc` | GPL-2.0 |
| Commodore 128 | `vice_x128` | GPL-2.0 |
| Commodore PET | `vice_xpet` | GPL-2.0 |
| Commodore Plus/4 | `vice_xplus4` | GPL-2.0 |
| Commodore VIC-20 | `vice_xvic` | GPL-2.0 |
| MS-DOS | `dosbox_pure` | GPL-2.0 |

- EmulatorJS: https://github.com/EmulatorJS/EmulatorJS (GPL-3.0)
- Die Kerne sind Portierungen der jeweiligen libretro-Projekte. Einige Kerne (u. a. FinalBurn Neo, MAME 2003+, Snes9x, Genesis Plus GX, PicoDrive, Opera) **erlauben keine kommerzielle Nutzung**.

### Korrekturen an EmulatorJS

`games/sources.json` enthält im Feld `patches` drei kurze Textersetzungen, die RetroHub beim Laden auf `src/emulator.js` von EmulatorJS 4.2.3 anwendet (Netplay-Korrekturen). Die zu ersetzenden Zeilen sind Auszüge aus EmulatorJS; diese Auszüge und die damit veränderte Datei unterliegen weiterhin der **GPL-3.0** von EmulatorJS. Die Korrekturen werden nur angewendet, wenn jede Fundstelle genau einmal vorkommt.

## Im Release-Archiv enthalten

| Komponente | Lizenz | Zweck |
|---|---|---|
| Socket.IO 4.8.1 und Abhängigkeiten (engine.io, ws, cors, debug u. a.) | MIT | Netplay-Server (`server/node_modules`) |

Die genauen Versionen stehen in `server/package-lock.json`, die Lizenztexte in den jeweiligen Paketordnern.

## Entwicklungswerkzeuge (nur für Tests, nicht im Release)

css-tree (MIT), socket.io-client (MIT).

## Marken

Nintendo, Game Boy, Super Nintendo, Nintendo 64, Nintendo DS, Virtual Boy, PlayStation, PlayStation Portable, Sega, Mega Drive, Saturn, Atari, PC Engine, Neo Geo, WonderSwan, ColecoVision, 3DO, Amiga, Commodore und alle weiteren genannten Namen sind Marken ihrer jeweiligen Inhaber. Sie werden nur zur Beschreibung der Kompatibilität genannt. RetroHub steht in keiner Verbindung zu diesen Unternehmen.
