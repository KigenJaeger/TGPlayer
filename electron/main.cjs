const { app, BrowserWindow, ipcMain, shell, safeStorage, nativeTheme, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

let mainWindow;
let telegram = null;
let streamServer = null;
let streamPort = null;
// Where the account lives. The session and the library are encrypted through
// safeStorage, and the key that opens them sits in Local State *inside this
// directory* -- so relocating an existing folder is exactly what would present a
// returning user with a login screen. An installation that is already here is
// therefore always adopted as-is.
//
// Everything else gets Electron's own per-user location. The previous version put
// the folder on D: for anyone who merely had such a drive letter, which on someone
// else's machine may be a disc, a card reader, or read-only, and its fallback
// pointed inside app.asar, which is not writable once packaged.
const LEGACY_DATA_PATH = 'D:\\TGPlayerData';

function existingInstallPath() {
  // Keyed on real account data rather than on the folder existing, so an empty
  // leftover directory does not divert a fresh install away from the default.
  for (const name of ['telegram-session.json', 'Local State']) {
    try { if (fs.existsSync(path.join(LEGACY_DATA_PATH, name))) return LEGACY_DATA_PATH; } catch {}
  }
  return null;
}

const localDataPath = existingInstallPath();
if (localDataPath) app.setPath('userData', localDataPath);

// Unguarded, this used to kill the app at module scope with no window and no
// message whenever the directory existed but could not be written.
try {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
} catch (error) {
  console.error('[data] cannot create user data directory:', app.getPath('userData'), error?.message);
}
const sessionPath = () => path.join(app.getPath('userData'), 'telegram-session.json');

function readSession() {
  try {
    const data = JSON.parse(fs.readFileSync(sessionPath(), 'utf8'));
    if (data.encryptedStringSession && safeStorage.isEncryptionAvailable()) return { stringSession: safeStorage.decryptString(Buffer.from(data.encryptedStringSession, 'base64')) };
    return data;
  } catch { return {}; }
}
function saveSession(data) {
  const payload = data.stringSession && safeStorage.isEncryptionAvailable()
    ? { encryptedStringSession: safeStorage.encryptString(data.stringSession).toString('base64') }
    : data;
  fs.writeFileSync(sessionPath(), JSON.stringify(payload, null, 2), 'utf8');
}
function persistTelegramSession() {
  try { if (telegram?.client) saveSession({ stringSession: telegram.client.session.save() }); } catch {}
}

// PixelPlayer falls back to Telegram Desktop's public app credentials, so the
// desktop client can offer phone-number login without asking the user for an API
// ID or hash. The UI discloses that this is an unofficial client.
const DEFAULT_API_ID = 2040;
const DEFAULT_API_HASH = 'b18441a1ff607e10a989891a5462e627';

// --- Proxy ------------------------------------------------------------------
// GramJS speaks raw MTProto over TCP. Unlike Chromium's net stack it does NOT
// honor the Windows system proxy, a PAC script, or TUN routing, so where
// Telegram's DCs are blocked every connect() ends in ETIMEDOUT. We therefore
// resolve a proxy ourselves and hand it to GramJS explicitly.
//
// This only changes how *this app* egresses. It never writes to the system
// proxy configuration -- detection is read-only, and the UI shows what was
// picked so it can be overridden or turned off.
const proxyConfigPath = () => path.join(app.getPath('userData'), 'proxy.json');
const CONNECT_TIMEOUT_MS = 20000;

function readProxyConfig() {
  try { return JSON.parse(fs.readFileSync(proxyConfigPath(), 'utf8')); } catch { return {}; }
}
function saveProxyConfig(config) {
  fs.writeFileSync(proxyConfigPath(), JSON.stringify(config, null, 2), 'utf8');
}

// --- Settings ---------------------------------------------------------------
// Two kinds of setting live here. Appearance ones (theme, accent, density) are
// only read by the renderer, but they are stored in the main process anyway so
// the choice survives a reload and can be applied before the first paint.
// Streaming ones are read by the download engine on every part, so changing a
// value takes effect on the next request without a restart.

// Kept in step with the body[data-preset=...] blocks in styles.css. An id that
// has no stylesheet block would leave the UI on the default palette with the
// settings page claiming otherwise, so unknown values are rejected on write.
const PRESET_IDS = ['blue', 'amber', 'forest', 'mono', 'contrast', 'cyber'];
const DARK_ONLY_PRESETS = ['contrast', 'cyber'];

const SETTINGS_DEFAULTS = {
  theme: 'light',            // 'light' | 'dark' | 'system'
  // A preset is a whole palette (surfaces included), where accent only retints
  // the highlight colour. Two of them are dark-only, so the renderer forces the
  // theme to dark while one is active rather than rendering black-on-black.
  preset: 'blue',
  accent: 'blue',
  minimizeToTray: true,      // close button hides to the tray instead of quitting
  parallelParts: 8,          // GetFile requests kept in flight
  prewarmParts: 16,          // parts pulled before the player asks for them
  prewarmTail: true,         // m4a/mp4 keep their index at the end of the file
  cacheLimitMb: 3072,
  // Files on a DC other than the account's need an exported sender, which costs
  // an auth export to open and which gramjs drops after 30s idle. See
  // TrackCache.startKeepAlive for the measurement.
  keepSenderWarm: true,
  reduceMotion: false,
};
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

// A number arriving from the renderer can be a string, a NaN, or absent, and a
// bad value here would break every download rather than just one setting.
function clampInt(value, min, max, fallback) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function readSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return { ...SETTINGS_DEFAULTS, ...(data && typeof data === 'object' ? data : {}) };
  } catch { return { ...SETTINGS_DEFAULTS }; }
}

// Loaded once at startup and mutated in place, because the streaming helpers
// read it on the hot path and should not touch the disk per part.
let settings = readSettings();

function saveSettings(patch) {
  const next = { ...settings };
  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in SETTINGS_DEFAULTS)) continue;   // ignore unknown keys
    next[key] = value;
  }
  next.parallelParts = clampInt(next.parallelParts, 2, 16, SETTINGS_DEFAULTS.parallelParts);
  next.prewarmParts = clampInt(next.prewarmParts, 2, 48, SETTINGS_DEFAULTS.prewarmParts);
  next.cacheLimitMb = clampInt(next.cacheLimitMb, 256, 51200, SETTINGS_DEFAULTS.cacheLimitMb);
  if (!['light', 'dark', 'system'].includes(next.theme)) next.theme = SETTINGS_DEFAULTS.theme;
  if (!PRESET_IDS.includes(next.preset)) next.preset = SETTINGS_DEFAULTS.preset;
  // A dark-only preset with theme:'light' would render its dark palette behind
  // light-mode component rules, so the pairing is corrected on write rather than
  // being left for the renderer to work around.
  if (DARK_ONLY_PRESETS.includes(next.preset)) next.theme = 'dark';
  next.prewarmTail = Boolean(next.prewarmTail);
  next.minimizeToTray = Boolean(next.minimizeToTray);
  next.keepSenderWarm = Boolean(next.keepSenderWarm);
  next.reduceMotion = Boolean(next.reduceMotion);
  settings = next;
  try { fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8'); } catch {}
  return settings;
}

// Chromium resolves the registry settings and the PAC script for us, which is
// how we find the port the user's proxy app actually advertises.
async function detectSystemProxy() {
  try {
    const { session } = require('electron');
    const resolved = await session.defaultSession.resolveProxy('https://149.154.167.51');
    // e.g. "PROXY 127.0.0.1:7897; SOCKS5 127.0.0.1:7897; DIRECT"
    for (const entry of String(resolved || '').split(';')) {
      const match = /^\s*(PROXY|SOCKS5|SOCKS4|SOCKS|HTTPS)\s+([^:\s]+):(\d+)/i.exec(entry);
      if (!match) continue;
      const scheme = match[1].toUpperCase();
      return {
        ip: match[2],
        port: Number(match[3]),
        socksType: scheme === 'SOCKS4' ? 4 : 5,
        // A bare "PROXY"/"HTTPS" line is an HTTP proxy. Clash/Mihomo-style
        // "mixed" ports serve SOCKS5 on the same port, so it's worth trying,
        // but we verify with a real SOCKS5 greeting before committing.
        inferred: scheme === 'PROXY' || scheme === 'HTTPS',
      };
    }
  } catch {}
  return null;
}

