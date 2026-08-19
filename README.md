# Pero Launcher

A custom Minecraft Java Edition launcher built with Electron. Windows only.

The idea behind it: the launcher answers to the player, not the other way round.
If someone wants to play 1.5.2 with Forge, that is the launcher's problem to
solve - dead download links, forgotten formats and other people's breakage
included. Anything offered has to work; anything that cannot work is not
offered at all.

## What works

**Launching the game**
- Downloads and starts any official version (minecraft-launcher-core)
- All four mod loaders: Fabric, Quilt, Forge and NeoForge
- Forge across all three of its eras - pasted into the game jar (before 1.6),
  the universal archive (1.6 to 1.11), the installer (1.12 onwards)
- Jar mods of the pre-1.6 kind: files dropped into `<game folder>/jarmods` are
  layered into the game in alphabetical order, the loader last
- Libraries FML needs that no longer exist online are recovered from the web
  archive and verified by hash
- Java is chosen to match the version and downloaded from Mojang if the machine
  has nothing suitable
- Verified in game with Forge: 1.2.5, 1.3.2, 1.4.2, 1.4.3, 1.4.7, 1.5.2, 1.6.4, 1.20

**Accounts**
- Microsoft sign-in (msmc), kept between sessions - signing in is not repeated
  on every launch
- Several accounts, switched from the settings page
- Offline accounts by name alone, for single player, LAN, and servers that do
  not check for a licence

**Version browser**
- The whole Mojang list with search, filters and installed builds marked
- Installed builds appear under the version they were built from
- Cached on disk, so it still opens without a connection

**When something goes wrong**
- The reason a crash happened is shown rather than swallowed
- Java refusing the heap it was given is recognised as its own case, and the
  launcher offers to start again with a figure that fits
- Crash reports from both the game and Java are readable inside the launcher,
  with the line that explains the failure pulled to the front

**Settings**
- Version and loader, account, memory, Java, window size, game folder, language,
  version filters, jar mods, Java arguments, what to do once the game starts
- Every version gets its own mod config folder, because the formats are not
  compatible between eras and they share one game folder
- Three languages (ru / en / de), switched without a restart

## Running it

```
npm install
npm start
```

There is also a pre-flight check that asks every loader for real builds and
confirms the launcher could actually start them - not merely that the files
download:

```
npm run check-loaders
npm run check-loaders 1.7.10 1.12.2 1.20
```

## Not done yet

- Red tile: the mod and modpack browser (Modrinth / CurseForge)
- A modpack of our own, updated by hash manifest rather than a full re-download
- Progress while the game is being fetched - the launcher is silent for minutes
  on a first launch
- White tile: player name and skin
- Icons for the settings and skin tiles
- Packaging into an .exe (electron-builder), and paths that are not hardcoded
  to the E: drive

## Layout

```
main.js          main process: window, IPC, settings, accounts, launching
preload.js       the bridge between the main process and the pages
index.html       main screen - tiles
settings.html    settings page
locales/         ru.json / en.json / de.json
scripts/         check-loaders.js - the pre-flight check
src/             styles, i18n, and the logic for both pages
assets/icons/    tile icons
```
