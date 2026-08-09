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
    sync: () => ipcRenderer.invoke('telegram:sync'),
    streamUrl: (payload) => ipcRenderer.invoke('telegram:stream-url', payload),
    // Listing chats is one request; scanning them is one request each. Keeping
    // them separate is what lets the picker appear before any scanning happens.
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
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
  },
});