// Confirms the port really speaks SOCKS5, so a misconfigured proxy fails fast
// with a precise message instead of another 20s timeout.
function probeSocks5(ip, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = require('net').connect({ host: ip, port });
    let done = false;
    const finish = (value) => { if (done) return; done = true; socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => finish('PROXY_UNREACHABLE'));
    socket.on('error', () => finish('PROXY_UNREACHABLE'));
    socket.on('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00])));
    socket.on('data', (buf) => {
      if (buf.length >= 2 && buf[0] === 0x05 && buf[1] === 0x00) return finish('OK');
      if (buf.length >= 2 && buf[0] === 0x05) return finish('PROXY_NEEDS_AUTH');
      finish('PROXY_NOT_SOCKS5');
    });
  });
}

// Returns { proxy, source, detail } -- proxy is null when going direct.
async function resolveProxy() {
  const config = readProxyConfig();
  if (config.mode === 'direct') return { proxy: null, source: 'direct' };
  if (config.mode === 'manual' && config.ip && config.port) {
    const proxy = { ip: config.ip, port: Number(config.port), socksType: Number(config.socksType) === 4 ? 4 : 5, timeout: 15 };
    if (config.username) { proxy.username = config.username; proxy.password = config.password || ''; }
    const probe = await probeSocks5(proxy.ip, proxy.port);
    if (probe !== 'OK' && probe !== 'PROXY_NEEDS_AUTH') throw new Error(probe);
    return { proxy, source: 'manual' };
  }
  const detected = await detectSystemProxy();
  if (!detected) return { proxy: null, source: 'direct' };
  const probe = await probeSocks5(detected.ip, detected.port);
  // An inferred HTTP port that turns out not to speak SOCKS5 is not an error --
  // fall back to direct and let the connect attempt report the real problem.
  if (probe !== 'OK' && probe !== 'PROXY_NEEDS_AUTH') {
    if (detected.inferred) return { proxy: null, source: 'direct', detail: probe };
    throw new Error(probe);
  }
  return {
    proxy: { ip: detected.ip, port: detected.port, socksType: detected.socksType, timeout: 15 },
    source: 'system',
  };
}

// Dropping the reference alone is not enough: GramJS keeps a 9s ping loop and an
// auto-reconnect chain per client, so an abandoned one goes on talking to
// Telegram forever on the same account. Always destroy before letting go.
async function dropTelegramClient() {
  const client = telegram?.client;
  telegram = null;
  if (!client) return;
  try { await client.destroy(); } catch {}
}

async function makeTelegramClient() {
  let TelegramClient, StringSession;
  try {
    ({ TelegramClient } = require('telegram'));
    ({ StringSession } = require('telegram/sessions'));
  } catch {
    throw new Error('GRAMJS_NOT_INSTALLED');
  }
  await dropTelegramClient();
  const { proxy, source } = await resolveProxy();
  const saved = readSession();
  const client = new TelegramClient(new StringSession(saved.stringSession || ''), DEFAULT_API_ID, DEFAULT_API_HASH, {
    // Retries are low because each blocked attempt costs a full TCP timeout;
    // the hard cap below is what guarantees the UI never hangs.
    connectionRetries: 2,
    timeout: 10,
    useWSS: false,
    ...(proxy ? { proxy } : {}),
  });
  let timer;
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('NETWORK_TIMEOUT')), CONNECT_TIMEOUT_MS); }),
    ]);
  } catch (error) {
    clearTimeout(timer);
    // Leaving a half-open client behind would keep retrying in the background.
    try { await client.destroy(); } catch {}
    const message = String(error?.message || error);
    if (/ETIMEDOUT|NETWORK_TIMEOUT|timeout/i.test(message)) throw new Error('NETWORK_TIMEOUT');
    if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|socks/i.test(message)) throw new Error('NETWORK_UNREACHABLE');
    throw error;
  }
  clearTimeout(timer);
  telegram = { client, apiId: DEFAULT_API_ID, apiHash: DEFAULT_API_HASH, phone: null, phoneCodeHash: null, proxy, proxySource: source };
  return client;
}

// --- CONNECTION_NOT_INITED --------------------------------------------------
// When the TCP link drops, MTProtoSender._reconnect() opens a fresh socket and
// calls _state.reset(), which mints a new MTProto session id. It never re-sends
// InvokeWithLayer(InitConnection), so the server sees an uninitialised session
// and rejects every query with "400: CONNECTION_NOT_INITED". Only
// TelegramClient.connect() sends that init request.
//
// GramJS tries to self-heal in client/users.js, but it tests
// `e.message === "CONNECTION_NOT_INITED"` while RPCError builds message as
// "400: CONNECTION_NOT_INITED (caused by auth.SendCode)" and keeps the bare
// code in `errorMessage`. The comparison never matches, so the error is thrown
// at us instead. We detect it properly and re-init ourselves.
function isNotInited(error) {
  const code = String(error?.errorMessage || '');
  if (code === 'CONNECTION_NOT_INITED') return true;
  return /CONNECTION_NOT_INITED/.test(String(error?.message || error || ''));
}

// connect() is a no-op while the sender still believes it is connected
// (_userConnected short-circuits MTProtoSender.connect), so the disconnect is
// what makes the init request actually go out.
async function reinitConnection(client) {
  try { await client.disconnect(); } catch {}
  await client.connect();
}

// Every MTProto call goes through here so a silent reconnect costs one retry
// instead of failing the user's action.
async function withTelegram(action) {
  if (!telegram?.client) throw new Error('NOT_CONNECTED');
  const client = telegram.client;
  try {
    return await action(client);
  } catch (error) {
    if (!isNotInited(error)) throw error;
    await reinitConnection(client);
    return await action(client);
  }
}

// client.checkAuthorization() catches *every* error and returns false, so one
// transient CONNECTION_NOT_INITED or a dropped socket would present as "you are
// logged out" and bounce the user back to the login screen with a valid session
// still on disk. Invoke directly instead: withTelegram can retry, and only
// Telegram explicitly rejecting the session counts as not-logged-in.
async function isAuthorized() {
  const { Api } = require('telegram');
  try {
    await withTelegram(client => client.invoke(new Api.updates.GetState()));
    return true;
  } catch (error) {
    const message = String(error?.errorMessage || error?.message || error || '');
    if (/AUTH_KEY_(UNREGISTERED|INVALID)|SESSION_(REVOKED|EXPIRED)|USER_DEACTIVATED/i.test(message)) return false;
    throw error;
  }
}

const MIME_BY_EXT = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.m4b': 'audio/mp4', '.mp4': 'audio/mp4',
  '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.flac': 'audio/flac', '.wav': 'audio/wav', '.webm': 'audio/webm',
};

// Shared by the cached-file and MTProto routes so both answer Range identically.
// Returns null when the header is absent or degenerate (whole file), or
// { unsatisfiable: true } when it falls outside the file.
function resolveRange(rangeHeader, size) {
  const parsed = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || '');
  if (!parsed || (parsed[1] === '' && parsed[2] === '')) return null;
  let start = parsed[1] === '' ? null : Number(parsed[1]);
  let end = parsed[2] === '' ? null : Number(parsed[2]);
  if (start === null) { start = Math.max(0, size - end); end = size - 1; }
  if (end === null || end >= size) end = size - 1;
  if (start >= size || start > end) return { unsatisfiable: true };
  return { start, end };
}


// A numeric chat id cannot be handed to getEntity cold after a restart: MTProto
// needs the access hash, which only arrives with the dialog list. Loading dialogs
// once populates GramJS's internal entity cache, and this map keeps the resolved
// objects so playback never re-scans.
const entityCache = new Map();
let dialogsLoaded = false;

async function ensureDialogs() {
  if (dialogsLoaded) return;
  const dialogs = await withTelegram(client => client.getDialogs({ limit: 200 }));
  dialogs.forEach(dialog => { if (dialog.entity) entityCache.set(String(dialog.id), dialog.entity); });
  dialogsLoaded = true;
}

async function resolveEntity(chatId) {
  const key = String(chatId);
  if (entityCache.has(key)) return entityCache.get(key);
  await ensureDialogs();
  if (entityCache.has(key)) return entityCache.get(key);
  const entity = await withTelegram(client => client.getEntity(/^-?\d+$/.test(key) ? Number(key) : key.replace(/^@/, '')));
  entityCache.set(key, entity);
  return entity;
}

// The collected library is persisted so a restart shows tracks instantly instead
// of waiting on a full dialog scan.
const userLibraryPath = () => path.join(app.getPath('userData'), 'user-library.json');

