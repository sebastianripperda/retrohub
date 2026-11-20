'use strict';
/* RetroHub 9 – unterstützte Systeme (EmulatorJS 4.2.3). key = EmulatorJS-Systemname.
   bios: 'required' | 'optional' | null; biosHint = übliche Dateinamen laut libretro-Dokumentation des Kerns.
   check: optionale Dateikopf-Prüfung für eindeutige Formate (nur wenn die Endung dazu passt). */
const MB = 1048576;
const hex = (b, o, h) => b.length >= o + h.length / 2 && b.slice(o, o + h.length / 2).toString('hex') === h;
const asc = (b, o, s) => b.length >= o + s.length && b.slice(o, o + s.length).toString('binary') === s;
const SYSTEMS = [
  { key: 'nes', name: 'NES / Famicom', maker: 'Nintendo', core: 'fceumm', exts: ['.nes', '.fds', '.unf', '.unif'], maxMB: 8, players: 4, check: { '.nes': (b) => asc(b, 0, 'NES\x1a') } },
  { key: 'snes', name: 'Super Nintendo', maker: 'Nintendo', core: 'snes9x', exts: ['.smc', '.sfc', '.swc', '.fig', '.bs'], maxMB: 16, players: 4 },
  { key: 'n64', name: 'Nintendo 64', maker: 'Nintendo', core: 'mupen64plus_next', exts: ['.n64', '.z64', '.v64'], maxMB: 128, players: 4 },
  { key: 'gb', name: 'Game Boy / Color', maker: 'Nintendo', core: 'gambatte', exts: ['.gb', '.gbc', '.dmg'], maxMB: 8, players: 1, check: { '.gb': (b) => hex(b, 0x104, 'ceed6666'), '.gbc': (b) => hex(b, 0x104, 'ceed6666') } },
  { key: 'gba', name: 'Game Boy Advance', maker: 'Nintendo', core: 'mgba', exts: ['.gba'], maxMB: 64, players: 1, check: { '.gba': (b) => b.length > 0xB2 && b[0xB2] === 0x96 } },
  { key: 'nds', name: 'Nintendo DS', maker: 'Nintendo', core: 'melonds', exts: ['.nds'], maxMB: 512, players: 1, bios: 'optional', biosHint: 'bios7.bin, bios9.bin, firmware.bin (als ZIP)', check: { '.nds': (b) => hex(b, 0xC0, '24ffae51') } },
  { key: 'vb', name: 'Virtual Boy', maker: 'Nintendo', core: 'beetle_vb', exts: ['.vb', '.vboy'], maxMB: 8, players: 1 },
  { key: 'psx', name: 'PlayStation', maker: 'Sony', core: 'pcsx_rearmed', exts: ['.cue', '.bin', '.iso', '.chd', '.pbp', '.img', '.m3u', '.ecm'], maxMB: 2048, players: 4, bios: 'optional', biosHint: 'scph5501.bin (ohne BIOS: eingebauter Ersatz)' },
  { key: 'psp', name: 'PlayStation Portable', maker: 'Sony', core: 'ppsspp', exts: ['.iso', '.cso', '.pbp', '.elf'], maxMB: 2048, players: 1, threads: true, check: { '.cso': (b) => asc(b, 0, 'CISO'), '.pbp': (b) => asc(b, 0, '\x00PBP'), '.iso': (b) => asc(b, 0x8001, 'CD001') } },
  { key: 'segaMS', name: 'Sega Master System', maker: 'Sega', core: 'genesis_plus_gx', exts: ['.sms'], maxMB: 8, players: 2 },
  { key: 'segaMD', name: 'Sega Mega Drive / Genesis', maker: 'Sega', core: 'genesis_plus_gx', exts: ['.md', '.gen', '.smd', '.bin'], maxMB: 16, players: 4 },
  { key: 'segaGG', name: 'Sega Game Gear', maker: 'Sega', core: 'genesis_plus_gx', exts: ['.gg'], maxMB: 8, players: 1 },
  { key: 'segaCD', name: 'Sega Mega-CD', maker: 'Sega', core: 'genesis_plus_gx', exts: ['.cue', '.bin', '.iso', '.chd'], maxMB: 1024, players: 2, bios: 'required', biosHint: 'bios_CD_E.bin / bios_CD_U.bin / bios_CD_J.bin' },
  { key: 'sega32x', name: 'Sega 32X', maker: 'Sega', core: 'picodrive', exts: ['.32x'], maxMB: 16, players: 2 },
  { key: 'segaSaturn', name: 'Sega Saturn', maker: 'Sega', core: 'yabause', exts: ['.cue', '.bin', '.iso', '.chd', '.ccd'], maxMB: 2048, players: 2, bios: 'optional', biosHint: 'saturn_bios.bin (ohne BIOS: eingebauter Ersatz)' },
  { key: 'atari2600', name: 'Atari 2600', maker: 'Atari', core: 'stella2014', exts: ['.a26', '.bin'], maxMB: 1, players: 2 },
  { key: 'atari5200', name: 'Atari 5200', maker: 'Atari', core: 'a5200', exts: ['.a52', '.bin'], maxMB: 1, players: 4, bios: 'optional', biosHint: '5200.rom' },
  { key: 'atari7800', name: 'Atari 7800', maker: 'Atari', core: 'prosystem', exts: ['.a78', '.bin'], maxMB: 1, players: 2, bios: 'optional', biosHint: '7800 BIOS (U).rom' },
  { key: 'lynx', name: 'Atari Lynx', maker: 'Atari', core: 'handy', exts: ['.lnx', '.o'], maxMB: 2, players: 1, bios: 'required', biosHint: 'lynxboot.img' },
  { key: 'jaguar', name: 'Atari Jaguar', maker: 'Atari', core: 'virtualjaguar', exts: ['.j64', '.jag', '.rom'], maxMB: 16, players: 2 },
  { key: 'pce', name: 'PC Engine / TurboGrafx-16', maker: 'NEC', core: 'mednafen_pce', exts: ['.pce', '.cue', '.ccd', '.chd'], maxMB: 1024, players: 5, bios: 'optional', biosHint: 'syscard3.pce (nur für CD-Spiele)' },
  { key: 'pcfx', name: 'PC-FX', maker: 'NEC', core: 'mednafen_pcfx', exts: ['.cue', '.ccd', '.chd'], maxMB: 1024, players: 2, bios: 'required', biosHint: 'pcfx.rom' },
  { key: 'ngp', name: 'Neo Geo Pocket / Color', maker: 'SNK', core: 'mednafen_ngp', exts: ['.ngp', '.ngc'], maxMB: 4, players: 1 },
  { key: 'ws', name: 'WonderSwan / Color', maker: 'Bandai', core: 'mednafen_wswan', exts: ['.ws', '.wsc'], maxMB: 16, players: 1 },
  { key: 'coleco', name: 'ColecoVision', maker: 'Coleco', core: 'gearcoleco', exts: ['.col', '.cv', '.rom'], maxMB: 1, players: 2, bios: 'required', biosHint: 'colecovision.rom' },
  { key: '3do', name: '3DO', maker: 'Panasonic', core: 'opera', exts: ['.iso', '.cue', '.chd'], maxMB: 1024, players: 2, bios: 'required', biosHint: 'panafz10.bin' },
  { key: 'arcade', name: 'Arcade (FinalBurn Neo)', maker: 'Arcade', core: 'fbneo', exts: ['.zip', '.7z'], maxMB: 512, players: 4, archiveIsGame: true },
  { key: 'mame', name: 'Arcade (MAME 2003+)', maker: 'Arcade', core: 'mame2003_plus', exts: ['.zip'], maxMB: 512, players: 4, archiveIsGame: true },
  { key: 'amiga', name: 'Amiga', maker: 'Commodore', core: 'puae', exts: ['.adf', '.adz', '.ipf', '.hdf', '.lha', '.dms'], maxMB: 512, players: 2, bios: 'optional', biosHint: 'kick34005.A500 (ohne Kickstart: AROS-Ersatz)' },
  { key: 'c64', name: 'Commodore 64', maker: 'Commodore', core: 'vice_x64sc', exts: ['.d64', '.t64', '.prg', '.crt', '.tap', '.g64'], maxMB: 16, players: 2 },
  { key: 'c128', name: 'Commodore 128', maker: 'Commodore', core: 'vice_x128', exts: ['.d64', '.d71', '.d81', '.prg'], maxMB: 16, players: 2 },
  { key: 'pet', name: 'Commodore PET', maker: 'Commodore', core: 'vice_xpet', exts: ['.prg', '.d64', '.tap'], maxMB: 4, players: 1 },
  { key: 'plus4', name: 'Commodore Plus/4', maker: 'Commodore', core: 'vice_xplus4', exts: ['.prg', '.d64', '.tap'], maxMB: 4, players: 2 },
  { key: 'vic20', name: 'Commodore VIC-20', maker: 'Commodore', core: 'vice_xvic', exts: ['.prg', '.crt', '.d64', '.tap'], maxMB: 4, players: 2 },
  { key: 'dos', name: 'MS-DOS', maker: 'PC', core: 'dosbox_pure', exts: ['.zip', '.dosz', '.exe', '.com', '.bat', '.iso', '.cue'], maxMB: 2048, players: 1, threads: true }
];
for (const s of SYSTEMS) {
  s.maxBytes = s.maxMB * MB;
  if (!s.archiveIsGame) for (const a of ['.zip', '.7z']) if (!s.exts.includes(a)) s.exts.push(a);
}
const BY_KEY = Object.fromEntries(SYSTEMS.map((s) => [s.key, s]));
function systemsForExt(ext) { ext = String(ext).toLowerCase(); return SYSTEMS.filter((s) => s.exts.includes(ext)); }
function checkHeader(sys, ext, head) { const f = sys.check && sys.check[ext]; return f ? f(head) : true; }
module.exports = { SYSTEMS, BY_KEY, systemsForExt, checkHeader };
