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

TGPlayer signs in with your personal Telegram account. The connection sheet follows the same state flow as PixelPlayer:

`API credentials → phone number → verification code → optional two-step password → ready`

Create an API ID and API hash at [my.telegram.org](https://my.telegram.org). After authorization, the Electron main process keeps an OS-protected StringSession in the app's user-data directory and exposes channel search and audio download through the isolated preload bridge. From the Channels page you pick which chats to scan, so TGPlayer only indexes audio from the chats you select rather than your whole account. Telegram audio messages are mapped to the same useful fields as PixelPlayer (`chat/channel`, `messageId`, title, artist, duration) and can be downloaded to the local app cache for playback.

Playback first asks the bridge for a loopback `127.0.0.1` stream URL. The small local HTTP server pulls Telegram media in chunks with GramJS `iterDownload`, so the renderer's audio element can begin playback before a full file is cached; a cached download is used as a fallback.

A bot is a content source, not a sign-in method: add a bot to a group or channel to post audio there, then sign in with your own account and select that chat on the Channels page to listen. Playing full-length tracks needs the personal-account login above, because the Bot API only exposes a short prefix of each file and cannot seek.

## 中文说明

TGPlayer 用你的**个人 Telegram 账户**登录,不是用 bot token。登录流程:

`API ID/hash → 手机号 → 验证码 →(可选)两步验证密码 → 完成`

在 [my.telegram.org](https://my.telegram.org) 申请 API ID 和 API hash。授权后,登录凭据(StringSession)经系统加密保存在本地用户数据目录,通过隔离的 preload bridge 提供频道搜索和音频下载。在「频道」页里**自己选**要扫描的聊天,TGPlayer 只索引选中聊天里的音频,不会读取你的整个账户。

想听机器人发的歌:把机器人加进某个群或频道让它发音频,然后**用你自己的账户登录**,在「频道」页选中那个群即可。这里机器人只是**内容来源**,不是登录方式——完整播放(可拖动进度、读取完整时长)必须走上面的个人账户登录,因为 Bot API 只能拿到每个文件的前一小段、也不支持跳转。

## PixelPlayer ideas carried over

- dark dynamic palette with lavender album accents and optional light mode;
- asymmetric album-art hero, rounded Material cards and a persistent mini-player;
- emphasized `slide + fade + scale` page transitions and gentle floating artwork animation;
- queue, favorites, channel sync, search and playback controls;
- Telegram auth and song metadata are separated behind an IPC bridge, ready to be replaced by TDLib or a local range proxy if a native TDLib build is preferred.
