const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tgPlayer', {
  telegram: {
    connect: () => ipcRenderer.invoke('telegram:connect'),
    sendPhone: (phone) => ipcRenderer.invoke('telegram:send-phone', phone),
    verifyCode: (code) => ipcRenderer.invoke('telegram:verify-code', code),
    verifyPassword: (password) => ipcRenderer.invoke('telegram:verify-password', password),
    status: () => ipcRenderer.invoke('telegram:status'),
    library: () => ipcRenderer.invoke('telegram:library'),
    artBase: () => ipcRenderer.invoke('telegram:art-base'),
    // mode 'full' re-pages every selected chat; 'incremental' only asks for what
    // is newer than the stored index, which is what launch syncs use.
    sync: (options) => ipcRenderer.invoke('telegram:sync', options || {}),
    cancelSync: () => ipcRenderer.invoke('telegram:sync-cancel'),
    // A full scan of a large chat takes minutes, so the main process pushes how
    // far along it is instead of the renderer guessing from one pending invoke.
    onSyncProgress: (handler) => {
      if (typeof handler !== 'function') return () => {};
      const listener = (_event, payload) => handler(payload || {});
      ipcRenderer.on('telegram:sync-progress', listener);
      return () => ipcRenderer.removeListener('telegram:sync-progress', listener);
    },
    streamUrl: (payload) => ipcRenderer.invoke('telegram:stream-url', payload),
    // Listing chats is separate from scanning them: the picker needs the dialog
    // list (paged once per session, then cached), while scanning costs requests
    // per page of each selected chat.
    channels: () => ipcRenderer.invoke('telegram:channels'),
    selectChats: (ids) => ipcRenderer.invoke('telegram:select-chats', ids),
    logout: () => ipcRenderer.invoke('telegram:logout'),
    proxyConfig: () => ipcRenderer.invoke('telegram:proxy-config'),
    setProxy: (config) => ipcRenderer.invoke('telegram:set-proxy', config),
    // Session restore now finishes after the window is up, so the renderer needs
    // a push to re-read status instead of polling.
    onStatusChanged: (handler) => {
      if (typeof handler !== 'function') return () => {};
      const listener = () => handler();
      ipcRenderer.on('telegram:status-changed', listener);
      return () => ipcRenderer.removeListener('telegram:status-changed', listener);
    },
  },
  favorites: {
    list: () => ipcRenderer.invoke('favorites:list'),
    save: (ids) => ipcRenderer.send('favorites:save', ids),
  },
  playlists: {
    list: () => ipcRenderer.invoke('playlist:list'),
    create: (name) => ipcRenderer.invoke('playlist:create', name),
    rename: (id, name) => ipcRenderer.invoke('playlist:rename', { id, name }),
    remove: (id) => ipcRenderer.invoke('playlist:delete', id),
    addTracks: (id, trackIds) => ipcRenderer.invoke('playlist:add-tracks', { id, trackIds }),
    removeTracks: (id, trackIds) => ipcRenderer.invoke('playlist:remove-tracks', { id, trackIds }),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    cacheStats: () => ipcRenderer.invoke('settings:cache-stats'),
    // kind: 'media' | 'art' | 'all'
    clearCache: (kind) => ipcRenderer.invoke('settings:clear-cache', kind),
    openDataFolder: () => ipcRenderer.invoke('settings:open-data-folder'),
    // Only fires while the theme is set to "system". The renderer cannot read
    // the OS preference itself under contextIsolation, so main pushes it.
    onSystemTheme: (handler) => {
      if (typeof handler !== 'function') return () => {};
      const listener = (_event, dark) => handler(Boolean(dark));
      ipcRenderer.on('settings:system-theme', listener);
      return () => ipcRenderer.removeListener('settings:system-theme', listener);
    },
  },
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  // The tray menu has to drive the audio element, which only exists here, and it
  // has to label itself with what is playing. Both directions are one channel
  // each rather than an invoke, because neither side needs a reply.
  player: {
    onCommand: (handler) => {
      if (typeof handler !== 'function') return () => {};
      const listener = (_event, command) => handler(String(command || ''));
      ipcRenderer.on('player:command', listener);
      return () => ipcRenderer.removeListener('player:command', listener);
    },
    publishState: (state) => ipcRenderer.send('player:state', state),
    resumeState: () => ipcRenderer.invoke('player:resume-state'),
    saveResumeState: (state) => ipcRenderer.send('player:save-resume-state', state),
    // Forgets the saved track, keeping the queue: used when a finished scan proves
    // the track is no longer in the library, so later launches stop chasing it.
    clearResumeState: () => ipcRenderer.send('player:clear-resume-state'),
    // Queue order changes without the track changing, so it gets its own
    // fire-and-forget channel rather than riding on saveResumeState.
    saveQueue: (ids) => ipcRenderer.send('player:save-queue', ids),
  },
  trayMenu: {
    command: (command) => ipcRenderer.send('tray:command', String(command || 'dismiss')),
    state: () => ipcRenderer.invoke('tray:state'),
    ready: () => ipcRenderer.send('tray:ready'),
    onState: (handler) => {
      if (typeof handler !== 'function') return () => {};
      const listener = (_event, state) => handler(state || {});
      ipcRenderer.on('tray:state', listener);
      return () => ipcRenderer.removeListener('tray:state', listener);
    },
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
  },
});
