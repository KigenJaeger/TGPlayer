// All glyphs come from the SVG sprite in index.html, so no literal symbol ever
// travels through the source and encoding can never corrupt the interface.
const icon = (name, extra = '') => `<svg class="icon${extra ? ' ' + extra : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

const ART_CLASSES = ['art-sunset', 'art-blue', 'art-mint', 'art-rose', 'art-gold', 'art-violet'];
const ART_ICONS = ['disc', 'sparkle', 'moon', 'broadcast', 'cassette', 'note'];
const CHANNEL_TONES = ['amber', 'teal', 'lilac', 'rose'];

// Real data only. Both arrays stay empty until Telegram fills them.
let channels = [];
let tracks = [];

const state = {
  page: 'home', current: -1, playing: false, elapsed: 0, favorites: new Set(),
  // What the <audio> element is actually playing, held by identity rather than by
  // position. A re-sync rebuilds the tracks array, so an index on its own ends up
  // naming whichever track happened to land in that slot.
  playingId: null, playingTrack: null,
  // Likes are kept by track id as well, so unpicking a chat and picking it again
  // later does not silently lose them.
  favoriteIds: new Set(),
  shuffle: false, repeat: 'off', volume: 68, muted: false, sinkId: '',
  queue: [], libraryFilter: 'all', librarySort: 'recent', crossfade: true,
  connected: false, authStep: 'credentials', phone: '', query: '', syncing: false, user: null,
  // GramJS cannot see the system proxy, so the route is app-level config the
  // user can inspect and override. null until the main process reports it.
  proxy: null, proxyEditing: false,
  // Chat picking: chatList is what the account can see, picked is what the user
  // wants scanned. Scanning every dialog was slow and mostly unwanted.
  chatList: [], picked: new Set(), chatQuery: '', loadingChats: false,
  // Multi-select for playlist building.
  selectMode: false, selected: new Set(),
  // The row the context menu was opened on, and the tracks the playlist picker
  // will act on. The picker used to read state.selected directly, which meant it
  // could only ever add a multi-selection, never a single right-clicked row.
  menuTrack: null, playlistTarget: [],
  playlists: [], activePlaylist: null,
  // Base URL of the local media server, used for cover and avatar images.
  artBase: '',
  // Mirrors settings.json in the main process. Kept here so a control can render
  // its current value without an IPC round trip on every repaint.
  settings: null, systemDark: false,
};
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const bridge = () => window.tgPlayer?.telegram;

// The icon follows the kind of message now. A green check beside an error read as
// "this worked", which was actively misleading.
function showToast(message, kind = 'info') {
  $('#toastText').textContent = message;
  const toast = $('#toast');
  toast.classList.remove('is-error', 'is-success');
  if (kind === 'error') toast.classList.add('is-error');
  if (kind === 'success') toast.classList.add('is-success');
  $('#toastIcon').innerHTML = `<use href="#i-${kind === 'error' ? 'shield' : 'check'}"/>`;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 3200);
}
const showError = (message) => showToast(message, 'error');

function formatTime(total) { const value = Math.max(0, Math.floor(total || 0)); return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`; }
// Falls back to the snapshot when the playing track is no longer in the library.
// Deselecting its chat and re-syncing leaves the audio running, and the player has
// to keep naming that file instead of the track that inherited its old index.
function currentTrack() {
  const track = tracks[state.current];
  if (track && (!state.playingId || track.trackId === state.playingId)) return track;
  return state.playingTrack || track || null;
}
// A measured duration beats the element's own estimate. Chromium infers length
// from the first frame's bitrate, which is wrong for headerless VBR files -- the
// same mistake Telegram makes.
function currentDuration() {
  const track = currentTrack();
  if (track?.measured && track.duration) return track.duration;
  const audio = $('#audioElement');
  if (audio && Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;
  return track?.duration || 0;
}

// HTML-escaped because chat and track titles are attacker-influenced text from
// Telegram, and these all go through innerHTML.
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

const coverUrl = (track) => (state.artBase && track ? `${state.artBase}/cover/${encodeURIComponent(track.chatId)}/${track.messageId}` : '');
const avatarUrl = (chatId) => (state.artBase ? `${state.artBase}/avatar/${encodeURIComponent(chatId)}` : '');

// The art server only has a port once it is listening, and that happens after
// sign-in. Without this every cover and avatar URL would come out empty, so it
// runs on boot and again once a connection lands.
async function loadArtBase() {
  if (state.artBase) return state.artBase;
  try {
    const result = await bridge()?.artBase?.();
    if (result?.ok && result.base) state.artBase = result.base;
  } catch {}
  return state.artBase;
}

// Shapes what the main process collected into what the templates expect.
function adoptLibrary(payload) {
  // Read the identities out of the old array first: the moment tracks is reassigned
  // the stored indices mean nothing, which is what made the player bar describe a
  // different song than the one still coming out of the speakers.
  const previousId = state.playingId || tracks[state.current]?.trackId || null;
  const queuedIds = state.queue.map(index => tracks[index]?.trackId).filter(Boolean);
  const likedIds = new Set([...state.favoriteIds, ...[...state.favorites].map(index => tracks[index]?.trackId).filter(Boolean)]);
  const chatTracks = new Map();
  tracks = (payload?.tracks || []).map((track, index) => {
    chatTracks.set(track.chatId, (chatTracks.get(track.chatId) || 0) + 1);
    return {
      ...track,
      trackId: track.id || `${track.chatId}:${track.messageId}`,
      durationText: track.duration ? formatTime(track.duration) : '--:--',
      art: ART_CLASSES[index % ART_CLASSES.length], icon: ART_ICONS[index % ART_ICONS.length], telegram: true,
    };
  });
  channels = (payload?.chats || []).map((chat, index) => ({
    id: chat.id, name: chat.title, desc: chat.type === 'channel' ? 'Telegram 频道' : chat.type === 'private' ? '私聊' : 'Telegram 群组',
    followers: chat.username ? `@${chat.username}` : '', art: ART_ICONS[index % ART_ICONS.length], tone: CHANNEL_TONES[index % CHANNEL_TONES.length],
    synced: `${chatTracks.get(chat.id) || 0} 首`,
  }));
  // Re-resolve every stored position through the ids captured above. A track that
  // left the library drops out of the queue and out of the current slot, but its
  // like is retained by id so re-picking that chat brings it back.
  const positions = new Map(tracks.map((track, index) => [track.trackId, index]));
  state.favoriteIds = likedIds;
  state.current = previousId && positions.has(previousId) ? positions.get(previousId) : -1;
  state.queue = queuedIds.map(id => positions.get(id)).filter(index => index !== undefined);
  state.favorites = new Set([...likedIds].map(id => positions.get(id)).filter(index => index !== undefined));
  // Kept in step while the track is still present, so a measured duration or a
  // freshly loaded cover is not lost; the snapshot only freezes once it is gone.
  if (state.current >= 0) state.playingTrack = tracks[state.current];
  if (state.picked.size === 0 && Array.isArray(payload?.selected)) state.picked = new Set(payload.selected.map(String));
  if (payload?.artBase) state.artBase = payload.artBase;
  renderCollections(); renderFavorites(); renderPlaylists(); updatePlayer();
}

// The gradient stays as the placeholder underneath; the avatar fades in over it
// only if Telegram actually has one, so a chat without a photo degrades cleanly.
function channelTemplate(channel) {
  const meta = [channel.desc, channel.followers].filter(Boolean).join(' &middot; ');
  const url = avatarUrl(channel.id);
  const art = url
    ? `<div class="channel-art ${channel.tone} has-photo">${icon(channel.art)}<img src="${esc(url)}" alt="" loading="lazy" onload="this.classList.add('ready')" onerror="this.remove()"></div>`
    : `<div class="channel-art ${channel.tone}">${icon(channel.art)}</div>`;
  return `<article class="channel-card" data-channel="${esc(channel.name.toLowerCase())}">
    ${art}
    <h3>${esc(channel.name)}</h3><p>${esc(meta)}</p><span class="sync-state"><i></i>${esc(channel.synced)}</span>
  </article>`;
}

function trackTemplate(track, index) {
  const liked = state.favorites.has(index) ? 'liked' : '';
  const playing = index === state.current ? ' is-current' : '';
  const picked = state.selected.has(track.trackId) ? ' is-picked' : '';
  const url = coverUrl(track);
  const art = url
    ? `<div class="track-art ${track.art} has-photo">${icon(track.icon)}<img src="${esc(url)}" alt="" loading="lazy" onload="this.classList.add('ready')" onerror="this.remove()"></div>`
    : `<div class="track-art ${track.art}">${icon(track.icon)}</div>`;
  const box = state.selectMode
    ? `<button class="pick-box${picked ? ' checked' : ''}" data-pick-track="${esc(track.trackId)}" aria-label="选择 ${esc(track.title)}" aria-pressed="${state.selected.has(track.trackId)}">${icon('check')}</button>`
    : '';
  // The checkbox is a sixth grid child, so the row needs the wider template while
  // select mode is on. Done with a class rather than :has() to stay independent of
  // the Chromium version Electron ships.
  return `<div class="track-row${playing}${picked}${state.selectMode ? ' is-selectable' : ''}" data-track-index="${index}" data-track-id="${esc(track.trackId)}" data-search="${esc(`${track.title} ${track.artist} ${track.channel}`)}" data-track-row>
    ${box}${art}<div class="track-main"><strong>${esc(track.title)}</strong><span>${esc(track.artist)}</span></div><span class="track-channel">${esc(track.channel)}</span><span class="track-time">${track.durationText}</span>
    <div class="track-row-actions"><button class="heart-button ${liked}" data-favorite="${index}" aria-label="Favorite">${icon('heart')}</button><button class="track-play" data-play="${index}" aria-label="播放 ${esc(track.title)}">${icon('play', 'icon-fill')}</button></div>
  </div>`;
}

const emptyRow = (message) => `<div class="list-empty">${message}</div>`;
const NO_TRACKS = '还没有音频。先登录 Telegram，再点击同步。';

function libraryMarkup() {
  let list = tracks.map((track, index) => ({ track, index }));
  if (state.libraryFilter === 'liked') list = list.filter(item => state.favorites.has(item.index));
  if (state.librarySort === 'title') list = [...list].sort((a, b) => a.track.title.localeCompare(b.track.title));
  if (!list.length) return emptyRow(tracks.length ? '没有符合条件的曲目。' : NO_TRACKS);
  return list.map(item => trackTemplate(item.track, item.index)).join('');
}

function queueMarkup() {
  if (!state.queue.length) return emptyRow('播放队列是空的。');
  return state.queue.map(index => (tracks[index] ? trackTemplate(tracks[index], index) : '')).join('');
}

function renderCollections() {
  $('#channelGrid').innerHTML = channels.length ? channels.slice(0, 3).map(channelTemplate).join('') : emptyRow('还没有聊天。先登录 Telegram，再点击同步。');
  $('#channelGridLarge').innerHTML = channels.length ? channels.map(channelTemplate).join('') : emptyRow('还没有聊天。先登录 Telegram，再点击同步。');
  $('#trackList').innerHTML = tracks.length ? tracks.slice(0, 6).map((track, index) => trackTemplate(track, index)).join('') : emptyRow(NO_TRACKS);
  $('#libraryList').innerHTML = libraryMarkup();
  $('#queueList').innerHTML = queueMarkup();
  $('#navLibraryCount').textContent = tracks.length;
  $('#libraryLede').textContent = tracks.length ? `已从 Telegram 收集 ${tracks.length} 首。` : '还没有收集到任何内容。';
  applySearchFilter();
}

function renderFavorites() {
  const list = [...state.favorites].filter(index => tracks[index]).map(index => trackTemplate(tracks[index], index)).join('');
  $('#favoritesList').innerHTML = list;
  $('#emptyFavorites').style.display = list ? 'none' : 'flex';
  $('#favoriteCount').textContent = `已收藏 ${state.favorites.size} 首`;
}

function applySearchFilter() {
  // The fallback keeps this total: it runs on the autoplay path now, and a row
  // missing the attribute must not be able to stop playback from advancing.
  $$('[data-track-row]').forEach(row => { row.style.display = (row.dataset.search || '').toLowerCase().includes(state.query) ? '' : 'none'; });
  $$('.channel-card').forEach(card => { card.style.display = !state.query || card.dataset.channel.includes(state.query) ? '' : 'none'; });
}

// --- Chat picking -----------------------------------------------------------
// Scanning every dialog cost one round trip per chat and mostly collected audio
// nobody asked for. The list of chats is one request, so it can be shown first
// and only the picked ones get scanned.
function chatRowTemplate(chat) {
  const checked = state.picked.has(String(chat.id));
  const kind = chat.type === 'channel' ? 'Channel' : chat.type === 'group' ? 'Group' : '私聊';
  const handle = chat.username ? `@${chat.username}` : '';
  const url = chat.hasPhoto ? avatarUrl(chat.id) : '';
  const art = url
    ? `<span class="chat-art has-photo">${icon('broadcast')}<img src="${esc(url)}" alt="" loading="lazy" onload="this.classList.add('ready')" onerror="this.remove()"></span>`
    : `<span class="chat-art">${icon('broadcast')}</span>`;
  return `<button class="chat-row${checked ? ' checked' : ''}" data-pick-chat="${esc(chat.id)}" role="checkbox" aria-checked="${checked}" data-chat-search="${esc(`${chat.title} ${handle}`.toLowerCase())}">
    <span class="pick-box${checked ? ' checked' : ''}">${icon('check')}</span>
    ${art}
    <span class="chat-copy"><strong>${esc(chat.title)}</strong><span>${esc([kind, handle].filter(Boolean).join(' · '))}</span></span>
  </button>`;
}

function renderChatPicker() {
  const host = $('#chatPicker');
  if (!host) return;
  // The bar itself stays put, because it holds the button that produces the
  // list -- hiding the bar would hide the only way out of the empty state.
  $('#pickerFilters').hidden = !state.chatList.length;
  if (state.loadingChats) { host.innerHTML = emptyRow('正在读取聊天列表…'); return; }
  if (!state.chatList.length) {
    host.innerHTML = emptyRow(state.connected ? '点击“加载我的聊天”，选择要从哪里找音乐。' : '请先登录 Telegram。');
    return;
  }
  const query = state.chatQuery.trim().toLowerCase();
  const list = query ? state.chatList.filter(chat => `${chat.title} ${chat.username || ''}`.toLowerCase().includes(query)) : state.chatList;
  host.innerHTML = list.length ? list.map(chatRowTemplate).join('') : emptyRow('没有符合条件的聊天。');
  $('#pickerCount').textContent = `已选 ${state.picked.size} 个`;
}

async function loadChatList() {
  if (!state.connected) return showError('请先登录 Telegram。');
  state.loadingChats = true; renderChatPicker();
  // telegram:channels does not carry the art base, and the picker rows want
  // avatars, so make sure the origin is known before the first render.
  await loadArtBase();
  let result;
  try { result = await bridge()?.channels?.(); }
  catch (error) { result = { ok: false, code: String(error?.message || error) }; }
  state.loadingChats = false;
  if (!result?.ok) { renderChatPicker(); return showError(connectErrorMessage(result?.code)); }
  state.chatList = result.chats || [];
  if (Array.isArray(result.selected) && result.selected.length) state.picked = new Set(result.selected.map(String));
  if (result.artBase) state.artBase = result.artBase;
  renderChatPicker();
  showToast(`找到 ${state.chatList.length} 个聊天，勾选有音乐的那些。`);
}

// Persisting the picks separately from the scan means a later resync reuses them
// without the user choosing all over again.
async function persistPicks() {
  try { await bridge()?.selectChats?.([...state.picked]); } catch {}
}

// --- Multi-select -----------------------------------------------------------
function updateSelectionBar() {
  const bar = $('#selectionBar');
  if (!bar) return;
  bar.hidden = !state.selectMode;
  $('#selectedCount').textContent = `已选 ${state.selected.size} 首`;
  $('#selectModeToggle').classList.toggle('is-active', state.selectMode);
  $('#selectModeToggle').setAttribute('aria-pressed', String(state.selectMode));
}

function setSelectMode(on) {
  state.selectMode = on;
  if (!on) state.selected.clear();
  updateSelectionBar();
  renderCollections();
}

function toggleTrackPick(trackId) {
  if (state.selected.has(trackId)) state.selected.delete(trackId); else state.selected.add(trackId);
  updateSelectionBar();
  // Only the checkbox and row tint change, so repainting the whole list would
  // throw away scroll position for nothing.
  $$(`[data-track-id="${CSS.escape(trackId)}"]`).forEach(row => {
    row.classList.toggle('is-picked', state.selected.has(trackId));
    const box = row.querySelector('[data-pick-track]');
    if (box) { box.classList.toggle('checked', state.selected.has(trackId)); box.setAttribute('aria-pressed', String(state.selected.has(trackId))); }
  });
}

// --- Playlists --------------------------------------------------------------
const trackById = (trackId) => tracks.find(track => track.trackId === trackId) || null;

function playlistCardTemplate(playlist) {
  const active = state.activePlaylist === playlist.id ? ' is-active' : '';
  const count = playlist.trackIds.length;
  return `<article class="playlist-card${active}" data-playlist="${esc(playlist.id)}" role="button" tabindex="0">
    <div class="playlist-art">${icon('disc')}</div>
    <h3>${esc(playlist.name)}</h3><p>${count} track${count === 1 ? '' : 's'}</p>
  </article>`;
}

function renderPlaylists() {
  const grid = $('#playlistGrid');
  if (!grid) return;
  grid.innerHTML = state.playlists.length ? state.playlists.map(playlistCardTemplate).join('') : emptyRow('No playlists yet. Select tracks in your library, or press "新建播放列表".');
  $('#navPlaylistCount').textContent = state.playlists.length;
  const playlist = state.playlists.find(item => item.id === state.activePlaylist) || null;
  $('#playlistDetailHead').hidden = !playlist;
  if (!playlist) { $('#playlistTracks').innerHTML = ''; return; }
  $('#playlistDetailName').textContent = playlist.name;
  // A playlist entry can outlive the track it points at -- a resync may drop it.
  // Those are skipped rather than rendered as blanks.
  const rows = playlist.trackIds
    .map(trackId => ({ trackId, track: trackById(trackId) }))
    .filter(item => item.track)
    .map(item => trackTemplate(item.track, tracks.indexOf(item.track)));
  $('#playlistTracks').innerHTML = rows.length ? rows.join('') : emptyRow('这个播放列表还是空的。在音乐库里选中曲目再添加进来。');
  applySearchFilter();
}

async function loadPlaylists() {
  try {
    const result = await window.tgPlayer?.playlists?.list?.();
    if (result?.ok) { state.playlists = result.playlists || []; renderPlaylists(); }
  } catch {}
}

function playlistIndices(playlist) {
  return (playlist?.trackIds || []).map(trackById).filter(Boolean).map(track => tracks.indexOf(track));
}

// Two entry points, one modal. "添加到播放列表" needs a selection and offers the
// existing lists; "新建播放列表" is just the name field, so requiring a selection
// there would make creating an empty playlist impossible.
// trackIds lets a single right-clicked row use the same picker as a
// multi-selection. Omitting it keeps the old behaviour of acting on the
// selection, which is what the selection bar's button wants.
function openPlaylistPicker(mode = 'add', trackIds = null) {
  state.playlistTarget = trackIds ? trackIds.filter(Boolean) : [...state.selected];
  if (mode === 'add' && !state.playlistTarget.length) return showError('请先选择曲目。');
  $('#playlistPickTitle').textContent = mode === 'add' ? '添加到播放列表' : '新建播放列表';
  $('#playlistPickCount').textContent = state.playlistTarget.length
    ? `已选 ${state.playlistTarget.length} 首`
    : '先起个名字，之后再从音乐库添加曲目。';
  $('#playlistPickList').innerHTML = mode === 'add' && state.playlists.length
    ? state.playlists.map(playlist => `<button class="popover-item" data-pick-playlist="${esc(playlist.id)}">${icon('plus')}<span>${esc(playlist.name)}</span><small>${playlist.trackIds.length}</small></button>`).join('')
    : (mode === 'add' ? `<p class="auth-note">还没有播放列表，在下面起个名字。</p>` : '');
  $('#playlistPickName').value = '';
  $('#playlistBackdrop').classList.add('open');
  $('#playlistBackdrop').setAttribute('aria-hidden', 'false');
  setTimeout(() => $('#playlistPickName')?.focus(), 100);
}
function closePlaylistPicker() {
  $('#playlistBackdrop').classList.remove('open');
  $('#playlistBackdrop').setAttribute('aria-hidden', 'true');
}

// The preload takes (id, trackIds) as two arguments and assembles the payload
// itself. Passing one object put the ids under payload.id and left trackIds
// undefined, so nothing was ever added.
async function addSelectionToPlaylist(playlistId) {
  const trackIds = state.playlistTarget.length ? [...state.playlistTarget] : [...state.selected];
  const result = await window.tgPlayer?.playlists?.addTracks?.(playlistId, trackIds);
  if (!result?.ok) return showError(playlistErrorMessage(result?.code));
  state.playlists = result.playlists || state.playlists;
  closePlaylistPicker();
  setSelectMode(false);
  renderPlaylists();
  showToast(result.added ? `已添加 ${result.added} 首。` : '这些曲目已经在该播放列表里了。', 'success');
}

async function createPlaylistWithSelection(name) {
  const result = await window.tgPlayer?.playlists?.create?.(name);
  if (!result?.ok) return showError(playlistErrorMessage(result?.code));
  state.playlists = result.playlists || state.playlists;
  if (state.playlistTarget.length || state.selected.size) return addSelectionToPlaylist(result.playlist.id);
  state.activePlaylist = result.playlist.id;
  closePlaylistPicker();
  renderPlaylists();
  showToast(`已创建“${result.playlist.name}”。`, 'success');
}

function openPlaylist(playlistId) {
  // Clicking the open playlist again closes the detail view, so there is a way
  // back to the plain grid without a separate control.
  state.activePlaylist = state.activePlaylist === playlistId ? null : playlistId;
  renderPlaylists();
}

function activePlaylist() { return state.playlists.find(item => item.id === state.activePlaylist) || null; }

function playActivePlaylist() {
  const playlist = activePlaylist();
  if (!playlist) return showError('请先打开一个播放列表。');
  const indices = playlistIndices(playlist);
  if (!indices.length) return showError('这个播放列表里的曲目都不在音乐库中。');
  // The playlist becomes the queue, and the first entry starts immediately.
  state.queue = indices.slice(1);
  $('#queueList').innerHTML = queueMarkup();
  playTrack(indices[0]);
}

// Electron disables window.prompt, so renaming happens inline: the heading turns
// into a field, Enter commits and Escape restores it.
function beginRenamePlaylist() {
  const playlist = activePlaylist();
  if (!playlist) return showError('请先打开一个播放列表。');
  const head = $('#playlistDetailName');
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = playlist.name;
  input.setAttribute('aria-label', '播放列表名称');
  head.replaceChildren(input);
  input.focus();
  input.select();
  let settled = false;
  const finish = async (commit) => {
    if (settled) return;
    settled = true;
    const name = input.value.trim();
    if (!commit || !name || name === playlist.name) return renderPlaylists();
    const result = await window.tgPlayer?.playlists?.rename?.(playlist.id, name);
    if (!result?.ok) { renderPlaylists(); return showError(playlistErrorMessage(result?.code)); }
    state.playlists = result.playlists || state.playlists;
    renderPlaylists();
    showToast('已重命名', 'success');
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    if (event.key === 'Escape') { event.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

// Deleting is not reversible, so the first press only arms the button.
let deleteArmed = null;
async function deleteActivePlaylist() {
  const playlist = activePlaylist();
  if (!playlist) return showError('请先打开一个播放列表。');
  const button = $('#deletePlaylist');
  if (deleteArmed !== playlist.id) {
    deleteArmed = playlist.id;
    button.classList.add('is-armed');
    button.textContent = '确认删除';
    clearTimeout(deleteActivePlaylist.timer);
    deleteActivePlaylist.timer = setTimeout(() => {
      deleteArmed = null;
      button.classList.remove('is-armed');
      button.textContent = '删除';
    }, 4000);
    return showToast('再按一次删除这个播放列表。');
  }
  clearTimeout(deleteActivePlaylist.timer);
  deleteArmed = null;
  button.classList.remove('is-armed');
  button.textContent = '删除';
  const result = await window.tgPlayer?.playlists?.remove?.(playlist.id);
  if (!result?.ok) return showError(playlistErrorMessage(result?.code));
  state.playlists = result.playlists || state.playlists;
  state.activePlaylist = null;
  renderPlaylists();
  showToast(`已删除“${playlist.name}”。`, 'success');
}

function queueSelectedTracks() {
  const indices = [...state.selected].map(trackId => tracks.indexOf(trackById(trackId))).filter(index => index >= 0);
  if (!indices.length) return showError('请先选择曲目。');
  const added = indices.filter(index => !state.queue.includes(index));
  state.queue.push(...added);
  $('#queueList').innerHTML = queueMarkup();
  applySearchFilter();
  setSelectMode(false);
  showToast(added.length ? `已加入队列 ${added.length} 首。` : '这些曲目已经在队列里了。', 'success');
}

function playlistErrorMessage(code) {
  const value = String(code || '');
  if (value === 'PLAYLIST_NAME_EMPTY') return '请给播放列表起个名字。';
  if (value === 'PLAYLIST_EXISTS') return '已经有同名的播放列表了。';
  if (value === 'PLAYLIST_NOT_FOUND') return '这个播放列表已经不存在了。';
  return connectErrorMessage(value);
}

// --- Track context menu -----------------------------------------------------
// Built as one reusable node rather than per row: a library of 1400 rows would
// otherwise carry 1400 hidden menus. The items offered depend on where the row
// is, so a queue row can offer "remove from queue" and a playlist row can offer
// "remove from this playlist".
function closeTrackMenu() {
  const menu = $('#trackMenu');
  if (!menu) return;
  menu.classList.remove('open');
  menu.setAttribute('aria-hidden', 'true');
  state.menuTrack = null;
}

function trackMenuItems(index, context) {
  const track = tracks[index];
  const liked = state.favorites.has(index);
  const items = [
    { action: 'play', label: '立即播放', icon: 'play' },
    { action: 'play-next', label: '下一首播放', icon: 'next' },
    { action: 'queue', label: '加入播放队列', icon: 'queue' },
    { action: 'playlist', label: '添加到播放列表…', icon: 'plus' },
    { action: 'favorite', label: liked ? '取消收藏' : '添加到收藏', icon: 'heart' },
    { separator: true },
    { action: 'select', label: state.selectMode ? '选择这一首' : '进入多选并选中', icon: 'check' },
  ];
  if (context === 'queue') items.push({ separator: true }, { action: 'queue-remove', label: '从队列移除', icon: 'close', danger: true });
  if (context === 'playlist' && state.activePlaylist) items.push({ separator: true }, { action: 'playlist-remove', label: '从这个播放列表移除', icon: 'close', danger: true });
  return { track, items };
}

function openTrackMenu(index, context, x, y) {
  const menu = $('#trackMenu');
  if (!menu) return;
  const { track, items } = trackMenuItems(index, context);
  if (!track) return;
  state.menuTrack = { index, context, trackId: track.trackId };
  menu.innerHTML = `<p class="menu-head">${esc(track.title)}</p>` + items.map(item => item.separator
    ? '<div class="menu-separator"></div>'
    : `<button class="popover-item${item.danger ? ' is-danger' : ''}" data-track-action="${item.action}">${icon(item.icon)}<span>${esc(item.label)}</span></button>`).join('');
  // Shown before measuring, because a display:none node reports zero size and
  // the menu would then always think it fits.
  menu.classList.add('open');
  menu.setAttribute('aria-hidden', 'false');
  const box = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, window.innerWidth - box.width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - box.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.querySelector('[data-track-action]')?.focus();
}

async function runTrackAction(action) {
  const context = state.menuTrack;
  if (!context) return;
  const { index, trackId } = context;
  closeTrackMenu();
  const track = tracks[index];
  if (!track) return showError('这首曲目已经不在音乐库里了。');

  if (action === 'play') return playTrack(index);

  if (action === 'play-next') {
    state.queue = state.queue.filter(item => item !== index);
    state.queue.unshift(index);
    $('#queueList').innerHTML = queueMarkup();
    applySearchFilter();
    return showToast(`下一首播放：${track.title}`, 'success');
  }

  if (action === 'queue') {
    if (state.queue.includes(index)) return showToast('已经在队列里了。');
    state.queue.push(index);
    $('#queueList').innerHTML = queueMarkup();
    applySearchFilter();
    return showToast('已加入队列。', 'success');
  }

  if (action === 'playlist') return openPlaylistPicker('add', [trackId]);

  if (action === 'favorite') return toggleFavorite(index);

  if (action === 'select') {
    if (!state.selectMode) setSelectMode(true);
    if (!state.selected.has(trackId)) toggleTrackPick(trackId);
    return;
  }

  if (action === 'queue-remove') {
    const at = state.queue.indexOf(index);
    if (at < 0) return;
    state.queue.splice(at, 1);
    $('#queueList').innerHTML = queueMarkup();
    applySearchFilter();
    return showToast('已从队列移除。', 'success');
  }

  if (action === 'playlist-remove') {
    const playlist = activePlaylist();
    if (!playlist) return;
    const result = await window.tgPlayer?.playlists?.removeTracks?.(playlist.id, [trackId]);
    if (!result?.ok) return showError(playlistErrorMessage(result?.code));
    state.playlists = result.playlists || state.playlists;
    renderPlaylists();
    return showToast('已从播放列表移除。', 'success');
  }
}

// Delegation instead of per-render binding: re-rendering no longer stacks duplicate listeners.
function bindDelegatedEvents() {
  document.addEventListener('click', (event) => {
    const play = event.target.closest('[data-play]');
    if (play) { event.stopPropagation(); playTrack(Number(play.dataset.play)); return; }
    const favorite = event.target.closest('[data-favorite]');
    if (favorite) { event.stopPropagation(); toggleFavorite(Number(favorite.dataset.favorite)); return; }
    const pill = event.target.closest('[data-filter]');
    if (pill) { state.libraryFilter = pill.dataset.filter; $$('[data-filter]').forEach(item => item.classList.toggle('active', item === pill)); $('#libraryList').innerHTML = libraryMarkup(); applySearchFilter(); return; }

    // Checked before the row itself, so ticking a checkbox never starts playback.
    const pickTrack = event.target.closest('[data-pick-track]');
    if (pickTrack) { event.stopPropagation(); toggleTrackPick(pickTrack.dataset.pickTrack); return; }
    const pickChat = event.target.closest('[data-pick-chat]');
    if (pickChat) {
      const chatId = String(pickChat.dataset.pickChat);
      if (state.picked.has(chatId)) state.picked.delete(chatId); else state.picked.add(chatId);
      // Written through immediately so a crash or a reload cannot lose the picks.
      persistPicks();
      renderChatPicker();
      return;
    }
    const pickPlaylist = event.target.closest('[data-pick-playlist]');
    if (pickPlaylist) { addSelectionToPlaylist(pickPlaylist.dataset.pickPlaylist); return; }
    const card = event.target.closest('[data-playlist]');
    if (card) { openPlaylist(card.dataset.playlist); return; }

    if (!event.target.closest('#devicePopover') && !event.target.closest('#deviceButton')) closePopover();

    const action = event.target.closest('[data-track-action]');
    if (action) { event.stopPropagation(); runTrackAction(action.dataset.trackAction); return; }
    // Any other click dismisses the menu, matching how the device popover behaves.
    if (!event.target.closest('#trackMenu')) closeTrackMenu();
  });

  // The row's own page decides which removal items make sense, so the context is
  // read from the enclosing page rather than passed down through every template.
  document.addEventListener('contextmenu', (event) => {
    const row = event.target.closest('[data-track-row]');
    if (!row) { closeTrackMenu(); return; }
    event.preventDefault();
    const page = event.target.closest('[data-page-content]')?.dataset.pageContent || '';
    const context = page === 'queue' ? 'queue' : page === 'playlists' ? 'playlist' : 'library';
    openTrackMenu(Number(row.dataset.trackIndex), context, event.clientX, event.clientY);
  });
  document.addEventListener('dblclick', (event) => {
    // In select mode a double click is picking, not playing.
    if (state.selectMode) return;
    const row = event.target.closest('[data-track-row]');
    if (row) playTrack(Number(row.dataset.trackIndex));
  });
  // The playlist cards are role="button" with tabindex, so they have to answer the
  // keyboard the same way a real button would.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target.closest?.('[data-playlist]');
    if (!card) return;
    event.preventDefault();
    openPlaylist(card.dataset.playlist);
  });
}

// Pulls the next queued index, or null when the queue is empty. Shifting here
// rather than in the caller keeps "the queue is what plays next" in one place.
function takeFromQueue() {
  while (state.queue.length) {
    const index = state.queue.shift();
    if (tracks[index]) {
      $('#queueList').innerHTML = queueMarkup();
      applySearchFilter();
      return index;
    }
  }
  return null;
}

// The single place that decides what plays after the current track. The queue
// outranks shuffle and repeat-all, because an explicit "play next" should not be
// overridden by a shuffle toggle the user set an hour ago.
function advance() {
  const queued = takeFromQueue();
  if (queued !== null) return playTrack(queued);
  if (state.repeat === 'all' || state.shuffle) return playTrack(nextIndex(1));
  if (state.current < tracks.length - 1) return playTrack(state.current + 1);
  state.playing = false;
  updatePlayer();
}

function nextIndex(step) {
  if (!tracks.length) return -1;
  if (state.shuffle && step > 0) { if (tracks.length < 2) return state.current; let pick = state.current; while (pick === state.current) pick = Math.floor(Math.random() * tracks.length); return pick; }
  return (state.current + step + tracks.length) % tracks.length;
}

async function playTrack(index) {
  const track = tracks[index];
  if (!track) return showToast(NO_TRACKS);
  state.current = index; state.elapsed = 0;
  // Recorded here so the now-playing panel survives a library rebuild mid-playback.
  state.playingId = track.trackId; state.playingTrack = track;
  renderCollections(); updatePlayer();
  const audio = $('#audioElement');
  // MTProto streams on demand, so playback can begin without downloading the whole file.
  showToast(`正在加载 ${track.title}…`);
  const result = await bridge()?.streamUrl?.({ channel: track.chatId, messageId: track.messageId });
  if (!result?.ok || !result.url) { state.playing = false; updatePlayer(); return showToast(connectErrorMessage(result?.code)); }
  // The main process walked every frame header, so this is the real length.
  if (result.duration) { track.duration = result.duration; track.durationText = formatTime(result.duration); track.measured = true; renderCollections(); }
  audio.src = result.url; applyVolume();
  try { await audio.play(); }
  catch (error) {
    // AbortError just means a newer load superseded this one; only NotAllowedError
    // is an actual block. Reporting both as "blocked" was a misdiagnosis.
    if (error?.name === 'AbortError') return;
    showToast(error?.name === 'NotAllowedError' ? '播放被浏览器拦截' : `播放失败 · ${error?.name || '未知错误'}`);
  }
  updatePlayer();
}

function updateProgress() {
  const duration = currentDuration();
  const percent = duration ? Math.min(100, (state.elapsed / duration) * 100) : 0;
  $('#seekBar').value = percent;
  $('#nowProgress').style.width = `${percent}%`;
  $('#playerElapsed').textContent = formatTime(state.elapsed);
  $('#elapsed').textContent = formatTime(state.elapsed);
  const durationText = duration ? formatTime(duration) : currentTrack()?.durationText || '--:--';
  $('#playerDuration').textContent = durationText;
  $('#nowDuration').textContent = durationText;
}

// The user asked for the playing track's own cover as the player artwork. The
// gradient stays underneath as the placeholder, and the <img> is reused rather
// than recreated so switching tracks does not flash an empty box. A track with
// no cover in Telegram just leaves the gradient showing.
function paintPlayerArt(track) {
  const url = coverUrl(track);
  [$('#nowArt'), $('#miniArt')].forEach(node => {
    if (!node) return;
    let image = node.querySelector('.art-photo');
    if (!url) { if (image) image.remove(); node.classList.remove('has-photo'); return; }

    if (!image) {
      image = document.createElement('img');
      image.className = 'art-photo';
      image.alt = '';
      // The stylesheet keys visibility on `.ready` on the image itself, not on the
      // container -- without it the cover loads and sits at opacity 0, which is why
      // the now-playing tile stayed a bare gradient. A 404 means Telegram has no
      // thumbnail for this file, so both classes come off and the gradient returns
      // rather than showing a broken image.
      image.addEventListener('load', () => { node.classList.add('has-photo'); image.classList.add('ready'); });
      image.addEventListener('error', () => { node.classList.remove('has-photo'); image.classList.remove('ready'); image.removeAttribute('src'); });
      node.appendChild(image);
    }
    if (image.dataset.url !== url) {
      node.classList.remove('has-photo');
      image.classList.remove('ready');
      image.dataset.url = url;
      image.src = url;
    }
  });
}

function updatePlayer() {
  const track = currentTrack();
  $('#playerTitle').textContent = track ? track.title : '未在播放';
  $('#playerArtist').textContent = track ? `${track.artist} · ${track.channel}` : '同步 Telegram 音频即可开始';
  $('#nowTitle').textContent = track ? track.title : '未在播放';
  $('#nowArtist').textContent = track ? `${track.artist} · ${track.channel}` : '未选择曲目';
  $('#nowArtLabel').innerHTML = track ? track.channel.slice(0, 18) : 'TGPLAYER';
  $('#playIcon').innerHTML = state.playing ? icon('pause', 'icon-fill') : icon('play', 'icon-fill');
  $('#playButton').setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
  // Artwork follows the track instead of staying frozen on one gradient.
  const art = track?.art || 'art-sunset';
  [$('#miniArt'), $('#nowArt')].forEach(node => { ART_CLASSES.forEach(name => node.classList.remove(name)); node.classList.add(art); });
  paintPlayerArt(track);
  $('#shuffleButton').classList.toggle('is-active', state.shuffle);
  $('#repeatButton').classList.toggle('is-active', state.repeat !== 'off');
  $('#repeatButton').innerHTML = icon(state.repeat === 'one' ? 'repeat-one' : 'repeat');
  const liked = !!track && state.favoriteIds.has(track.trackId);
  $('#playerHeart').innerHTML = icon('heart'); $('#playerHeart').classList.toggle('liked', liked);
  $('#nowHeart').innerHTML = icon('heart'); $('#nowHeart').classList.toggle('liked', liked);
  updateProgress(); updateVolumeIcon();
  publishPlaybackState();
}

// Shared by the player bar and the tray menu. Nothing is loaded until the first
// play, so "toggle" on a cold start means "start the current track" rather than
// resuming a paused element that does not exist yet.
function togglePlayback() {
  const audio = $('#audioElement');
  if (!tracks.length) return showToast(NO_TRACKS);
  if (!audio.src) return playTrack(state.current >= 0 ? state.current : 0);
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}

// The tray lives in the main process and cannot touch the audio element, so it
// sends intents and the renderer runs them through the same paths the on-screen
// controls use. Keeping one implementation is what stops the two from drifting.
function bindPlayerCommands() {
  window.tgPlayer?.player?.onCommand?.((command) => {
    if (command === 'toggle') return togglePlayback();
    if (command === 'next') return advance();
    if (command === 'previous') {
      // Same rule as the on-screen button: a press after the first few seconds
      // restarts the track instead of skipping back.
      if (state.elapsed > 3) { $('#audioElement').currentTime = 0; return; }
      return playTrack(nextIndex(-1));
    }
  });
}

// Called from updatePlayer, so the tray tooltip and its play/pause label follow
// playback without a second source of truth. Main ignores repeats, so sending on
// every repaint costs nothing.
function publishPlaybackState() {
  const track = currentTrack();
  window.tgPlayer?.player?.publishState?.({
    playing: state.playing,
    title: track ? `${track.title} · ${track.artist}` : '',
  });
}

function applyVolume() { const audio = $('#audioElement'); audio.volume = state.muted ? 0 : state.volume / 100; audio.muted = state.muted; }
function updateVolumeIcon() {
  const silent = state.muted || state.volume === 0;
  $('#volumeIcon').innerHTML = `<use href="#i-${silent ? 'volume-off' : 'volume'}"/>`;
  $('#muteButton').setAttribute('aria-label', silent ? 'Unmute' : 'Mute');
  $('#volumeBar').value = state.muted ? 0 : state.volume;
}

// Keyed by id so it also works for a track that has left the library: the heart in
// the player bar stays lit for whatever is playing, so it has to stay clickable too.
function toggleFavoriteId(trackId) {
  if (!trackId) return;
  const index = tracks.findIndex(item => item.trackId === trackId);
  if (state.favoriteIds.has(trackId)) {
    state.favoriteIds.delete(trackId); state.favorites.delete(index); showToast('已取消收藏');
  } else {
    state.favoriteIds.add(trackId); if (index >= 0) state.favorites.add(index); showToast('已添加到收藏');
  }
  renderCollections(); renderFavorites(); updatePlayer();
}

function toggleFavorite(index) {
  const track = tracks[index];
  if (!track) return;
  toggleFavoriteId(track.trackId);
}

// The player hearts act on what is playing, which is not always something the
// current index can name.
function toggleCurrentFavorite() {
  const track = currentTrack();
  if (!track) return showToast('未选择曲目');
  toggleFavoriteId(track.trackId);
}

// --- Settings ---------------------------------------------------------------
// The main process owns the values so they survive a reload and the streaming
// engine can read them on the hot path. The renderer keeps a mirror in
// state.settings purely so painting a control costs no IPC.

const settingsBridge = () => window.tgPlayer?.settings;

// 'system' has to resolve to a real value here rather than in CSS, because the
// stylesheet keys dark mode off body:not(.light-mode) and knows nothing about
// what Windows is set to.
// Presets whose palette is black-and-neon have no sensible light variant, so
// they render as dark whatever the theme says. Main enforces the same pairing on
// write; this mirror exists so the UI is correct on the very first paint, before
// any round trip.
const DARK_ONLY_PRESETS = ['contrast', 'cyber'];

function applyAppearance() {
  const config = state.settings || {};
  const preset = config.preset || 'blue';
  const theme = config.theme || 'light';
  const dark = DARK_ONLY_PRESETS.includes(preset)
    || theme === 'dark'
    || (theme === 'system' && state.systemDark);
  document.body.classList.toggle('light-mode', !dark);
  // A preset carries the whole palette (surfaces included); accent only retints
  // the highlight on top of it. They are separate attributes because the accent
  // rules are ordered after the preset rules and so keep winning.
  document.body.dataset.preset = preset;
  document.body.dataset.accent = config.accent || 'blue';
  document.body.classList.toggle('reduce-motion', Boolean(config.reduceMotion));
}

async function loadSettings() {
  try {
    const result = await settingsBridge()?.get?.();
    if (!result?.ok) return;
    state.settings = result.settings;
    state.systemDark = Boolean(result.systemDark);
  } catch {}
  // Windows can change its light/dark setting while we are running, and under
  // contextIsolation the renderer cannot read that itself, so main pushes it.
  // Only matters while the theme is "system", but subscribing once here is
  // simpler than attaching and detaching as the choice changes.
  settingsBridge()?.onSystemTheme?.((dark) => {
    state.systemDark = dark;
    applyAppearance();
  });
  applyAppearance();
}

// Every control writes through immediately -- there is no save button, so a
// value the user can see is a value already on disk.
async function patchSettings(patch) {
  state.settings = { ...(state.settings || {}), ...patch };
  applyAppearance();
  renderSettings();
  try {
    const result = await settingsBridge()?.set?.(patch);
    if (result?.ok) { state.settings = result.settings; applyAppearance(); renderSettings(); }
  } catch {}
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
function formatBytes(bytes) {
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

function renderSettings() {
  const config = state.settings;
  if (!config) return;
  // 'active' is the class the stylesheet keys on, the same one the filter pills
  // and nav items use. Writing 'selected' here would have left every choice
  // looking unselected no matter what was stored.
  $$('[data-preset-choice]').forEach(button => button.classList.toggle('active', button.dataset.presetChoice === (config.preset || 'blue')));
  $$('[data-theme-choice]').forEach(button => button.classList.toggle('active', button.dataset.themeChoice === config.theme));
  $$('[data-accent-choice]').forEach(button => button.classList.toggle('active', button.dataset.accentChoice === config.accent));
  // A dark-only preset ignores the theme choice, so leaving the buttons live
  // would offer a switch that visibly does nothing.
  const darkOnly = DARK_ONLY_PRESETS.includes(config.preset || 'blue');
  $$('[data-theme-choice]').forEach(button => { button.disabled = darkOnly; });
  const themeHint = $('#themeHint');
  if (themeHint) {
    themeHint.textContent = darkOnly
      ? '当前主题只有深色版本，浅色选项已停用。'
      : '“跟随系统”会随 Windows 的浅色/深色设置切换。';
  }
  setToggle($('#reduceMotionToggle'), config.reduceMotion);
  setToggle($('#trayToggle'), config.minimizeToTray);
  setToggle($('#prewarmTailToggle'), config.prewarmTail);
  setToggle($('#keepWarmToggle'), config.keepSenderWarm);
  setRange($('#parallelParts'), config.parallelParts, $('#parallelValue'), value => value);
  setRange($('#prewarmParts'), config.prewarmParts, $('#prewarmValue'), value => value);
  // The slider is in whole gigabytes; the stored value is megabytes.
  setRange($('#cacheLimit'), Math.round(config.cacheLimitMb / 1024), $('#cacheLimitValue'), value => `${value} GB`);

  const account = $('#settingsAccount');
  const hint = $('#settingsAccountHint');
  if (account && hint) {
    account.textContent = state.connected ? (state.user?.name || 'Telegram 账号') : '未连接';
    hint.textContent = state.connected
      ? (state.user?.username ? `@${state.user.username}` : '已在本机登录。')
      : '登录后即可同步 Telegram 音频。';
  }
  const route = $('#settingsProxy');
  if (route) {
    const proxy = state.proxy;
    route.textContent = !proxy ? 'Checking…'
      : proxy.enabled === false || !proxy.ip ? '直接连接，未使用代理。'
      : `${String(proxy.type || 'socks5').toUpperCase()} · ${proxy.ip}:${proxy.port}`;
  }
}

function setToggle(node, on) {
  if (!node) return;
  node.classList.toggle('on', Boolean(on));
  node.setAttribute('aria-checked', on ? 'true' : 'false');
}

// Guarded so dragging the slider does not fight with the repaint that follows
// each write: only assign when the value actually differs.
function setRange(node, value, label, format) {
  if (!node) return;
  if (String(node.value) !== String(value)) node.value = value;
  if (label) label.textContent = format(node.value);
}

async function refreshCacheStats() {
  try {
    const result = await settingsBridge()?.cacheStats?.();
    if (!result?.ok) return;
    $('#cacheAudioSize').textContent = formatBytes(result.media.bytes);
    $('#cacheAudioCount').textContent = `${result.media.files} 首`;
    $('#cacheArtSize').textContent = formatBytes(result.art.bytes);
    $('#cacheArtCount').textContent = `${result.art.files} 张`;
    if (result.folder) $('#dataFolderPath').textContent = result.folder;
  } catch {}
}

function bindSettings() {
  // Switching preset also clears the accent override. The accent rules sit after
  // the preset rules in the stylesheet, so a leftover override would repaint the
  // new preset's highlight in the old preset's colour -- picking "Warm Amber"
  // would still show a plum accent. 'blue' is the no-override value.
  $$('[data-preset-choice]').forEach(button => button.addEventListener('click', () => {
    const preset = button.dataset.presetChoice;
    const patch = { preset, accent: 'blue' };
    // Main forces this pairing too, but doing it here as well means the repaint
    // that happens before the IPC reply already shows the right theme.
    if (DARK_ONLY_PRESETS.includes(preset)) patch.theme = 'dark';
    patchSettings(patch);
  }));
  $$('[data-theme-choice]').forEach(button => button.addEventListener('click', () => patchSettings({ theme: button.dataset.themeChoice })));
  $$('[data-accent-choice]').forEach(button => button.addEventListener('click', () => patchSettings({ accent: button.dataset.accentChoice })));
  $('#reduceMotionToggle').addEventListener('click', () => patchSettings({ reduceMotion: !state.settings?.reduceMotion }));
  $('#trayToggle').addEventListener('click', () => patchSettings({ minimizeToTray: !state.settings?.minimizeToTray }));
  $('#prewarmTailToggle').addEventListener('click', () => patchSettings({ prewarmTail: !state.settings?.prewarmTail }));
  $('#keepWarmToggle').addEventListener('click', () => patchSettings({ keepSenderWarm: !state.settings?.keepSenderWarm }));

  // 'input' fires continuously while dragging, so the label follows the thumb;
  // the write waits for 'change' so one drag is one disk write, not fifty.
  $('#parallelParts').addEventListener('input', (event) => { $('#parallelValue').textContent = event.target.value; });
  $('#parallelParts').addEventListener('change', (event) => patchSettings({ parallelParts: Number(event.target.value) }));
  $('#prewarmParts').addEventListener('input', (event) => { $('#prewarmValue').textContent = event.target.value; });
  $('#prewarmParts').addEventListener('change', (event) => patchSettings({ prewarmParts: Number(event.target.value) }));
  $('#cacheLimit').addEventListener('input', (event) => { $('#cacheLimitValue').textContent = `${event.target.value} GB`; });
  $('#cacheLimit').addEventListener('change', (event) => patchSettings({ cacheLimitMb: Number(event.target.value) * 1024 }));

  $('#resetSettings').addEventListener('click', async () => {
    try {
      const current = await settingsBridge()?.get?.();
      if (current?.defaults) await patchSettings(current.defaults);
      showToast('已恢复默认设置。', 'success');
    } catch {}
  });

  $('#openDataFolder').addEventListener('click', () => settingsBridge()?.openDataFolder?.());
  $('#settingsManage').addEventListener('click', openModal);
  bindCacheClear($('#clearAudioCache'), 'media', '音频缓存');
  bindCacheClear($('#clearArtCache'), 'art', 'artwork');
}

// Clearing is destructive and cannot be undone, so both buttons arm on the
// first press and only act on the second, the same pattern the playlist delete
// button uses.
const cacheClearArmed = new Map();
function bindCacheClear(button, kind, label) {
  if (!button) return;
  const original = button.textContent;
  button.addEventListener('click', async () => {
    if (!cacheClearArmed.get(kind)) {
      cacheClearArmed.set(kind, setTimeout(() => { cacheClearArmed.delete(kind); button.textContent = original; button.classList.remove('is-armed'); }, 4000));
      button.textContent = '确认清除';
      button.classList.add('is-armed');
      return;
    }
    clearTimeout(cacheClearArmed.get(kind));
    cacheClearArmed.delete(kind);
    button.textContent = original;
    button.classList.remove('is-armed');
    const result = await settingsBridge()?.clearCache?.(kind);
    if (!result?.ok) return showError(`无法清除${label}。`);
    await refreshCacheStats();
    showToast(result.freed ? `已释放${label} ${formatBytes(result.freed)}。` : `${label}没有可清除的内容。`, 'success');
  });
}

function setPage(page) {
  state.page = page;
  $$('.nav-item').forEach(item => {
    const active = item.dataset.page === page;
    item.classList.toggle('active', active);
    item.toggleAttribute('aria-current', active);
  });
  $$('.page').forEach(item => item.classList.toggle('active', item.dataset.pageContent === page));
  $('#pageCrumb').textContent = ({ home: 'Home', channels: 'Telegram 聊天', library: 'Library', playlists: 'Playlists', queue: 'Queue', favorites: 'Favorites', settings: 'Settings' })[page] || 'Home';
  if (page === 'favorites') renderFavorites();
  if (page === 'playlists') renderPlaylists();
  // Cache sizes change as you listen, so they are read when the page opens
  // rather than held in state and left to go stale.
  if (page === 'settings') {
    renderSettings();
    refreshCacheStats();
    // The proxy route was only ever fetched when the connection modal opened, so
    // a user who went straight to Settings would read "Checking..." forever.
    if (!state.proxy) loadProxyConfig().then(renderSettings);
  }
  // The chat list is one request, so opening the page fetches it once rather than
  // making the user press a button to see anything at all.
  if (page === 'channels' && state.connected && !state.chatList.length && !state.loadingChats) loadChatList();
}

function closePopover() { $('#devicePopover').classList.remove('open'); $('#deviceButton').setAttribute('aria-expanded', 'false'); }

// Real output switching via setSinkId. Chromium hides device labels until audio
// permission is granted, so unnamed outputs get a positional fallback label.
async function openDevicePopover() {
  const popover = $('#devicePopover');
  if (popover.classList.contains('open')) return closePopover();
  let outputs = [];
  try { outputs = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audiooutput'); } catch {}
  const options = [{ deviceId: '', label: '系统默认输出' }, ...outputs
    .filter(device => device.deviceId && device.deviceId !== 'default')
    .map((device, position) => ({ deviceId: device.deviceId, label: device.label || `输出设备 ${position + 1}` }))];
  popover.innerHTML = options.map(option => `<button class="popover-item${option.deviceId === state.sinkId ? ' selected' : ''}" data-sink="${option.deviceId}" role="menuitem">${icon('check')}<span>${option.label}</span></button>`).join('');
  popover.querySelectorAll('[data-sink]').forEach(button => button.addEventListener('click', async () => {
    state.sinkId = button.dataset.sink;
    const audio = $('#audioElement');
    if (audio.setSinkId) { try { await audio.setSinkId(state.sinkId); } catch { showToast('该输出设备不可用'); } }
    showToast(`Output · ${button.textContent.trim()}`); closePopover();
  }));
  popover.classList.add('open');
  $('#deviceButton').setAttribute('aria-expanded', 'true');
}

// GramJS talks raw MTProto over TCP, so it ignores the Windows system proxy and
// PAC script that Chromium follows. The route is therefore shown here rather
// than left implicit -- that mismatch is what made connecting hang silently.
function proxyRow() {
  const info = state.proxy;
  let line = '正在检测网络线路…';
  if (info) {
    if (info.mode === 'direct') line = '直接连接，未使用代理。';
    else if (info.mode === 'manual') line = `正在使用代理 ${info.ip}:${info.port}（SOCKS${info.socksType}）。`;
    else line = info.detected ? `已自动检测到代理 ${info.detected}。` : '未找到系统代理，将直接连接。';
  }
  const form = state.proxyOpen ? `<div class="auth-field"><label>SOCKS5 代理</label><input id="proxyAddress" placeholder="127.0.0.1:7897" value="${info?.ip ? `${info.ip}:${info.port}` : ''}"></div><div class="auth-actions"><button class="soft-button" id="proxyDirect">不用代理</button><button class="soft-button" id="proxyAuto">自动检测</button><button class="primary-button" id="proxySave">Use this proxy</button></div>` : '';
  return `<p class="auth-note">${icon('shield')} ${line} <button class="link-button" id="proxyToggle">${state.proxyOpen ? 'Hide' : 'Change'}</button></p>${form}`;
}

async function loadProxyConfig() {
  try {
    const result = await bridge()?.proxyConfig?.();
    if (result?.ok) { state.proxy = result; if (state.authStep === 'credentials') authView(); }
  } catch {}
}

function authView() {
  // Already signed in: showing the sign-in screen again would be nonsense, and
  // without this branch there was no way to sign out at all.
  if (state.connected && state.authStep === 'credentials') {
    const who = state.user?.username ? `@${state.user.username}` : state.user?.name || '你的 Telegram 账号';
    $('#authSteps').innerHTML = `<h2 class="auth-title">已登录</h2><p class="auth-subtitle">已作为 ${who} 登录。你能看到的所有聊天里的音频都可以在这里播放。</p><div class="auth-actions"><button class="soft-button" id="authSignOut">退出登录</button><button class="primary-button" id="authDone">完成 ${icon('check')}</button></div>`;
    bindAuth();
    return;
  }
  const labels = ['credentials', 'phone', 'code', 'password'];
  const stepIndex = labels.indexOf(state.authStep);
  let content = '';
  if (state.authStep === 'credentials') content = `<h2 class="auth-title">登录 Telegram</h2><p class="auth-subtitle">用你的 Telegram 账号读取你已能访问的聊天中的音频，包括大于 20MB 的文件。</p><p class="auth-note">${icon('shield')} TGPlayer 使用 Telegram Desktop 的公开应用凭据，与参考项目一致。这不是官方客户端，账号可能因此受到限制。加密后的登录会话只保存在本机。</p>${proxyRow()}<div class="auth-actions"><button class="primary-button" id="authContinue">继续 ${icon('arrow-right')}</button></div>`;
  if (state.authStep === 'phone') content = `<h2 class="auth-title">你的手机号</h2><p class="auth-subtitle">Telegram 会向这个号码发送一次性验证码。</p><div class="auth-field"><label>手机号</label><input id="phoneNumber" type="tel" autocomplete="tel" placeholder="+86 138 0000 0000" value="${state.phone}"></div><div class="auth-actions"><button class="soft-button" id="authBack">返回</button><button class="primary-button" id="sendCode">发送验证码 ${icon('arrow-right')}</button></div>`;
  if (state.authStep === 'code') content = `<h2 class="auth-title">查看 Telegram</h2><p class="auth-subtitle">输入 Telegram 发送到你账号的登录验证码。</p><div class="auth-field"><label>登录验证码</label><input id="loginCode" inputmode="numeric" autocomplete="one-time-code" placeholder="12345"></div><div class="auth-actions"><button class="soft-button" id="authBack">返回</button><button class="primary-button" id="verifyCode">验证 ${icon('arrow-right')}</button></div>`;
  if (state.authStep === 'password') content = `<h2 class="auth-title">两步验证</h2><p class="auth-subtitle">输入保护你 Telegram 账号的附加密码。</p><div class="auth-field"><label>密码</label><input id="loginPassword" type="password" autocomplete="current-password" placeholder="Telegram 密码"></div><div class="auth-actions"><button class="soft-button" id="authBack">返回</button><button class="primary-button" id="verifyPassword">打开音乐库 ${icon('arrow-right')}</button></div>`;
  $('#authSteps').innerHTML = `${content}<div class="auth-steps">${labels.map((label, index) => `<i class="auth-step-dot ${index <= stepIndex ? 'active' : ''}"></i>`).join('')}</div>`;
  bindAuth();
}

function openModal() { state.authStep = 'credentials'; state.proxyOpen = false; $('#modalBackdrop').classList.add('open'); $('#modalBackdrop').setAttribute('aria-hidden', 'false'); authView(); loadProxyConfig(); setTimeout(() => $('#authContinue')?.focus(), 100); }
function closeModal() { $('#modalBackdrop').classList.remove('open'); $('#modalBackdrop').setAttribute('aria-hidden', 'true'); }

function connectErrorMessage(code) {
  const value = String(code || '');
  if (value === 'NETWORK_TIMEOUT') return '连接 Telegram 超时，请确认代理正在运行。';
  if (value === 'NETWORK_UNREACHABLE') return '无法连接 Telegram，请检查网络或代理。';
  if (value === 'NETWORK_BAD_RESPONSE') return 'Telegram 返回了异常响应，请重试。';
  if (/CONNECTION_NOT_INITED/i.test(value)) return '与 Telegram 的连接断开了，请重试。';
  if (value === 'PROXY_UNREACHABLE') return '无法连接代理，请确认代理软件正在运行。';
  if (value === 'PROXY_NOT_SOCKS5') return '这个端口不是 SOCKS5 代理，请在代理软件里开启 SOCKS5 或混合端口。';
  if (value === 'PROXY_NEEDS_AUTH') return '这个代理需要用户名和密码。';
  if (value === 'PROXY_INCOMPLETE') return '请同时填写代理主机和端口。';
  if (value === 'GRAMJS_NOT_INSTALLED') return '缺少 Telegram 库，请运行 npm install。';
  if (/PHONE_NUMBER_INVALID/i.test(value)) return '手机号无效，请带上国家区号。';
  if (/PHONE_CODE_(INVALID|EXPIRED)/i.test(value)) return '登录验证码错误或已过期。';
  if (/PASSWORD_HASH_INVALID/i.test(value)) return '两步验证密码不正确。';
  if (value === 'PASSWORD_EMPTY') return '请输入两步验证密码。';
  // The SRP challenge is single-use, so a stale one has to be re-fetched.
  if (/SRP_(ID_INVALID|PASSWORD_CHANGED)/i.test(value)) return '密码校验已过期，请重试。';
  if (/FLOOD_WAIT/i.test(value)) return 'Telegram 暂时限制了登录尝试，请稍后再试。';
  return `连接失败 · ${value || '未知错误'}`;
}

async function bindAuth() {
  $('#proxyToggle')?.addEventListener('click', () => { state.proxyOpen = !state.proxyOpen; authView(); });
  // Each of these drops the current client in the main process, so the next
  // Continue reconnects over the new route instead of the stale one.
  const applyProxy = async (payload, message) => {
    const result = await bridge()?.setProxy?.(payload);
    if (!result?.ok) return showToast(connectErrorMessage(result?.code));
    state.connected = false;
    state.proxyOpen = false;
    await loadProxyConfig();
    updateConnectionCard();
    authView();
    showToast(message);
  };
  $('#proxyDirect')?.addEventListener('click', () => applyProxy({ mode: 'direct' }, '将不使用代理连接'));
  $('#proxyAuto')?.addEventListener('click', () => applyProxy({ mode: 'auto' }, '将自动检测系统代理'));
  $('#proxySave')?.addEventListener('click', () => {
    const raw = $('#proxyAddress')?.value.trim() || '';
    const match = /^(?:socks5?:\/\/)?([^:/\s]+):(\d{1,5})$/i.exec(raw);
    if (!match) return showToast('请按 主机:端口 的格式填写，例如 127.0.0.1:7897');
    applyProxy({ mode: 'manual', ip: match[1], port: Number(match[2]), socksType: 5 }, `已设置代理 ${match[1]}:${match[2]}`);
  });

  // Signing out has to clear the local library too, or the next account would
  // open onto someone else's tracks.
  $('#authSignOut')?.addEventListener('click', async (event) => {
    const button = event.currentTarget; const original = button.innerHTML;
    button.disabled = true; button.textContent = '正在退出登录…';
    try { await bridge()?.logout?.(); } catch {}
    button.disabled = false; button.innerHTML = original;
    state.connected = false; state.user = null; state.phone = '';
    state.current = -1; state.queue = []; state.favorites = new Set();
    state.playingId = null; state.playingTrack = null; state.favoriteIds = new Set();
    adoptLibrary({});
    updateConnectionCard();
    state.authStep = 'credentials'; authView();
    showToast('已退出 Telegram');
  });
  $('#authDone')?.addEventListener('click', closeModal);
  $('#authContinue')?.addEventListener('click', async (event) => {
    const button = event.currentTarget; const original = button.innerHTML;
    button.disabled = true; button.textContent = '正在连接…';
    let result;
    try { result = bridge() ? await bridge().connect() : { ok: false, code: 'NO_BRIDGE' }; }
    catch (error) { result = { ok: false, code: String(error?.message || error) }; }
    button.disabled = false; button.innerHTML = original;
    if (!result.ok) return showToast(connectErrorMessage(result.code));
    if (result.authorized) return finishConnection();
    state.authStep = 'phone'; authView();
  });
  $('#authBack')?.addEventListener('click', () => { state.authStep = state.authStep === 'password' ? 'code' : state.authStep === 'code' ? 'phone' : 'credentials'; authView(); });
  $('#sendCode')?.addEventListener('click', async () => { state.phone = $('#phoneNumber').value.trim(); if (!state.phone) return showToast('请输入手机号'); const result = bridge() ? await bridge().sendPhone(state.phone) : { ok: false, code: 'NO_BRIDGE' }; if (!result.ok) return showToast(connectErrorMessage(result.code)); state.authStep = 'code'; authView(); setTimeout(() => $('#loginCode')?.focus(), 100); });
  $('#verifyCode')?.addEventListener('click', async () => { const value = $('#loginCode').value.trim(); if (!value) return showToast('请输入登录验证码'); const result = bridge() ? await bridge().verifyCode(value) : { ok: false, code: 'NO_BRIDGE' }; if (!result.ok) return showToast(connectErrorMessage(result.code)); if (result.needsPassword) { state.authStep = 'password'; authView(); setTimeout(() => $('#loginPassword')?.focus(), 100); } else await finishConnection(); });
  $('#verifyPassword')?.addEventListener('click', async () => { const value = $('#loginPassword').value; if (!value) return showToast('请输入两步验证密码'); const result = bridge() ? await bridge().verifyPassword(value) : { ok: false, code: 'NO_BRIDGE' }; if (!result.ok) return showToast(connectErrorMessage(result.code)); await finishConnection(); });
}

async function finishConnection() {
  state.connected = true;
  // Ask who we actually signed in as, so the modal can name the account instead
  // of falling back to "你的 Telegram 账号".
  try { const status = await bridge()?.status?.(); state.user = status?.user || null; } catch {}
  updateConnectionCard(); closeModal(); showToast('Telegram 已连接');
  // The art server only starts listening once there is a client, so its origin is
  // unknown until now. Without this covers and avatars would stay blank until a
  // reload.
  await loadArtBase();
  await loadPlaylists();
  await syncLibrary(true);
}

function updateConnectionCard() {
  $('#cloudTitle').textContent = state.connected ? 'Telegram 已连接' : 'Telegram 未连接';
  $('#cloudSubtitle').textContent = state.connected
    ? '你的聊天和音频库已经可以同步了。'
    : '登录后即可播放 Telegram 聊天里的音频。';
  // The settings page shows the same account, so it has to move with this or it
  // would still read "未连接" after a successful sign-in.
  renderSettings();
}

async function syncLibrary(quiet = false) {
  const run = bridge()?.sync;
  if (!run || state.syncing) return;
  state.syncing = true;
  // Sync has two triggers now, so both have to show the same busy state or the
  // topbar copy would sit there looking idle through the whole scan.
  const buttons = $$('[data-sync-button]');
  const originals = buttons.map(item => item.innerHTML);
  buttons.forEach(item => {
    item.disabled = true;
    item.classList.add('is-busy');
    if (item.dataset.syncButton === 'label') item.innerHTML = `${icon('cloud')} 正在同步…`;
  });
  let result;
  try { result = await run(); }
  catch (error) { result = { ok: false, code: String(error?.message || error) }; }
  buttons.forEach((item, index) => {
    item.disabled = false;
    item.classList.remove('is-busy');
    item.innerHTML = originals[index];
  });
  state.syncing = false;
  // Nothing picked yet is the normal first-run state, not a failure. Sending the
  // user to the picker is more use than an error toast on a page they cannot see.
  if (result?.code === 'NO_CHATS_SELECTED') {
    if (quiet) return;
    setPage('channels');
    if (!state.chatList.length) loadChatList();
    return showToast('先选择要听音乐的聊天，然后点击“同步所选”。');
  }
  if (!result?.ok) return showError(connectErrorMessage(result?.code));
  adoptLibrary(result);
  if (result.added) return showToast(`从你的账号收集到 ${result.added} 首新曲目。`);
  if (!quiet) showToast(result.tracks?.length ? `账号音乐库共 ${result.tracks.length} 首。` : '在你的聊天里没有找到音频。');
}

function bindGlobal() {
  $$('.nav-item').forEach(item => item.addEventListener('click', () => setPage(item.dataset.page)));
  $$('[data-page-link]').forEach(button => button.addEventListener('click', () => setPage(button.dataset.pageLink)));
  // The sidebar gear used to reopen the connection modal, which is not what a
  // gear means anywhere else. Connection lives on "管理连接" and in the
  // settings page's Account card; the gear now goes to the settings page.
  $('#manageTelegram').addEventListener('click', openModal); $('#settingsButton').addEventListener('click', () => setPage('settings')); $('#avatarButton').addEventListener('click', openModal); $('#modalClose').addEventListener('click', closeModal); $('#modalBackdrop').addEventListener('click', (event) => { if (event.target === $('#modalBackdrop')) closeModal(); });
  $('#windowMinimize').addEventListener('click', () => window.tgPlayer?.window?.minimize()); $('#windowMaximize').addEventListener('click', () => window.tgPlayer?.window?.toggleMaximize()); $('#windowClose').addEventListener('click', () => window.tgPlayer?.window?.close());

  $('#playButton').addEventListener('click', togglePlayback);
  $('#heroPlay').addEventListener('click', () => playTrack(0));
  $('#mixPlay').addEventListener('click', () => { if (!tracks.length) return showToast(NO_TRACKS); state.shuffle = true; playTrack(Math.floor(Math.random() * tracks.length)); });
  $('#nextButton').addEventListener('click', () => advance());
  $('#previousButton').addEventListener('click', () => { if (state.elapsed > 3) { $('#audioElement').currentTime = 0; return; } playTrack(nextIndex(-1)); });

  $('#shuffleButton').addEventListener('click', () => { state.shuffle = !state.shuffle; updatePlayer(); showToast(state.shuffle ? '随机播放已开启' : '随机播放已关闭'); });
  $('#repeatButton').addEventListener('click', () => {
    state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
    updatePlayer(); showToast({ off: '不循环', all: '列表循环', one: '单曲循环' }[state.repeat]);
  });

  $('#deviceButton').addEventListener('click', openDevicePopover);
  $('#queueButton').addEventListener('click', () => setPage('queue'));
  $('#volumeBar').addEventListener('input', (event) => { state.volume = Number(event.target.value); state.muted = state.volume === 0; applyVolume(); updateVolumeIcon(); });
  $('#muteButton').addEventListener('click', () => { state.muted = !state.muted; if (!state.muted && state.volume === 0) state.volume = 40; applyVolume(); updateVolumeIcon(); showToast(state.muted ? '已静音' : '已取消静音'); });
  $('#expandButton').addEventListener('click', () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => showToast('无法进入全屏')); });
  document.addEventListener('fullscreenchange', () => {
    const full = Boolean(document.fullscreenElement);
    document.body.classList.toggle('is-fullscreen', full);
    $('#expandIcon').innerHTML = `<use href="#i-${full ? 'collapse' : 'expand'}"/>`;
    $('#expandButton').setAttribute('aria-label', full ? '退出全屏' : '全屏');
  });

  $('#playerHeart').addEventListener('click', () => toggleCurrentFavorite());
  $('#nowHeart').addEventListener('click', () => toggleCurrentFavorite());
  $('#moreNow').addEventListener('click', () => { const index = state.current; if (index < 0) return showToast('未选择曲目'); if (!state.queue.includes(index)) { state.queue.push(index); $('#queueList').innerHTML = queueMarkup(); applySearchFilter(); showToast('已加入队列'); } else showToast('已经在队列里了'); });
  // Clamped to what the element will actually seek to, and guarded because
  // assigning currentTime on a non-seekable stream throws InvalidStateError.
  $('#seekBar').addEventListener('input', (event) => {
    const duration = currentDuration();
    const audio = $('#audioElement');
    if (!duration || !audio.src) return;
    let target = (Number(event.target.value) / 100) * duration;
    const ranges = audio.seekable;
    if (ranges && ranges.length) target = Math.min(target, Math.max(0, ranges.end(ranges.length - 1) - 0.25));
    state.elapsed = target;
    try { audio.currentTime = target; } catch { showToast('这个音频还不能拖动进度'); }
    updateProgress();
  });

  $('#sortLibrary').addEventListener('click', () => {
    state.librarySort = state.librarySort === 'recent' ? 'title' : 'recent';
    $('#sortLibrary').innerHTML = `${state.librarySort === 'recent' ? '最近添加' : '按标题 A-Z'} ${icon('chevron-down')}`;
    $('#libraryList').innerHTML = libraryMarkup(); applySearchFilter();
  });
  $('#clearQueue').addEventListener('click', () => { if (!state.queue.length) return showToast('队列已经是空的'); state.queue = []; $('#queueList').innerHTML = queueMarkup(); showToast('队列已清空'); });
  $('#crossfadeToggle').addEventListener('click', () => { state.crossfade = !state.crossfade; $('#crossfadeToggle').classList.toggle('on', state.crossfade); $('#crossfadeToggle').setAttribute('aria-checked', String(state.crossfade)); $('#crossfadeLabel').textContent = state.crossfade ? '交叉淡入淡出已开启' : '交叉淡入淡出已关闭'; });

  $$('[data-sync-button]').forEach(button => button.addEventListener('click', () => syncLibrary()));

  // --- Chat picker ---
  $('#loadChats').addEventListener('click', loadChatList);
  $('#chatFilter').addEventListener('input', (event) => { state.chatQuery = event.target.value; renderChatPicker(); });
  $('#pickerNone').addEventListener('click', () => { state.picked.clear(); persistPicks(); renderChatPicker(); });

  // --- Multi-select ---
  $('#selectModeToggle').addEventListener('click', () => setSelectMode(!state.selectMode));
  $('#selectAll').addEventListener('click', () => {
    // Only the rows actually on screen, so a search filter still means what it says.
    const visible = $$('[data-track-row]').filter(row => row.style.display !== 'none');
    if (!visible.length) return showError('没有可选择的内容。');
    visible.forEach(row => state.selected.add(row.dataset.trackId));
    updateSelectionBar();
    renderCollections();
  });
  $('#selectNone').addEventListener('click', () => { state.selected.clear(); updateSelectionBar(); renderCollections(); });
  $('#queueSelected').addEventListener('click', queueSelectedTracks);
  $('#addToPlaylist').addEventListener('click', () => openPlaylistPicker('add'));

  // --- Playlists ---
  $('#newPlaylist').addEventListener('click', () => openPlaylistPicker('create'));
  $('#playPlaylist').addEventListener('click', playActivePlaylist);
  $('#renamePlaylist').addEventListener('click', beginRenamePlaylist);
  $('#deletePlaylist').addEventListener('click', deleteActivePlaylist);
  $('#playlistPickClose').addEventListener('click', closePlaylistPicker);
  $('#playlistPickCancel').addEventListener('click', closePlaylistPicker);
  $('#playlistBackdrop').addEventListener('click', (event) => { if (event.target === $('#playlistBackdrop')) closePlaylistPicker(); });
  $('#playlistPickCreate').addEventListener('click', () => createPlaylistWithSelection($('#playlistPickName').value.trim()));
  $('#playlistPickName').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); createPlaylistWithSelection(event.target.value.trim()); }
  });

  $('#searchInput').addEventListener('input', (event) => { state.query = event.target.value.toLowerCase(); applySearchFilter(); });
  // The topbar button is the quick path and the settings page is the explicit one,
  // so they have to agree. Toggling a class directly would have left the saved
  // setting behind and the choice would reset on the next launch.
  $('#themeButton').addEventListener('click', () => {
    const order = ['light', 'dark', 'system'];
    const next = order[(order.indexOf(state.settings?.theme || 'light') + 1) % order.length];
    patchSettings({ theme: next });
    showToast(`Theme · ${next}`);
  });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#searchInput').focus(); }
    if (event.key === 'Escape') {
      // Ordered most-transient first, and each step returns, so one Escape
      // dismisses one thing rather than tearing down every open surface at once.
      if ($('#trackMenu')?.classList.contains('open')) return closeTrackMenu();
      if ($('#playlistBackdrop')?.classList.contains('open')) return closePlaylistPicker();
      if ($('#devicePopover')?.classList.contains('open')) return closePopover();
      if ($('#modalBackdrop')?.classList.contains('open')) return closeModal();
      if (state.selectMode) { setSelectMode(false); return showToast('已退出多选。'); }
    }
  });
}

