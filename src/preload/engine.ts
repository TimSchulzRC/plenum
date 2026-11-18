// Preload der versteckten Teams-Web-App (isolierte Welt).
// Injiziert die Hooks in die Main World und leitet Nachrichten zum Hauptprozess weiter.
import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { engineMainWorld } from './engine-main'

try {
  contextBridge.executeInMainWorld({ func: engineMainWorld, args: [] })
} catch {
  void webFrame.executeJavaScript(`(${engineMainWorld.toString()})()`)
}

document.addEventListener('__tm_to_iso', (e: Event) => {
  const detail = (e as CustomEvent).detail
  if (typeof detail !== 'string') return
  try {
    ipcRenderer.send('engine:msg', JSON.parse(detail))
  } catch {
    /* ignore */
  }
})

ipcRenderer.on('engine:cmd', (_e, msg: unknown) => {
  document.dispatchEvent(new CustomEvent('__tm_to_main', { detail: JSON.stringify(msg) }))
})
