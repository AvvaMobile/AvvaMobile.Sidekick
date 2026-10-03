import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload for the local relay-button overlay only (the two round buttons on the divider).
 * It can report a click and receive button state; nothing else.
 */
contextBridge.exposeInMainWorld('relay', {
  click: (button: string) => ipcRenderer.send('relay:click', button === 'chatgpt' ? 'chatgpt' : 'claude'),
  onState: (cb: (s: unknown) => void) => {
    ipcRenderer.on('relay:state', (_e, s: unknown) => cb(s));
  },
});