// The audio element is the source of truth now, so the UI cannot drift from
// what is actually playing the way a synthetic ticker did.
function bindAudio() {
  const audio = $('#audioElement');
  audio.addEventListener('timeupdate', () => { state.elapsed = audio.currentTime; updateProgress(); });
  audio.addEventListener('loadedmetadata', updateProgress);
  // Chromium refines duration as it reads further into the file; now that Range
  // works it can actually do that, so the readout has to follow.
  audio.addEventListener('durationchange', updateProgress);
  audio.addEventListener('play', () => { state.playing = true; updatePlayer(); });
  audio.addEventListener('pause', () => { state.playing = false; updatePlayer(); });
  audio.addEventListener('error', () => { if (!audio.src) return; state.playing = false; updatePlayer(); showToast('Telegram 无法提供这个文件'); });
  audio.addEventListener('ended', () => {
    if (state.repeat === 'one') { audio.currentTime = 0; audio.play().catch(() => {}); return; }
    advance();
  });
}

async function refreshStatus() {
  const status = await bridge()?.status?.();
  const wasConnected = state.connected;
  state.connected = status?.connected === true;
  state.user = status?.user || null;
  updateConnectionCard();
  if (state.authStep === 'credentials' && $('#modalBackdrop')?.classList.contains('open')) authView();
  return { wasConnected, connected: state.connected };
}

