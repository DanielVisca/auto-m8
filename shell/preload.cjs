const { contextBridge, ipcRenderer } = require('electron')

// macOS marks the page hidden when other windows cover perch completely; the shell tucks it into the edge.
document.addEventListener('visibilitychange', () => ipcRenderer.send('occluded', document.visibilityState === 'hidden'))

contextBridge.exposeInMainWorld('perch', {
  isElectron: true,
  popout: url => ipcRenderer.invoke('popout', url),
  pin: on => ipcRenderer.invoke('pin', on),
  isPinned: () => ipcRenderer.invoke('is-pinned'),
  pickFile: start => ipcRenderer.invoke('pick-file', start),
  badge: text => ipcRenderer.invoke('badge', text),
  preset: name => ipcRenderer.invoke('preset', name),
  buttons: on => ipcRenderer.invoke('buttons', on),
  mini: on => ipcRenderer.invoke('mini', on),
  miniSize: size => ipcRenderer.invoke('mini-size', size),
  onMiniSize: cb => { const f = (_e, s) => cb(s); ipcRenderer.on('mini-size', f); return () => ipcRenderer.removeListener('mini-size', f) },
  tuck: on => ipcRenderer.invoke('tuck', on),
  titlebarDoubleClick: () => ipcRenderer.invoke('titlebar-dblclick'),
  switchProfile: id => ipcRenderer.invoke('profile-switch', id),
  theme: t => ipcRenderer.invoke('theme', t),
  boardThumb: url => ipcRenderer.invoke('board-thumb', url),
  captureRect: rect => ipcRenderer.invoke('capture-rect', rect),
})
