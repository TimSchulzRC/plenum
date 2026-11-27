import { Tooltip } from '@fluentui/react-components'
import { ArrowDownload20Regular, Copy20Regular, Dismiss20Regular, ZoomIn20Regular, ZoomOut20Regular } from '@fluentui/react-icons'
import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { api } from '../api'

const useViewer = create<{ src: string | null }>(() => ({ src: null }))

export function openImage(src: string): void {
  if (src) useViewer.setState({ src })
}

function closeImage(): void {
  useViewer.setState({ src: null })
}

// Zoom relativ zur eingepassten Größe
const MAX_SCALE = 10
const STEP = 1.5

interface View {
  scale: number
  x: number
  y: number
}

const FIT: View = { scale: 1, x: 0, y: 0 }

// Großansicht eines Chatbilds über dem ganzen Fenster
export function ImageViewer(): JSX.Element | null {
  const src = useViewer((s) => s.src)
  const root = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const [view, setView] = useState<View>(FIT)
  const viewRef = useRef(view)
  viewRef.current = view
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null)
  const dragged = useRef(false)

  useEffect(() => setView(FIT), [src])

  // Neue Ansicht mit Zoom um den Punkt (px, py) im Fenster; ohne Punkt um die Fenstermitte.
  // Der Versatz bleibt so begrenzt, dass das Bild nicht aus dem Fenster wandert.
  const zoomTo = (scale: number, px?: number, py?: number) => {
    const el = img.current
    if (!el) return
    const v = viewRef.current
    const s = Math.min(MAX_SCALE, Math.max(1, scale))
    const w = el.offsetWidth
    const h = el.offsetHeight
    // Mitte des eingepassten Bilds; transform ändert offsetLeft/offsetTop nicht
    const cx = el.offsetLeft + w / 2
    const cy = el.offsetTop + h / 2
    const vw = window.innerWidth
    const vh = window.innerHeight
    const k = s / v.scale
    let x = (px ?? vw / 2) - cx - k * ((px ?? vw / 2) - cx - v.x)
    let y = (py ?? vh / 2) - cy - k * ((py ?? vh / 2) - cy - v.y)
    x = clamp(x, w * s, cx, vw)
    y = clamp(y, h * s, cy, vh)
    setView({ scale: s, x, y })
  }

  useEffect(() => {
    if (!src) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeImage()
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const s = viewRef.current.scale
      if (e.key === '+' || e.key === '=') zoomTo(s * STEP)
      else if (e.key === '-') zoomTo(s / STEP)
      else if (e.key === '0') setView(FIT)
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    // Mausrad und Trackpad-Geste zoomen um den Mauszeiger. Die Geste kommt mit ctrlKey und kleinen Schritten.
    // Nicht passiv, damit Strg+Rad nicht die ganze Seite zoomt.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const dy = Math.max(-100, Math.min(100, e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY))
      if (!dy) return
      const factor = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002))
      zoomTo(viewRef.current.scale * factor, e.clientX, e.clientY)
    }
    // Neue Fenstergröße ändert die eingepasste Größe: Versatz neu begrenzen
    const onResize = () => zoomTo(viewRef.current.scale)
    const el = root.current
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onResize)
    el?.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onResize)
      el?.removeEventListener('wheel', onWheel)
    }
  }, [src])

  if (!src) return null

  // Kopieren per Schaltfläche: Mitte des sichtbaren Bildausschnitts, falls der Hauptprozess es selbst lesen muss
  const center = (): [number, number] => {
    const r = img.current?.getBoundingClientRect()
    if (!r) return [0, 0]
    const left = Math.max(r.left, 0)
    const right = Math.min(r.right, window.innerWidth)
    const top = Math.max(r.top, 0)
    const bottom = Math.min(r.bottom, window.innerHeight)
    return [(left + right) / 2, (top + bottom) / 2]
  }

  // Pixelgröße statt Faktor anzeigen: 100 % heißt Originalgröße
  const el = img.current
  const percent = el?.naturalWidth ? Math.round(((view.scale * el.offsetWidth) / el.naturalWidth) * 100) : Math.round(view.scale * 100)
  const zoomed = view.scale > 1

  return (
    <div
      ref={root}
      className="image-viewer"
      role="dialog"
      aria-label="Bild"
      onClick={(e) => {
        // Ein Zug, der über dem Hintergrund endet, schließt nicht
        if (dragged.current) {
          dragged.current = false
          return
        }
        if (e.target === e.currentTarget) closeImage()
      }}
    >
      <div className="image-viewer-tools" onClick={(e) => e.stopPropagation()}>
        <Tooltip content="Verkleinern (−)" relationship="label">
          <button className="icon-btn" disabled={!zoomed} onClick={() => zoomTo(view.scale / STEP)}>
            <ZoomOut20Regular />
          </button>
        </Tooltip>
        <Tooltip content="Einpassen (0)" relationship="label">
          <button className="image-viewer-zoom" disabled={!zoomed} onClick={() => setView(FIT)}>
            {percent} %
          </button>
        </Tooltip>
        <Tooltip content="Vergrößern (+)" relationship="label">
          <button className="icon-btn" disabled={view.scale >= MAX_SCALE} onClick={() => zoomTo(view.scale * STEP)}>
            <ZoomIn20Regular />
          </button>
        </Tooltip>
        <span className="image-viewer-sep" />
        <Tooltip content="Herunterladen" relationship="label">
          <button className="icon-btn" onClick={() => void api.imageAction(src, 'save', 0, 0)}>
            <ArrowDownload20Regular />
          </button>
        </Tooltip>
        <Tooltip content="Kopieren" relationship="label">
          <button className="icon-btn" onClick={() => void api.imageAction(src, 'copy', ...center())}>
            <Copy20Regular />
          </button>
        </Tooltip>
        <Tooltip content="Schließen (Esc)" relationship="label">
          <button className="icon-btn" onClick={closeImage}>
            <Dismiss20Regular />
          </button>
        </Tooltip>
      </div>
      <img
        ref={img}
        src={src}
        alt=""
        draggable={false}
        className={[zoomed ? 'zoomed' : '', drag.current?.moved ? 'dragging' : ''].join(' ')}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        onLoad={() => setView({ ...FIT })}
        onDoubleClick={(e) => {
          if (zoomed) setView(FIT)
          else {
            // Auf Originalgröße, mindestens doppelt
            const el = e.currentTarget
            const real = el.naturalWidth && el.offsetWidth ? el.naturalWidth / el.offsetWidth : 1
            zoomTo(Math.max(2, real), e.clientX, e.clientY)
          }
        }}
        onPointerDown={(e) => {
          dragged.current = false
          if (e.button !== 0 || !zoomed) return
          drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d || d.id !== e.pointerId) return
          const dx = e.clientX - d.x
          const dy = e.clientY - d.y
          if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3) return
          d.moved = true
          d.x = e.clientX
          d.y = e.clientY
          const el = e.currentTarget
          const v = viewRef.current
          setView({
            scale: v.scale,
            x: clamp(v.x + dx, el.offsetWidth * v.scale, el.offsetLeft + el.offsetWidth / 2, window.innerWidth),
            y: clamp(v.y + dy, el.offsetHeight * v.scale, el.offsetTop + el.offsetHeight / 2, window.innerHeight)
          })
        }}
        onPointerUp={(e) => {
          const d = drag.current
          if (!d || d.id !== e.pointerId) return
          drag.current = null
          dragged.current = d.moved
          setView((v) => ({ ...v }))
        }}
        onPointerCancel={() => {
          drag.current = null
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          void api.imageAction(src, 'menu', e.clientX, e.clientY)
        }}
      />
    </div>
  )
}

// Versatz einer Achse: Ist das Bild kleiner als das Fenster, bleibt es an seinem Platz.
// Sonst darf es verschoben werden, bis seine Kante den Fensterrand erreicht.
function clamp(offset: number, size: number, center: number, viewport: number): number {
  if (size <= viewport) return 0
  const min = viewport - center - size / 2
  const max = size / 2 - center
  return Math.min(max, Math.max(min, offset))
}