// This is the most revealing file the app writes: every chat title and track name
// the account can see. The data directory is readable by other Windows accounts
// on the machine, so the index goes through safeStorage (DPAPI, bound to this
// Windows user) instead of sitting there as plain JSON.
function readUserLibrary() {
  try {
    const data = JSON.parse(fs.readFileSync(userLibraryPath(), 'utf8'));
    if (data.encryptedLibrary && safeStorage.isEncryptionAvailable()) {
      const plain = JSON.parse(safeStorage.decryptString(Buffer.from(data.encryptedLibrary, 'base64')));
      return { chats: plain.chats || [], tracks: plain.tracks || [] };
    }
    // A library written before this change is still plain JSON. Rewriting it here
    // is what actually removes the plaintext copy -- waiting for the next sync to
    // overwrite it would leave it on disk for as long as the user never syncs.
    const legacy = { chats: data.chats || [], tracks: data.tracks || [] };
    if (data.chats || data.tracks) saveUserLibrary(legacy);
    return legacy;
  } catch { return { chats: [], tracks: [] }; }
}

function saveUserLibrary(library) {
  const payload = { chats: library.chats || [], tracks: library.tracks || [] };
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const blob = safeStorage.encryptString(JSON.stringify(payload)).toString('base64');
      fs.writeFileSync(userLibraryPath(), JSON.stringify({ encryptedLibrary: blob }, null, 2), 'utf8');
      return;
    }
    // Without DPAPI no encryption is possible at all. Dropping the library would
    // be a worse outcome than storing it the way it was stored before, so this
    // falls back rather than failing shut.
    fs.writeFileSync(userLibraryPath(), JSON.stringify(payload, null, 2), 'utf8');
  } catch {}
}

// Listing chats is deliberately separate from scanning them. Scanning every
// dialog for audio costs one getMessages round trip per chat, which is the bulk
// of sync time and mostly wasted on chats the user has no interest in. This just
// reads the dialog list -- one request -- so the picker can appear immediately.
async function listChats() {
  const dialogs = await withTelegram(client => client.getDialogs({ limit: 300 }));
  dialogs.forEach(dialog => { if (dialog.entity) entityCache.set(String(dialog.id), dialog.entity); });
  dialogsLoaded = true;
  return dialogs.filter(dialog => dialog.entity).map(dialog => ({
    id: String(dialog.id),
    title: dialog.title || dialog.name || 'Telegram chat',
    type: dialog.isChannel ? 'channel' : dialog.isGroup ? 'group' : 'private',
    username: dialog.entity?.username || '',
    hasPhoto: Boolean(dialog.entity?.photo && dialog.entity.photo.className !== 'ChatPhotoEmpty'),
  }));
}

// Unlike getUpdates this reads real history, so nothing depends on the 24h
// update window and nothing is capped at 20MB.
// selectedIds limits the scan to the chats the user picked; passing nothing keeps
// the previous behaviour of scanning everything.
async function collectUserAudio(selectedIds = null) {
  const { Api } = require('telegram');
  await ensureDialogs();
  const chats = [];
  const tracks = [];
  const wanted = selectedIds?.length ? new Set(selectedIds.map(String)) : null;
  const dialogs = await withTelegram(client => client.getDialogs({ limit: 300 }));
  for (const dialog of dialogs) {
    if (!dialog.entity) continue;
    const chatId = String(dialog.id);
    if (wanted && !wanted.has(chatId)) continue;
    let messages = [];
    try {
      // Server-side audio filter: far cheaper than pulling all history.
      messages = await withTelegram(client => client.getMessages(dialog.entity, { limit: 200, filter: new Api.InputMessagesFilterMusic() }));
    } catch { continue; }
    let count = 0;
    for (const message of messages) {
      const document = message?.media?.document;
      if (!document) continue;
      const audio = document.attributes?.find(a => a.className === 'DocumentAttributeAudio');
      const name = document.attributes?.find(a => a.className === 'DocumentAttributeFilename')?.fileName || '';
      if (!audio && !/\.(mp3|m4a|m4b|aac|ogg|oga|opus|flac|wav|wma)$/i.test(name)) continue;
      tracks.push({
        id: `${chatId}:${message.id}`,
        title: audio?.title || name.replace(/\.[a-z0-9]+$/i, '') || 'Telegram audio',
        artist: audio?.performer || dialog.title || 'Telegram',
        duration: audio?.duration || 0,
        // Telegram reports the real duration for MTProto audio attributes, so it
        // does not need the frame walker the bot path relies on.
        measured: Boolean(audio?.duration),
        channel: dialog.title || 'Telegram chat',
        chatId,
        messageId: message.id,
        size: Number(document.size) || 0,
        date: message.date || 0,
        source: 'user',
      });
      // The document is in hand right now. Caching its location and inline cover
      // here is what stops the first play and the cover grid from each paying a
      // getMessages round trip per track.
      seedMediaCaches(chatId, message.id, document);
      count += 1;
    }
    if (count) {
      chats.push({
        id: chatId,
        title: dialog.title || 'Telegram chat',
        type: dialog.isChannel ? 'channel' : dialog.isGroup ? 'group' : 'private',
        username: dialog.entity?.username || '',
      });
    }
  }
  tracks.sort((a, b) => b.date - a.date);
  const library = { chats, tracks };
  saveUserLibrary(library);
  return library;
}

// --- Streaming engine -------------------------------------------------------
// Modelled on how Telegram Desktop actually gets smooth seeking, from
// storage/download_manager_mtproto.h and media/streaming/media_streaming_reader.cpp:
//
//   * a fixed part size (kDownloadPartSize = 128KB there)
//   * MANY parts in flight at once -- 4 to start and up to 16 per session
//     (kStartWaitedInSession / kMaxWaitedInSession), over up to 8 sessions
//   * parts retained in slices, so seeking backwards is a local read, plus
//     kPreloadPartsAhead = 8 parts pulled ahead of the read head
//
// GramJS's iterDownload does the exact opposite: one upload.GetFile at a time,
// strictly awaited in sequence (downloads.js _loadNextChunk), retaining nothing.
// Over a proxy at ~250ms round trip that ceiling is about one part per RTT no
// matter how fast the link is, and every seek threw away everything already
// downloaded and started over -- which is why playback took seconds to start and
// dragging the bar stalled.
//
// MTProto multiplexes requests over one connection, so N GetFile calls can be
// outstanding at once. Parts also land in a disk cache, so a repeat listen or a
// backwards seek costs no network at all.
// 512KB is gramjs's own MAX_CHUNK_SIZE and the largest GetFile will serve. At
// 256KB a 3-minute track needed twice the round trips for the same bytes, and
// round trips -- not bandwidth -- are what made starting a track feel slow.
// It stays a constant rather than a setting because the .bin cache is laid out
// at index * PART_SIZE; changing it per-user would misread every existing file.
// The meta records it so an older 256KB cache is discarded instead of misread.
const PART_SIZE = 512 * 1024;   // multiple of GetFile's required 4096 alignment
const cacheDir = () => path.join(app.getPath('userData'), 'media-cache');
const parallelParts = () => clampInt(settings.parallelParts, 2, 16, 8);
const prewarmParts = () => clampInt(settings.prewarmParts, 2, 48, 16);
const cacheLimitBytes = () => clampInt(settings.cacheLimitMb, 256, 51200, 3072) * 1024 * 1024;

// Resolving a message costs a getMessages round trip, and the old code paid it
// twice per play and again on every seek. The document location is stable, so
// hold onto it.
const mediaInfoCache = new Map();

// Split out from getMediaInfo so the library scan -- which already holds every
// document -- can seed the cache without paying for a second getMessages.
function buildMediaInfo(chatId, messageId, document) {
  const { Api } = require('telegram');
  const name = document.attributes?.find(a => a.className === 'DocumentAttributeFilename')?.fileName || '';
  const audio = document.attributes?.find(a => a.className === 'DocumentAttributeAudio');
  return {
    key: `${chatId}:${messageId}`, chatId: String(chatId), messageId: Number(messageId),
    location: new Api.InputDocumentFileLocation({
      id: document.id, accessHash: document.accessHash, fileReference: document.fileReference, thumbSize: '',
    }),
    documentId: document.id, accessHash: document.accessHash, fileReference: document.fileReference,
    dcId: document.dcId,
    size: Number(document.size),
    mime: MIME_BY_EXT[(path.extname(name) || '').toLowerCase()] || document.mimeType || 'audio/mpeg',
    duration: audio?.duration || 0,
    title: audio?.title || '',
    performer: audio?.performer || '',
    thumbs: document.thumbs || [],
  };
}

async function getMediaInfo(chatId, messageId, force = false) {
  const key = `${chatId}:${messageId}`;
  if (!force && mediaInfoCache.has(key)) return mediaInfoCache.get(key);
  const entity = await resolveEntity(chatId);
  const messages = await withTelegram(client => client.getMessages(entity, { ids: Number(messageId) }));
  const message = Array.isArray(messages) ? messages[0] : messages;
  const document = message?.media?.document;
  if (!document) throw new Error('MEDIA_NOT_FOUND');
  const info = buildMediaInfo(chatId, messageId, document);
  mediaInfoCache.set(key, info);
  return info;
}

