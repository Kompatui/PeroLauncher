# Pero Launcher

A custom Minecraft Java Edition launcher built with Electron. Windows only.

## What already works
- Custom titlebar (frameless window, minimize / maximize / close in Windows style)
- Tile-based main menu (5 tiles)
- Microsoft authentication (premium accounts, msmc)
- Downloading and launching Minecraft (minecraft-launcher-core)
- Settings page: version, account, RAM (auto / manual, capped by actual system memory),
  Java/JRE, window size, game folder, language, version filters
- Localization system (ru / en / de) via locales/*.json and data-i18n attributes
- Settings are stored in E:\PeroLauncher\settings.json, game folder is E:\.minecraft

## Setup after cloning / restoring
```
npm install
npm start
```

## Not done yet
- Red tile: modpack / mod browser (Modrinth / CurseForge)
- White tile: player name and skin
- Version manager (picking a version from the list) and account manager
- Custom modpack with incremental updates based on a hash manifest
- Automatic Java detection / installation
- Packaging into an .exe via electron-builder
- Portable paths instead of the hardcoded E: drive
