# TGPlayer

TGPlayer is a Telegram-first desktop music player inspired by PixelPlayer's Material You palette, expressive motion and floating mini-player. It uses a light glass surface by default, a frameless rounded window with custom controls, and a Telegram paper-plane mark.

## Run

```powershell
npm install
npm start
```

To create the Windows installer:

```powershell
npm run dist
```

The NSIS installer is written to `dist-final/TGPlayer-Setup-0.1.0.exe`. Runtime session data and audio cache live in the app's per-user data directory (`%APPDATA%\tgplayer` on Windows). An existing `D:\TGPlayerData` folder from an earlier build is still used when it already holds data, so upgrades keep you signed in.

The first install downloads Electron. Network access is only needed for that install and for the optional GramJS Telegram bridge.

## Telegram connection

The default connection mode is **Bot Token**, so you do not need to apply for an API ID or API hash. Create a bot with `@BotFather`, add it to a channel as an administrator, paste its token into TGPlayer, then add that channel from the Channels page. The Bot API can read posts that the bot can access (including new audio posts); it cannot browse a user's private chat history.

For a full personal-account library, the connection sheet also keeps the same state flow as PixelPlayer:

`API credentials → phone number → verification code → optional two-step password → ready`

Create an API ID and API hash at [my.telegram.org](https://my.telegram.org). After authorization, the Electron main process keeps an OS-protected StringSession in the app's user-data directory and exposes channel search and audio download through the isolated preload bridge. Telegram audio messages are mapped to the same useful fields as PixelPlayer (`chat/channel`, `messageId`, title, artist, duration) and can be downloaded to the local app cache for playback.

Playback first asks the bridge for a loopback `127.0.0.1` stream URL. The small local HTTP server pulls Telegram media in chunks with GramJS `iterDownload`, so the renderer's audio element can begin playback before a full file is cached; a cached download is used as a fallback.

If the bot is not connected, **Explore demo library** keeps the UI usable with the built-in sample library.

## PixelPlayer ideas carried over

- dark dynamic palette with lavender album accents and optional light mode;
- asymmetric album-art hero, rounded Material cards and a persistent mini-player;
- emphasized `slide + fade + scale` page transitions and gentle floating artwork animation;
- queue, favorites, channel sync, search and playback controls;
- Telegram auth and song metadata are separated behind an IPC bridge, ready to be replaced by TDLib or a local range proxy if a native TDLib build is preferred.