const safeName = (value) => String(value).replace(/[^a-z0-9_-]/gi, '_');

class TrackCache {
  constructor(info) {
    this.info = info;
    this.partCount = Math.max(1, Math.ceil(info.size / PART_SIZE));
    this.have = new Set();
    this.pending = new Map();
    this.binPath = path.join(cacheDir(), `${safeName(info.key)}.bin`);
    this.metaPath = path.join(cacheDir(), `${safeName(info.key)}.json`);
    this.fd = null;
    this.saveTimer = null;
    this.keepAliveTimer = null;
    this.load();
  }

  load() {
    try {
      const meta = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
      // A size mismatch means the file was replaced, so the old parts are junk.
      if (meta.size !== this.info.size || !Array.isArray(meta.have)) return;
      // The .bin is laid out at index * PART_SIZE, so a cache written under a
      // different part size has its parts at the wrong offsets. Meta from before
      // this field existed was 256KB; either way, treat it as empty rather than
      // serving shifted bytes, which would sound like corruption.
      if ((meta.partSize || 256 * 1024) !== PART_SIZE) return;
      if (!fs.existsSync(this.binPath)) return;
      meta.have.forEach(index => { if (index < this.partCount) this.have.add(index); });
    } catch {}
  }

  metaJson() {
    return JSON.stringify({ size: this.info.size, partSize: PART_SIZE, have: [...this.have] });
  }

  // A part completes every few dozen milliseconds while streaming, so rewriting
  // the index each time would cost more than the download does.
  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try { fs.writeFileSync(this.metaPath, this.metaJson(), 'utf8'); } catch {}
    }, 1000);
  }

  openFile() {
    if (this.fd !== null) return this.fd;
    fs.mkdirSync(cacheDir(), { recursive: true });
    // 'r+' requires the file to exist and 'w' would truncate a cache we want to
    // keep, so create it only when it is actually missing.
    if (!fs.existsSync(this.binPath)) fs.closeSync(fs.openSync(this.binPath, 'w'));
    this.fd = fs.openSync(this.binPath, 'r+');
    return this.fd;
  }

  partLength(index) { return Math.min(PART_SIZE, this.info.size - index * PART_SIZE); }

  // undefined means "use the main, already-connected sender". Only a document
  // genuinely on another DC needs the exported-sender detour; see downloadPart.
  senderDc() {
    const documentDc = Number(this.info.dcId);
    if (!Number.isFinite(documentDc) || documentDc <= 0) return undefined;
    const sessionDc = Number(telegram?.client?.session?.dcId);
    if (Number.isFinite(sessionDc) && sessionDc === documentDc) return undefined;
    return documentDc;
  }

  readPart(index) {
    const length = this.partLength(index);
    const buffer = Buffer.alloc(length);
    fs.readSync(this.openFile(), buffer, 0, length, index * PART_SIZE);
    return buffer;
  }

  // Keeps the exported sender for the file's DC from being torn down.
  //
  // When a document lives on a different DC than the account, the first request
  // has to open a fresh connection and run auth.ExportAuthorization plus
  // InvokeWithLayer(ImportAuthorization) before any audio byte moves. gramjs
  // caches one exported sender per DC, but EXPORTED_SENDER_RELEASE_TIMEOUT
  // (30s, telegramBaseClient.js) disconnects it once idle -- so pausing for
  // half a minute and pressing play again pays that whole setup a second time.
  //
  // The ping is a 4096-byte GetFile -- the smallest legal request, and one we
  // are already authorised to make -- purely so the release timer resets. It
  // only runs while a track is actually loaded, and only when the file really
  // lives on another DC.
  startKeepAlive() {
    if (this.keepAliveTimer || !settings.keepSenderWarm) return;
    if (this.senderDc() === undefined) return;
    this.keepAliveTimer = setInterval(() => {
      const { Api } = require('telegram');
      const bigInt = require('big-integer');
      withTelegram(client => client.invoke(new Api.upload.GetFile({
        location: this.info.location,
        offset: bigInt(0),
        limit: 4096,
      }), this.senderDc())).catch(() => {});
    }, 20000);
    // Node would hold the process open on this alone; it is a background nicety.
    if (this.keepAliveTimer.unref) this.keepAliveTimer.unref();
  }

  stopKeepAlive() {
    if (!this.keepAliveTimer) return;
    clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  writePart(index, bytes) {
    fs.writeSync(this.openFile(), bytes, 0, bytes.length, index * PART_SIZE);
    this.have.add(index);
    this.scheduleSave();
  }

  // One shared promise per part index. Chromium fires overlapping Range requests
  // constantly while seeking, and without this the same bytes would be pulled
  // several times over.
  fetchPart(index) {
    if (this.have.has(index)) {
      try { return Promise.resolve(this.readPart(index)); } catch { this.have.delete(index); }
    }
    if (this.pending.has(index)) return this.pending.get(index);
    const task = this.downloadPart(index).finally(() => this.pending.delete(index));
    this.pending.set(index, task);
    return task;
  }

  async downloadPart(index, retried = false) {
    const { Api } = require('telegram');
    const bigInt = require('big-integer');
    try {
      // Only hand gramjs a dcId when the file really lives on another DC.
      //
      // This is the single biggest start-up cost that was being paid needlessly.
      // In telegramBaseClient.js, getSender(dcId) returns
      //   dcId ? this._borrowExportedSender(dcId) : Promise.resolve(this._sender)
      // so passing a dcId ALWAYS leaves the already-connected main sender and takes
      // the exported-sender path, which opens a fresh TCP connection through the
      // proxy and -- when session.dcId !== dcId -- also pays auth.ExportAuthorization
      // plus InvokeWithLayer(ImportAuthorization) before the first byte moves.
      // Worse, EXPORTED_SENDER_RELEASE_TIMEOUT disconnects that sender after 30s
      // idle, so the next track after a pause paid the whole setup again.
      //
      // When the document is on our own DC the main sender can serve it directly,
      // and MTProto multiplexes, so the parallel parts still go out together.
      const result = await withTelegram(client => client.invoke(new Api.upload.GetFile({
        location: this.info.location,
        offset: bigInt(index * PART_SIZE),
        limit: PART_SIZE,
      }), this.senderDc()));
      const bytes = result?.bytes || Buffer.alloc(0);
      if (bytes.length) this.writePart(index, bytes);
      return bytes;
    } catch (error) {
      const message = String(error?.errorMessage || error?.message || error);
      // File references expire. Refetching the message mints a fresh one; every
      // other error is real and belongs to the caller.
      if (!retried && /FILE_REFERENCE|FILEREF/i.test(message)) {
        const fresh = await getMediaInfo(this.info.chatId, this.info.messageId, true);
        this.info.location = fresh.location;
        this.info.dcId = fresh.dcId;
        return this.downloadPart(index, true);
      }
      throw error;
    }
  }

  // Yields the requested byte range in order while keeping the pipe full.
  //
  // Two separate limits, which is the whole point. The previous version had one
  // map and only refilled it just after a yield, so while the HTTP socket was
  // applying backpressure -- exactly when the player is comfortably buffered and
  // this is the moment to race ahead -- no new GetFile went out at all. Read-ahead
  // was throttled to the player's consumption rate, so a seek past the buffered
  // region always started cold.
  //
  //   inFlight -- requests issued but not yet resolved; held at parallelParts()
  //   window   -- resolved parts waiting to be yielded; capped so a slow consumer
  //               cannot pull the whole file into memory
  //
  // Refills are driven by parts *landing* rather than by the consumer, so the
  // network keeps working through backpressure. Anything fetched but never
  // yielded is already written to disk, so it is not wasted work.
  async *read(start, end, isAborted) {
    const firstPart = Math.floor(start / PART_SIZE);
    const lastPart = Math.min(this.partCount - 1, Math.floor(end / PART_SIZE));
    const concurrency = parallelParts();
    const lookahead = Math.max(concurrency * 3, concurrency + 4);
    const window = new Map();
    let next = firstPart;
    let inFlight = 0;
    let finished = false;
    const topUp = () => {
      if (finished) return;
      while (next <= lastPart && inFlight < concurrency && window.size < lookahead) {
        const index = next;
        next += 1;
        inFlight += 1;
        const task = this.fetchPart(index);
        window.set(index, task);
        // A settling request is what frees a slot, so refill from here rather than
        // from the consumer loop. The rejection arm only releases the slot -- the
        // consumer still awaits the original task, so real errors surface there.
        task.then(() => { inFlight -= 1; topUp(); }, () => { inFlight -= 1; });
      }
    };
    topUp();
    try {
      for (let index = firstPart; index <= lastPart; index += 1) {
        if (isAborted()) return;
        const bytes = await window.get(index);
        window.delete(index);
        topUp();
        if (!bytes || !bytes.length) return;
        const partStart = index * PART_SIZE;
        const from = index === firstPart ? start - partStart : 0;
        const to = Math.min(bytes.length, end - partStart + 1);
        if (to <= from) return;
        yield bytes.subarray(from, to);
      }
    } finally {
      // A range gets abandoned constantly -- every seek and every closed tab does
      // it. Stop issuing new requests and drop the buffers; parts already in the
      // air still land in the disk cache, so they benefit the next read.
      finished = true;
      window.clear();
    }
  }

  close() {
    this.stopKeepAlive();
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    try { fs.writeFileSync(this.metaPath, this.metaJson(), 'utf8'); } catch {}
    if (this.fd !== null) { try { fs.closeSync(this.fd); } catch {} this.fd = null; }
  }
}

