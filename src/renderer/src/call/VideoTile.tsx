import { useEffect, useRef, useState, type JSX } from 'react'
import { Avatar, Tooltip } from '@fluentui/react-components'
import { MicOff16Filled, HandRight16Filled, Pin20Regular, PinOff20Regular, WindowNew20Regular } from '@fluentui/react-icons'
import { api } from '../api'

export interface VideoTileProps {
  media: MediaStream | null
  label: string
  kind: 'camera' | 'screen' | 'self'
  streamId?: string
  pinned?: boolean
  onPin?: () => void
  small?: boolean
  muted?: boolean
  speaking?: boolean
  handRaised?: boolean
  hideActions?: boolean
  className?: string
}

// Zeigt an, ob ein Stream tatsächlich Bilder liefert.
function useHasFrames(media: MediaStream | null, video: HTMLVideoElement | null): boolean {
  const [hasFrames, setHasFrames] = useState(false)
  useEffect(() => {
    setHasFrames(false)
    if (!media || !video) return
    const track = media.getVideoTracks()[0]
    const update = () => setHasFrames(!!track && track.readyState === 'live' && !track.muted && video.videoWidth > 0)
    video.addEventListener('playing', update)
    video.addEventListener('resize', update)
    video.addEventListener('loadeddata', update)
    track?.addEventListener('mute', update)
    track?.addEventListener('unmute', update)
    track?.addEventListener('ended', update)
    const iv = setInterval(update, 1000)
    update()
    return () => {
      video.removeEventListener('playing', update)
      video.removeEventListener('resize', update)
      video.removeEventListener('loadeddata', update)
      track?.removeEventListener('mute', update)
      track?.removeEventListener('unmute', update)
      track?.removeEventListener('ended', update)
      clearInterval(iv)
    }
  }, [media, video])
  return hasFrames
}

export function StreamVideo({
  media,
  fit,
  mirror,
  onVideo
}: {
  media: MediaStream | null
  fit: 'cover' | 'contain'
  mirror?: boolean
  onVideo?: (v: HTMLVideoElement | null) => void
}): JSX.Element {
  const ref = useRef<HTMLVideoElement | null>(null)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    if (v.srcObject !== media) v.srcObject = media
    if (media) v.play().catch(() => undefined)
  }, [media])
  return (
    <video
      ref={(el) => {
        ref.current = el
        onVideo?.(el)
      }}
      className="cw-video"
      style={{ objectFit: fit, transform: mirror ? 'scaleX(-1)' : undefined }}
      autoPlay
      playsInline
      muted
    />
  )
}

export function VideoTile(props: VideoTileProps): JSX.Element {
  const { media, label, kind, streamId, pinned, onPin, small, muted, speaking, handRaised, hideActions, className } = props
  const [video, setVideo] = useState<HTMLVideoElement | null>(null)
  const hasFrames = useHasFrames(media, video)
  const showVideo = !!media && hasFrames
  const fit = kind === 'screen' ? 'contain' : 'cover'
  const avatarSize = small ? 40 : 96

  return (
    <div className={`cw-tile${small ? ' small' : ''}${speaking ? ' speaking' : ''}${kind === 'screen' ? ' screen' : ''} ${className ?? ''}`}>
      {media && <StreamVideo media={media} fit={fit} mirror={kind === 'self'} onVideo={setVideo} />}
      {!showVideo && (
        <div className="cw-tile-fallback">
          <Avatar name={label} size={avatarSize} color="colorful" idForColor={label} />
        </div>
      )}
      <div className="cw-tile-label">
        {handRaised && <HandRight16Filled className="cw-hand" />}
        {muted && <MicOff16Filled />}
        <span>{label}</span>
      </div>
      {!hideActions && (
        <div className="cw-tile-actions">
          {streamId && media && (
            <Tooltip content="In eigenem Fenster öffnen" relationship="label" withArrow>
              <button className="cw-tile-btn" onClick={() => void api.popoutStream(streamId, label)}>
                <WindowNew20Regular />
              </button>
            </Tooltip>
          )}
          {onPin && (
            <Tooltip content={pinned ? 'Lösen' : 'Für mich anheften'} relationship="label" withArrow>
              <button className="cw-tile-btn" onClick={onPin}>
                {pinned ? <PinOff20Regular /> : <Pin20Regular />}
              </button>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  )
}