async function boot() {
  // Settings first, and awaited: the theme and accent are applied from it, so
  // doing this after the first paint would flash the default light blue before
  // switching to whatever the user actually chose.
  await loadSettings();
  applyVolume(); bindDelegatedEvents(); bindGlobal(); bindSettings(); bindAudio(); bindPlayerCommands();
  // Restoring a saved session now happens in the background, so the main process
  // pushes this once it settles. Without it the UI would sit on "not connected".
  bridge_onStatusChanged();
  await refreshStatus();
  // Playlists live on disk independently of the library, so they show up even
  // before a sync. The art base needs the stream server's port, which only
  // exists once signed in -- hence the retry inside loadArtBase.
  await Promise.all([loadPlaylists(), state.connected ? loadArtBase() : Promise.resolve()]);
  const library = await bridge()?.library?.();
  adoptLibrary(library || {});
  if (state.connected) syncLibrary(true);
}

function bridge_onStatusChanged() {
  window.tgPlayer?.telegram?.onStatusChanged?.(async () => {
    const { wasConnected, connected } = await refreshStatus();
    if (connected && !wasConnected) {
      // The stream server comes up with the session, so this is the first moment
      // cover and avatar URLs can resolve.
      await loadArtBase();
      const library = await bridge()?.library?.();
      adoptLibrary(library || {});
      syncLibrary(true);
    }
  });
}

boot();