const trackCaches = new Map();
function getTrackCache(info) {
  const existing = trackCaches.get(info.key);
  if (existing && existing.info.size === info.size) return existing;
  if (existing) existing.close();
  const cache = new TrackCache(info);
  trackCaches.set(info.key, cache);
  pruneCache();
  return cache;
}

// A part file is sparse: seeking to the end of a two-hour track writes part 600
// and leaves a hole where 1..599 will go, so the file *length* is the whole track
// while the bytes actually on disk may be a few MB. statSync reports the length,
// which made the old accounting over-count badly and evict caches long before the
// ceiling was really reached. The meta index knows exactly how many parts landed,
// so count those instead and only fall back to the length when it is unreadable.
function cacheFileBytes(binPath, apparentSize) {
  try {
    const meta = JSON.parse(fs.readFileSync(binPath.replace(/\.bin$/, '.json'), 'utf8'));
    if (Array.isArray(meta.have)) return meta.have.length * (meta.partSize || 256 * 1024);
  } catch {}
  return apparentSize;
}

// Lists what is on disk with the real occupancy of each entry. Shared by the
// pruner and by the settings page, so the number the user sees is the same one
// the eviction decision uses.
function cacheEntries() {
  const directory = cacheDir();
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter(name => name.endsWith('.bin'))
    .map(name => {
      const full = path.join(directory, name);
      try {
        const stat = fs.statSync(full);
        return { name, full, size: cacheFileBytes(full, stat.size), time: stat.mtimeMs };
      } catch { return null; }
    })
    .filter(Boolean);
}

// Without a ceiling the cache would grow until the disk filled. Oldest files go
// first, and anything currently open is left alone.
function pruneCache() {
  try {
    const limit = cacheLimitBytes();
    const open = new Set([...trackCaches.values()].map(cache => path.basename(cache.binPath)));
    const files = cacheEntries();
    let total = files.reduce((sum, file) => sum + file.size, 0);
    if (total <= limit) return;
    files.sort((a, b) => a.time - b.time);
    for (const file of files) {
      if (total <= limit) break;
      if (open.has(file.name)) continue;
      try {
        fs.unlinkSync(file.full);
        try { fs.unlinkSync(file.full.replace(/\.bin$/, '.json')); } catch {}
        total -= file.size;
      } catch {}
    }
  } catch {}
}

// Frees everything not currently open. Called from the settings page, so it
// reports what it managed to remove rather than throwing on a locked file.
function clearMediaCache() {
  let removed = 0;
  let freed = 0;
  try {
    const open = new Set([...trackCaches.values()].map(cache => path.basename(cache.binPath)));
    for (const file of cacheEntries()) {
      if (open.has(file.name)) continue;
      try {
        fs.unlinkSync(file.full);
        try { fs.unlinkSync(file.full.replace(/\.bin$/, '.json')); } catch {}
        removed += 1;
        freed += file.size;
      } catch {}
    }
  } catch {}
  return { removed, freed };
}

// Pulls the opening parts before the audio element has even asked for them.
// tdesktop does the same thing with kPreloadPartsAhead: by the time the decoder
// wants the header the bytes are already local, so playback starts on a disk read
// instead of a round trip. Deliberately not awaited -- it runs in the background
// and every part it lands is one the stream handler will not have to request.
function prewarm(info) {
  try {
    const cache = getTrackCache(info);
    // Only the track being played should hold a sender open. Without this every
    // track ever opened this session would keep pinging, which is a slow leak of
    // requests rather than a speed-up.
    for (const other of trackCaches.values()) { if (other !== cache) other.stopKeepAlive(); }
    cache.startKeepAlive();
    const ahead = Math.min(prewarmParts(), cache.partCount);
    for (let index = 0; index < ahead; index += 1) {
      // Failures are ignored on purpose: this is speculative, and the real
      // request path will surface any genuine error.
      cache.fetchPart(index).catch(() => {});
    }
    // An MP4 container (.m4a, .mp4) keeps its moov atom -- the seek table and
    // codec setup -- at the END of the file when it was not written for
    // streaming. Chromium therefore issues a Range request for the last few KB
    // before it can decode anything, and on a two-hour file that read head is
    // hundreds of parts away from the prewarmed opening, so playback stalls on a
    // fresh round trip. Warming the tail costs one part and removes that stall.
    // MP3 has no such index, so this is skipped for it.
    if (settings.prewarmTail && /mp4|m4a|aac|ogg|flac/i.test(info.mime || '') && cache.partCount > 1) {
      cache.fetchPart(cache.partCount - 1).catch(() => {});
    }
  } catch {}
}

