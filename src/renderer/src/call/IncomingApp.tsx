import { useEffect, useRef, useState, type JSX } from 'react'
import { Avatar, Tooltip } from '@fluentui/react-components'
import { Call24Filled, CallEnd24Filled, Video24Filled } from '@fluentui/react-icons'
import type { IncomingCall } from '@shared/types'
import { api, onEvent } from '../api'
import { avatarUrl } from '../lib/media'
import './call.css'

// Kleines Fenster oben rechts für eingehende Anrufe.
export default function IncomingApp(): JSX.Element {
  const [call, setCall] = useState<IncomingCall | null>(null)
  const seen = useRef(false)

  useEffect(() => {
    const off = onEvent('incoming-call', (c) => {
      setCall(c)
      if (c) seen.current = true
      else if (seen.current) void api.closeWindow()
    })
    // Das Fenster lädt erst nach der Meldung: aktuellen Anruf einmal abfragen
    void api.getIncomingCall().then((c) => {
      if (c) {
        seen.current = true
        setCall(c)
      } else void api.closeWindow()
    })
    return off
  }, [])

  const answer = (mode: 'video' | 'audio' | 'decline') => {
    if (!call) return
    void api.answerIncoming(call, mode)
    void api.closeWindow()
  }

  if (!call) {
    return (
      <div className="cw-incoming">
        <div className="cw-incoming-card placeholder">
          <span className="cw-muted">Eingehender Anruf …</span>
        </div>
      </div>
    )
  }

  const src = call.callerMri ? avatarUrl(call.accountId, call.callerMri, call.callerName) : undefined
  return (
    <div className="cw-incoming">
      <div className="cw-incoming-card">
        <div className="cw-incoming-info">
          <div className="cw-ring">
            <Avatar name={call.callerName} image={src ? { src } : undefined} size={56} color="colorful" />
          </div>
          <div className="cw-incoming-text">
            <div className="cw-incoming-name">{call.callerName}</div>
            <div className="cw-incoming-sub">{call.isVideo ? 'Eingehender Videoanruf' : 'Eingehender Anruf'}</div>
            {call.detail && call.detail !== call.callerName && <div className="cw-incoming-detail">{call.detail}</div>}
          </div>
        </div>
        <div className="cw-incoming-actions">
          <Tooltip content="Mit Video annehmen" relationship="label" withArrow>
            <button className="cw-answer accept" onClick={() => answer('video')}>
              <Video24Filled />
            </button>
          </Tooltip>
          <Tooltip content="Mit Audio annehmen" relationship="label" withArrow>
            <button className="cw-answer accept" onClick={() => answer('audio')}>
              <Call24Filled />
            </button>
          </Tooltip>
          <Tooltip content="Ablehnen" relationship="label" withArrow>
            <button className="cw-answer decline" onClick={() => answer('decline')}>
              <CallEnd24Filled />
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}
