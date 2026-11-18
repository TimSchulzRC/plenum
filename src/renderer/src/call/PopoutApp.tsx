import { useEffect, useRef, useState, type JSX } from 'react'
import { Tooltip } from '@fluentui/react-components'
import { Pin20Filled, Pin20Regular, VideoOff24Regular } from '@fluentui/react-icons'
import { api, routeInfo } from '../api'
import { useBridge } from './bridge'
import { StreamVideo } from './VideoTile'
import './call.css'

// Einzelnes Video (Teilnehmer oder Bildschirmfreigabe) in einem eigenen Fenster.
export default function PopoutApp(): JSX.Element {
  const { params } = routeInfo()
  const streamId = params.get('stream') ?? ''
  const initialLabel = params.get('label') ?? 'Video'
  const { streams } = useBridge([streamId])
  const stream = streams.find((s) => s.streamId === streamId)
  const label = stream?.label || initialLabel
  const [pinned, setPinned] = useState(false)
  const [everSeen, setEverSeen] = useState(false)
  const [gone, setGone] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    document.title = label
  }, [label])

  useEffect(() => {
    if (stream) {
      setEverSeen(true)
      setGone(false)
      return
    }
    // Kurze Gnadenfrist: beim Start oder nach Neuaushandlung fehlt der Stream kurz.
    const t = setTimeout(() => setGone(true), everSeen ? 2500 : 6000)
    return () => clearTimeout(t)
  }, [stream, everSeen])

  const togglePin = () => {
    const next = !pinned
    setPinned(next)
    void api.setAlwaysOnTop(next)
  }

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void rootRef.current?.requestFullscreen()
  }

  return (
    <div className="cw-popout" ref={rootRef} onDoubleClick={toggleFullscreen}>
      {stream?.media ? (
        <StreamVideo media={stream.media} fit="contain" mirror={stream.kind === 'self'} />
      ) : (
        <div className="cw-popout-empty">
          {gone ? (
            <>
              <VideoOff24Regular />
              <span>Video nicht mehr verfügbar</span>
            </>
          ) : (
            <span className="cw-muted">Video wird geladen …</span>
          )}
        </div>
      )}
      <div className="cw-popout-bar">
        <span className="cw-popout-label">{label}</span>
        <Tooltip content={pinned ? 'Nicht mehr im Vordergrund halten' : 'Immer im Vordergrund'} relationship="label" withArrow>
          <button className={`cw-icon-btn${pinned ? ' active' : ''}`} onClick={togglePin} onDoubleClick={(e) => e.stopPropagation()}>
            {pinned ? <Pin20Filled /> : <Pin20Regular />}
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