async function streamMtprotoRange(request, response, chatId, messageId) {
  const info = await getMediaInfo(chatId, messageId);
  const size = info.size;
  const base = { 'Content-Type': info.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  const range = resolveRange(request.headers.range, size);
  if (range?.unsatisfiable) {
    response.writeHead(416, { ...base, 'Content-Range': `bytes */${size}` });
    return response.end();
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  response.writeHead(range ? 206 : 200, range
    ? { ...base, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}` }
    : { ...base, 'Content-Length': size });
  if (request.method === 'HEAD') return response.end();

  // Chromium abandons connections constantly while seeking. Parts already in
  // flight still land in the cache, so nothing is wasted, but the loop has to
  // stop writing to a dead socket.
  let aborted = false;
  response.on('close', () => { aborted = true; });
  const cache = getTrackCache(info);
  for await (const piece of cache.read(start, end, () => aborted)) {
    if (aborted) break;
    if (!response.write(piece)) await new Promise(resolve => response.once('drain', resolve));
  }
  response.end();
}

// --- Artwork ----------------------------------------------------------------
// Cover art rides along with the audio document as a thumbnail, and chat avatars
// come from the peer's profile photo. Both are cached as files so the renderer
// can point an <img> at the local server and never re-fetch.
const artDir = () => path.join(app.getPath('userData'), 'art-cache');

function readArtCache(name) {
  try { return fs.readFileSync(path.join(artDir(), name)); } catch { return null; }
}
function writeArtCache(name, bytes) {
  try { fs.mkdirSync(artDir(), { recursive: true }); fs.writeFileSync(path.join(artDir(), name), bytes); } catch {}
}

// Art files are small and dense, so their apparent size is their real size --
// unlike the sparse .bin parts, which need cacheFileBytes.
function artCacheStats() {
  let files = 0;
  let bytes = 0;
  try {
    for (const name of fs.readdirSync(artDir())) {
      try { bytes += fs.statSync(path.join(artDir(), name)).size; files += 1; } catch {}
    }
  } catch {}
  return { files, bytes };
}

// Covers come back for free on the next library scan, so clearing them is safe.
// The zero-length "no artwork here" markers go too, which is the point when a
// channel has since added artwork that was previously missing.
function clearArtCache() {
  const before = artCacheStats();
  try {
    for (const name of fs.readdirSync(artDir())) {
      try { fs.unlinkSync(path.join(artDir(), name)); } catch {}
    }
  } catch {}
  const after = artCacheStats();
  return { removed: before.files - after.files, freed: before.bytes - after.bytes };
}

async function fetchTrackCover(chatId, messageId) {
  const name = `cover_${safeName(`${chatId}:${messageId}`)}.jpg`;
  const cached = readArtCache(name);
  if (cached) return cached.length ? cached : null;
  const { Api } = require('telegram');
  const info = await getMediaInfo(chatId, messageId);
  const thumbs = info.thumbs || [];
  let bytes = null;
  // A stripped size carries the JPEG inline, so it needs no request at all --
  // it just needs the standard header and footer glued back on.
  const stripped = thumbs.find(thumb => thumb.className === 'PhotoStrippedSize');
  if (stripped?.bytes?.length) {
    try { bytes = require('telegram/Utils').strippedPhotoToJpg(stripped.bytes); } catch {}
  }
  if (!bytes) {
    const sized = thumbs
      .filter(thumb => thumb.className === 'PhotoSize' || thumb.className === 'PhotoCachedSize')
      .sort((a, b) => (b.size || b.bytes?.length || 0) - (a.size || a.bytes?.length || 0))[0];
    if (sized?.bytes?.length) bytes = Buffer.from(sized.bytes);
    else if (sized?.type) {
      try {
        const result = await withTelegram(client => client.invoke(new Api.upload.GetFile({
          location: new Api.InputDocumentFileLocation({
            id: info.documentId, accessHash: info.accessHash, fileReference: info.fileReference, thumbSize: sized.type,
          }),
          offset: require('big-integer')(0),
          limit: 512 * 1024,
        }), info.dcId));
        if (result?.bytes?.length) bytes = result.bytes;
      } catch {}
    }
  }
  // An empty marker file records "this track has no cover", so a track without
  // artwork is not re-requested on every render.
  writeArtCache(name, bytes || Buffer.alloc(0));
  return bytes;
}

// Called from the library scan, which already has the document in hand. Seeding
// here is what makes the cover grid free: a stripped thumbnail is inline in the
// document, so writing it now means the /cover/ route never has to resolve the
// message, and the first play skips a getMessages round trip too.
function seedMediaCaches(chatId, messageId, document) {
  try {
    const info = buildMediaInfo(chatId, messageId, document);
    mediaInfoCache.set(info.key, info);
    const name = `cover_${safeName(info.key)}.jpg`;
    if (readArtCache(name)) return;
    const stripped = (info.thumbs || []).find(thumb => thumb.className === 'PhotoStrippedSize');
    if (!stripped?.bytes?.length) return;
    const bytes = require('telegram/Utils').strippedPhotoToJpg(stripped.bytes);
    if (bytes?.length) writeArtCache(name, bytes);
  } catch {}
}

async function fetchChatAvatar(chatId) {
  const name = `avatar_${safeName(chatId)}.jpg`;
  const cached = readArtCache(name);
  if (cached) return cached.length ? cached : null;
  let bytes = null;
  try {
    const entity = await resolveEntity(chatId);
    const result = await withTelegram(client => client.downloadProfilePhoto(entity, { isBig: false }));
    if (result?.length) bytes = Buffer.from(result);
  } catch {}
  writeArtCache(name, bytes || Buffer.alloc(0));
  return bytes;
}


// Art requests fan out from a whole grid of <img> at once, and unlike the audio
// path they had no ceiling: every visible row could issue its own upload.GetFile
// in the same tick, which is what put runs of "flood wait (Caused by
// upload.GetFile)" in the log. Two rules settle it -- one request per cache key
// at a time, and a small ceiling on how many run together, because artwork is
// decoration and must never crowd out the audio stream.
const ART_CONCURRENCY = 4;
const artInFlight = new Map();
const artWaiting = [];
let artActive = 0;

function artGate() {
  if (artActive < ART_CONCURRENCY) { artActive += 1; return Promise.resolve(); }
  return new Promise(resolve => artWaiting.push(resolve));
}

// Hands a freed slot straight to the next waiter instead of decrementing, so a
// queued request cannot lose the slot to a caller arriving in the same tick.
function artRelease() {
  const next = artWaiting.shift();
  if (next) return next();
  artActive -= 1;
}

// Keyed on the cache file name, which is what makes the sharing safe: two
// callers with the same key would otherwise both miss the cache and both
// download the same bytes.
function artOnce(key, work) {
  if (artInFlight.has(key)) return artInFlight.get(key);
  const task = (async () => {
    await artGate();
    try { return await work(); } finally { artRelease(); }
  })().finally(() => artInFlight.delete(key));
  artInFlight.set(key, task);
  return task;
}

// A cache hit is a local file read, so it is answered before the gate -- a grid
// of already-cached covers must not queue behind four in-flight downloads.
function loadTrackCover(chatId, messageId) {
  const name = `cover_${safeName(`${chatId}:${messageId}`)}.jpg`;
  const cached = readArtCache(name);
  if (cached) return Promise.resolve(cached.length ? cached : null);
  return artOnce(name, () => fetchTrackCover(chatId, messageId));
}

function loadChatAvatar(chatId) {
  const name = `avatar_${safeName(chatId)}.jpg`;
  const cached = readArtCache(name);
  if (cached) return Promise.resolve(cached.length ? cached : null);
  return artOnce(name, () => fetchChatAvatar(chatId));
}

// Artwork is immutable for a given message, so it is safe to let Chromium cache
// it hard -- that is what stops a grid of covers re-hitting the server on scroll.
const ART_HEADERS = { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' };

function startStreamServer() {
  if (streamServer) return;
  streamServer = http.createServer(async (request, response) => {
    if (!telegram?.client) return response.writeHead(503).end('Telegram is not connected');
    const url = request.url || '';
    try {
      const audio = url.match(/^\/telegram\/([^/]+)\/(\d+)/);
      if (audio) return await streamMtprotoRange(request, response, decodeURIComponent(audio[1]), audio[2]);

      const cover = url.match(/^\/cover\/([^/]+)\/(\d+)/);
      if (cover) {
        const bytes = await loadTrackCover(decodeURIComponent(cover[1]), cover[2]);
        if (!bytes) return response.writeHead(404).end();
        return response.writeHead(200, { ...ART_HEADERS, 'Content-Length': bytes.length }).end(bytes);
      }

      const avatar = url.match(/^\/avatar\/([^/]+)/);
      if (avatar) {
        const bytes = await loadChatAvatar(decodeURIComponent(avatar[1]));
        if (!bytes) return response.writeHead(404).end();
        return response.writeHead(200, { ...ART_HEADERS, 'Content-Length': bytes.length }).end(bytes);
      }

      response.writeHead(404).end('Not found');
    } catch (error) {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error.message || error));
    }
  });
  streamServer.listen(0, '127.0.0.1', () => { streamPort = streamServer.address().port; });
}

ipcMain.handle('telegram:connect', async () => {
  try {
    await makeTelegramClient();
    startStreamServer();
    // A noisy auth probe must not fail the connect itself -- the transport is up
    // either way, and the login form is what comes next when this is false.
    let authorized = false;
    try { authorized = await isAuthorized(); } catch {}
    return {
      ok: true,
      authorized,
      proxy: telegram?.proxy ? `${telegram.proxy.ip}:${telegram.proxy.port}` : null,
      proxySource: telegram?.proxySource || 'direct',
    };
  } catch (error) {
    return { ok: false, code: error.message || 'CONNECT_FAILED' };
  }
});

// Read-only view of what the app will egress through, plus what Chromium
// currently resolves, so the modal can show it instead of guessing.
ipcMain.handle('telegram:proxy-config', async () => {
  const config = readProxyConfig();
  const detected = await detectSystemProxy();
  return {
    ok: true,
    mode: config.mode || 'auto',
    ip: config.ip || '',
    port: config.port || '',
    socksType: config.socksType || 5,
    detected: detected ? `${detected.ip}:${detected.port}` : null,
    active: telegram?.proxy ? `${telegram.proxy.ip}:${telegram.proxy.port}` : null,
    activeSource: telegram?.proxySource || null,
  };
});

// Changing the proxy has to drop the existing client, or the app would keep
// using the old route until restart. This writes only the app's own config file.
ipcMain.handle('telegram:set-proxy', async (_event, config) => {
  try {
    const mode = config?.mode === 'manual' ? 'manual' : config?.mode === 'direct' ? 'direct' : 'auto';
    const next = { mode };
    if (mode === 'manual') {
      if (!config?.ip || !config?.port) return { ok: false, code: 'PROXY_INCOMPLETE' };
      next.ip = String(config.ip).trim();
      next.port = Number(config.port);
      next.socksType = Number(config.socksType) === 4 ? 4 : 5;
      if (!Number.isInteger(next.port) || next.port < 1 || next.port > 65535) return { ok: false, code: 'PROXY_INCOMPLETE' };
    }
    saveProxyConfig(next);
    await dropTelegramClient();
    return { ok: true, mode };
  } catch (error) { return { ok: false, code: error.message || 'PROXY_SAVE_FAILED' }; }
});

ipcMain.handle('telegram:send-phone', async (_event, phone) => {
  if (!telegram) return { ok: false, code: 'NOT_CONNECTED' };
  try {
    telegram.phone = phone;
    const result = await withTelegram(client => client.sendCode({ apiId: telegram.apiId, apiHash: telegram.apiHash }, phone));
    telegram.phoneCodeHash = result.phoneCodeHash;
    return { ok: true };
  } catch (error) { return { ok: false, code: error.message || 'SEND_CODE_FAILED' }; }
});

ipcMain.handle('telegram:verify-code', async (_event, code) => {
  if (!telegram) return { ok: false, code: 'NOT_CONNECTED' };
  try {
    await withTelegram(client => client.invoke(new (require('telegram').Api.auth.SignIn)({
      phoneNumber: telegram.phone, phoneCodeHash: telegram.phoneCodeHash, phoneCode: code,
    })));
    persistTelegramSession();
    return { ok: true, authorized: true };
  } catch (error) {
    // RPCError keeps the bare code in errorMessage and formats message as
    // "401: SESSION_PASSWORD_NEEDED (caused by auth.SignIn)". Check both.
    const message = `${error?.errorMessage || ''} ${error?.message || error || ''}`;
    if (message.includes('SESSION_PASSWORD_NEEDED')) return { ok: true, needsPassword: true };
    return { ok: false, code: error?.errorMessage || error?.message || 'SIGN_IN_FAILED' };
  }
});

// client.signInWithPassword() is unusable here: it expects authParams.password to
// be a *callback* (it calls `await authParams.password(hint)`) and authParams.onError
// to be another callback. Passing a plain string makes line 314 of gramjs
// client/auth.js throw "authParams.password is not a function", and its catch block
// then throws "authParams.onError is not a function" on top of it -- which is the
// error that surfaced instead of an actual login. Its retry loop is also `while (1)`
// with no exit on a wrong password.
// The SRP exchange underneath is three calls, so do them directly.
ipcMain.handle('telegram:verify-password', async (_event, password) => {
  if (!telegram) return { ok: false, code: 'NOT_CONNECTED' };
  if (!password) return { ok: false, code: 'PASSWORD_EMPTY' };
  try {
    const { Api } = require('telegram');
    const { computeCheck } = require('telegram/Password');
    await withTelegram(async client => {
      const pwdInfo = await client.invoke(new Api.account.GetPassword());
      const srp = await computeCheck(pwdInfo, password);
      return client.invoke(new Api.auth.CheckPassword({ password: srp }));
    });
    persistTelegramSession();
    return { ok: true, authorized: true };
  } catch (error) {
    return { ok: false, code: error?.errorMessage || error?.message || 'PASSWORD_FAILED' };
  }
});

ipcMain.handle('telegram:library', async () => {
  const library = readUserLibrary();
  return { ok: true, chats: library.chats, tracks: library.tracks, selected: readSelectedChats(), artBase: artBase() };
});

// Covers and avatars are served by the same local server as the audio, so the
// renderer needs its origin to build <img> sources. Returned separately because
// artwork is wanted for the whole list, long before anything is played.
function artBase() {
  if (!streamPort) return null;
  return `http://127.0.0.1:${streamPort}`;
}

ipcMain.handle('telegram:art-base', async () => {
  if (!telegram?.client) return { ok: false, code: 'NOT_CONNECTED' };
  startStreamServer();
  if (!streamPort && streamServer) await new Promise(resolve => streamServer.once('listening', resolve));
  return { ok: Boolean(streamPort), base: artBase() };
});

// --- Chat picking -----------------------------------------------------------
// The selection lives beside the library so a resync reuses it without the user
// re-picking every time.
const selectedChatsPath = () => path.join(app.getPath('userData'), 'selected-chats.json');
function readSelectedChats() {
  try {
    const data = JSON.parse(fs.readFileSync(selectedChatsPath(), 'utf8'));
    return Array.isArray(data) ? data.map(String) : [];
  } catch { return []; }
}
function saveSelectedChats(ids) {
  try { fs.writeFileSync(selectedChatsPath(), JSON.stringify(ids.map(String)), 'utf8'); } catch {}
}

ipcMain.handle('telegram:channels', async () => {
  if (!telegram?.client) return { ok: false, code: 'NOT_CONNECTED' };
  try {
    return { ok: true, chats: await listChats(), selected: readSelectedChats() };
  } catch (error) { return { ok: false, code: error?.errorMessage || error?.message || 'CHANNELS_FAILED' }; }
});

ipcMain.handle('telegram:select-chats', async (_event, ids) => {
  const list = Array.isArray(ids) ? ids.map(String) : [];
  saveSelectedChats(list);
  return { ok: true, selected: list };
});

// --- Playlists --------------------------------------------------------------
// Tracks are referenced by "chatId:messageId" rather than by list position, so a
// resync that reorders the library cannot scramble a playlist.
const playlistsPath = () => path.join(app.getPath('userData'), 'playlists.json');
function readPlaylists() {
  try {
    const data = JSON.parse(fs.readFileSync(playlistsPath(), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}
function savePlaylists(list) {
  try { fs.writeFileSync(playlistsPath(), JSON.stringify(list, null, 2), 'utf8'); } catch {}
}

ipcMain.handle('playlist:list', async () => ({ ok: true, playlists: readPlaylists() }));

ipcMain.handle('playlist:create', async (_event, name) => {
  const title = String(name || '').trim();
  if (!title) return { ok: false, code: 'PLAYLIST_NAME_EMPTY' };
  const playlists = readPlaylists();
  if (playlists.some(item => item.name.toLowerCase() === title.toLowerCase())) return { ok: false, code: 'PLAYLIST_EXISTS' };
  const playlist = { id: `pl_${Date.now().toString(36)}`, name: title, trackIds: [], created: Date.now() };
  playlists.push(playlist);
  savePlaylists(playlists);
  return { ok: true, playlist, playlists };
});

ipcMain.handle('playlist:rename', async (_event, payload = {}) => {
  const title = String(payload.name || '').trim();
  if (!title) return { ok: false, code: 'PLAYLIST_NAME_EMPTY' };
  const playlists = readPlaylists();
  const playlist = playlists.find(item => item.id === payload.id);
  if (!playlist) return { ok: false, code: 'PLAYLIST_NOT_FOUND' };
  playlist.name = title;
  savePlaylists(playlists);
  return { ok: true, playlists };
});

ipcMain.handle('playlist:delete', async (_event, id) => {
  const playlists = readPlaylists().filter(item => item.id !== id);
  savePlaylists(playlists);
  return { ok: true, playlists };
});

ipcMain.handle('playlist:add-tracks', async (_event, payload = {}) => {
  const playlists = readPlaylists();
  const playlist = playlists.find(item => item.id === payload.id);
  if (!playlist) return { ok: false, code: 'PLAYLIST_NOT_FOUND' };
  const incoming = (Array.isArray(payload.trackIds) ? payload.trackIds : []).map(String);
  const before = playlist.trackIds.length;
  const seen = new Set(playlist.trackIds);
  incoming.forEach(trackId => { if (!seen.has(trackId)) { seen.add(trackId); playlist.trackIds.push(trackId); } });
  savePlaylists(playlists);
  return { ok: true, added: playlist.trackIds.length - before, playlists };
});

ipcMain.handle('playlist:remove-tracks', async (_event, payload = {}) => {
  const playlists = readPlaylists();
  const playlist = playlists.find(item => item.id === payload.id);
  if (!playlist) return { ok: false, code: 'PLAYLIST_NOT_FOUND' };
  const drop = new Set((Array.isArray(payload.trackIds) ? payload.trackIds : []).map(String));
  playlist.trackIds = playlist.trackIds.filter(trackId => !drop.has(trackId));
  savePlaylists(playlists);
  return { ok: true, playlists };
});

// Scanning is now limited to the chats the user picked. With nothing selected the
// scan would silently do nothing, so that case is reported rather than returning
// an empty library that looks like a failure.
ipcMain.handle('telegram:sync', async () => {
  if (!telegram?.client) return { ok: false, code: 'NOT_CONNECTED' };
  const selected = readSelectedChats();
  if (!selected.length) return { ok: false, code: 'NO_CHATS_SELECTED' };
  try {
    const before = readUserLibrary().tracks.length;
    const library = await collectUserAudio(selected);
    return { ok: true, added: Math.max(0, library.tracks.length - before), chats: library.chats, tracks: library.tracks };
  } catch (error) { return { ok: false, code: error.message || 'SYNC_FAILED' }; }
});

ipcMain.handle('telegram:stream-url', async (_event, payload = {}) => {
  const { channel, messageId } = payload;
  if (!telegram?.client) return { ok: false, code: 'NOT_CONNECTED' };
  if (!channel || !Number.isFinite(Number(messageId))) return { ok: false, code: 'INVALID_TRACK' };
  startStreamServer();
  if (!streamPort && streamServer) await new Promise(resolve => streamServer.once('listening', resolve));
  if (!streamPort) return { ok: false, code: 'STREAM_SERVER_FAILED' };
  const base = `http://127.0.0.1:${streamPort}`;
  try {
    const info = await getMediaInfo(channel, messageId);
    // Warming the first parts here means the audio element's opening Range
    // request is usually served straight from cache instead of waiting on a round
    // trip. This is tdesktop's kPreloadPartsAhead idea applied at track start.
    prewarm(info);
    return {
      ok: true,
      url: `${base}/telegram/${encodeURIComponent(channel)}/${Number(messageId)}`,
      cover: `${base}/cover/${encodeURIComponent(channel)}/${Number(messageId)}`,
      duration: info.duration,
    };
  } catch (error) { return { ok: false, code: error?.errorMessage || error?.message || 'MEDIA_NOT_FOUND' }; }
});

ipcMain.handle('telegram:logout', async () => {
  try { if (telegram?.client) await telegram.client.logOut(); } catch {}
  await dropTelegramClient();
  saveSession({});
  try { fs.unlinkSync(userLibraryPath()); } catch {}
  entityCache.clear(); dialogsLoaded = false;
  return { ok: true };
});

ipcMain.handle('app:open-external', (_event, url) => { if (typeof url === 'string') shell.openExternal(url); });

// --- Settings IPC -----------------------------------------------------------
// systemDark rides along with every reply because "follow the system" is one of
// the theme choices, and the renderer cannot read the OS preference itself
// through contextIsolation.
function settingsPayload() {
  return { ok: true, settings, defaults: SETTINGS_DEFAULTS, systemDark: nativeTheme.shouldUseDarkColors };
}

ipcMain.handle('settings:get', () => settingsPayload());
ipcMain.handle('settings:set', (_event, patch) => { saveSettings(patch); return settingsPayload(); });

ipcMain.handle('settings:cache-stats', () => {
  const media = cacheEntries();
  return {
    ok: true,
    media: { files: media.length, bytes: media.reduce((sum, file) => sum + file.size, 0) },
    art: artCacheStats(),
    limitBytes: cacheLimitBytes(),
    dir: app.getPath('userData'),
    partSizeKb: PART_SIZE / 1024,
  };
});

ipcMain.handle('settings:clear-cache', (_event, kind) => {
  // The track currently playing keeps its file open, so its parts survive on
  // purpose -- deleting them mid-stream would stall the audio element.
  const media = kind === 'art' ? { removed: 0, freed: 0 } : clearMediaCache();
  const art = kind === 'media' ? { removed: 0, freed: 0 } : clearArtCache();
  return { ok: true, removed: media.removed + art.removed, freed: media.freed + art.freed };
});

ipcMain.handle('settings:open-data-folder', async () => {
  const target = app.getPath('userData');
  const error = await shell.openPath(target);
  return error ? { ok: false, code: error } : { ok: true, dir: target };
});

// A "follow the system" theme has to react when the OS flips, not only when the
// settings page is opened.
nativeTheme.on('updated', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('settings:system-theme', nativeTheme.shouldUseDarkColors);
});
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:toggle-maximize', () => { if (mainWindow?.isMaximized()) mainWindow.unmaximize(); else mainWindow?.maximize(); });
ipcMain.on('window:close', () => mainWindow?.close());

// A frameless window still shows in the taskbar and the Alt-Tab switcher, and
// without this it borrows Electron's default icon -- which is what was showing.
// build.icon in package.json only covers the packaged exe, not a running window.
const APP_ICON = path.join(__dirname, '..', 'assets', 'icon.png');

// --- Tray -------------------------------------------------------------------
// The audio element lives in the renderer, so the tray cannot query or drive
// playback directly. The renderer pushes its state up on every change and the
// tray sends commands down, which keeps one source of truth for playback.
let tray = null;
let isQuitting = false;
let playback = { playing: false, title: '' };

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return createWindow();
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function sendPlayerCommand(command) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('player:command', command);
}

// Rebuilt rather than mutated because an Electron Menu is immutable once built,
// so a label that changes with playback state needs a new template each time.
function renderTray() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: playback.title ? `正在播放：${playback.title}` : '未在播放', enabled: false },
    { type: 'separator' },
    { label: '显示主窗口', click: showWindow },
    { label: playback.playing ? '暂停' : '播放', click: () => sendPlayerCommand('toggle') },
    { label: '下一首', click: () => sendPlayerCommand('next') },
    { label: '上一首', click: () => sendPlayerCommand('previous') },
    { type: 'separator' },
    { label: '退出 TGPlayer', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  // A tray tooltip is capped near 127 characters on Windows; a long track title
  // would otherwise be dropped rather than truncated.
  const tip = playback.title ? `TGPlayer · ${playback.title}` : 'TGPlayer';
  tray.setToolTip(tip.length > 120 ? `${tip.slice(0, 119)}…` : tip);
}

function createTray() {
  if (tray) return;
  // The source icon is 512px. A tray image has to be resized down or Windows
  // renders it at full size and it is clipped to an unrecognisable corner.
  const image = nativeImage.createFromPath(APP_ICON).resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  renderTray();
}

ipcMain.on('player:state', (_event, next) => {
  const playing = Boolean(next?.playing);
  const title = typeof next?.title === 'string' ? next.title : '';
  // The renderer repaints its player on every timeupdate, so this arrives far
  // more often than the menu actually changes. Rebuilding only on a real change
  // keeps this off the per-second path.
  if (playing === playback.playing && title === playback.title) return;
  playback = { playing, title };
  renderTray();
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480, height: 940, minWidth: 1100, minHeight: 720,
    frame: false, transparent: true, roundedCorners: true, hasShadow: true, backgroundColor: '#00000000',
    icon: APP_ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: false },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  // Hiding instead of closing is what makes this a tray app: audio keeps playing
  // and the MTProto connection stays up. Quitting from the tray sets isQuitting
  // first so this handler lets the real close through.
  mainWindow.on('close', (event) => {
    if (isQuitting || !settings.minimizeToTray) return;
    event.preventDefault();
    mainWindow.hide();
  });
}
// A saved string session has to be read back on launch, or every restart would
// demand a fresh login code even though the session is already on disk.
async function restoreSession() {
  const saved = readSession();
  if (!saved.stringSession) return;
  try {
    await makeTelegramClient();
    // isAuthorized only reports false when Telegram explicitly rejects the
    // session. Anything else throws and lands in the catch, so a network blip on
    // launch no longer looks like a logout.
    if (await isAuthorized()) startStreamServer();
    else await dropTelegramClient();
  } catch { await dropTelegramClient(); }
}

ipcMain.handle('telegram:status', async () => {
  if (!telegram?.client) return { ok: true, connected: false };
  try {
    if (!await isAuthorized()) return { ok: true, connected: false };
    const me = await withTelegram(client => client.getMe());
    return { ok: true, connected: true, user: { name: me?.firstName || me?.username || 'Telegram', username: me?.username || '' } };
  } catch (error) { return { ok: true, connected: false, code: error.message || 'STATUS_FAILED' }; }
});

// The renderer queries status on boot, so a late session restore has to be
// announced or the UI would sit on "not connected" forever.
function notifyStatusChanged() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const contents = mainWindow.webContents;
  if (contents.isLoading()) contents.once('did-finish-load', () => contents.send('telegram:status-changed'));
  else contents.send('telegram:status-changed');
}

// Living in the tray means the process outlives its window, so launching the exe
// again would otherwise start a second copy holding the same session file and
// the same cache directory. The second instance exits and hands focus back.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else app.on('second-instance', showWindow);

// Every quit path routes through here -- the tray menu, an OS shutdown, or a
// close while minimizeToTray is off -- so the window 'close' handler always
// knows whether a close is a real exit or just a hide.
app.on('before-quit', () => { isQuitting = true; });
// Without this the icon survives as a dead ghost in the notification area until
// the user hovers over it.
app.on('will-quit', () => { if (tray) { tray.destroy(); tray = null; } });

app.whenReady().then(() => {
  // The window goes up first. restoreSession() reconnects MTProto, and when
  // Telegram is unreachable that costs the full connect timeout -- awaiting it
  // here meant the window, and therefore the login UI, never appeared at all.
  createWindow();
  createTray();
  restoreSession().finally(notifyStatusChanged);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
// With minimizeToTray on, closing hides the window rather than destroying it, so
// this never fires. It is the exit path for when that setting is off.
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
