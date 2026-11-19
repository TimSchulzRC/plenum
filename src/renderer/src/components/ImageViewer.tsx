import { Tooltip } from '@fluentui/react-components'
import { ArrowDownload20Regular, Copy20Regular, Dismiss20Regular } from '@fluentui/react-icons'
import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { api } from '../api'

const useViewer = create<{ src: string | null }>(() => ({ src: null }))

export function openImage(src: string): void {
  if (src) useViewer.setState({ src })
}

function closeImage(): void {
  useViewer.setState({ src: null })
}

// Großansicht eines Chatbilds über dem ganzen Fenster
export function ImageViewer(): JSX.Element | null {
  const src = useViewer((s) => s.src)
  const img = useRef<HTMLImageElement>(null)

  useEffect(() => {
    if (!src) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeImage()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [src])

  if (!src) return null
  // Kopieren per Schaltfläche: Mitte des Bilds, falls der Hauptprozess es selbst lesen muss
  const center = () => {
    const r = img.current?.getBoundingClientRect()
    return r ? [r.left + r.width / 2, r.top + r.height / 2] : [0, 0]
  }
  return (
    <div className="image-viewer" role="dialog" aria-label="Bild" onClick={(e) => e.target === e.currentTarget && closeImage()}>
      <div className="image-viewer-tools">
        <Tooltip content="Herunterladen" relationship="label">
          <button className="icon-btn" onClick={() => void api.imageAction(src, 'save', 0, 0)}>
            <ArrowDownload20Regular />
          </button>
        </Tooltip>
        <Tooltip content="Kopieren" relationship="label">
          <button className="icon-btn" onClick={() => void api.imageAction(src, 'copy', ...(center() as [number, number]))}>
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
        onContextMenu={(e) => {
          e.preventDefault()
          void api.imageAction(src, 'menu', e.clientX, e.clientY)
        }}
      />
    </div>
  )
}
