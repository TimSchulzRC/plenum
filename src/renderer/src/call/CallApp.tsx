import { useCallback, useEffect, useMemo, useState, type ComponentProps, type JSX, type ReactNode } from 'react'
import { Avatar, Button, Menu, MenuDivider, MenuGroup, MenuGroupHeader, MenuItemRadio, MenuItem, MenuList, MenuPopover, MenuTrigger, Spinner, Tooltip } from '@fluentui/react-components'
import {
  ArrowMaximize20Regular,
  ArrowMinimize24Regular,
  CallEnd20Filled,
  CallEnd24Filled,
  Chat24Regular,
  Emoji24Regular,
  Grid24Regular,
  HandRight24Filled,
  HandRight24Regular,
  Mic20Regular,
  Mic24Regular,
  MicOff20Regular,
  MicOff24Regular,
  MicOff16Filled,
  MoreHorizontal24Regular,
  Open24Regular,
  People24Regular,
  PersonBoard24Regular,
  ShareScreenStart24Regular,
  ShareScreenStop24Regular,
  Video20Regular,
  Video24Regular,
  VideoOff20Regular,
  VideoOff24Regular,
  Dismiss20Regular,
  HandRight16Filled,
  ImageEdit20Regular,
  ScaleFill24Regular,
  ScaleFit24Regular
} from '@fluentui/react-icons'
import type { CallAction, CallState } from '@shared/types'
import { api, onEvent } from '../api'
import { duration } from '../lib/format'
import { useBridge, type BridgeStream } from './bridge'
import { StreamVideo, VideoTile, type VideoFit, type VideoTileProps } from './VideoTile'
import { PersonPopover } from './PersonCard'
import { DeviceChevron, EffectsPanel } from './Effects'
import { compactMain, OWN_SCREEN_LABEL, shownStreams, stageModel, type TileModel } from './layout'
import './call.css'


type DisplaySource = { id: string; name: string; thumbnail: string; kind: 'screen' | 'window' }

const REACTIONS: { emoji: string; label: string; match: string }[] = [
  { emoji: '👍', label: 'Gefällt mir', match: '(like|gefällt)' },
  { emoji: '❤️', label: 'Herz', match: '(heart|love|herz)' },
  { emoji: '👏', label: 'Applaus', match: '(applause|applaus|klatsch)' },
  { emoji: '😆', label: 'Lachen', match: '(laugh|lachen)' },
  { emoji: '😮', label: 'Überrascht', match: '(surprise|wow|überrasch)' }
]

function useCallState(): CallState | null {
  const [state, setState] = useState<CallState | null>(null)
  useEffect(() => {
    void api.getCallState().then((s) => setState(s))
    return onEvent('call-state', setState)
  }, [])
  return state
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [active])
  return now
}

// Ganzes Bild zeigen oder Kachel füllen. Gilt für alle Videos und wird gespeichert.
function useVideoFit(): [VideoFit, (fit: VideoFit) => void] {
  const [fit, setFit] = useState<VideoFit>('contain')
  useEffect(() => {
    void api.getSettings().then((s) => setFit(s.callVideoFit ?? 'contain'))
    return onEvent('settings', (s) => setFit(s.callVideoFit ?? 'contain'))
  }, [])
  const change = useCallback((next: VideoFit) => {
    setFit(next)
    void api.setSettings({ callVideoFit: next })
  }, [])
  return [fit, change]
}

// Wessen Profil ein Klick auf das Namensschild zeigt. Eigene Kacheln und unbekannte Streams haben keins.
function personFor(state: CallState, label: string, kind: TileModel['kind'], streamExternal?: boolean): VideoTileProps['person'] {
  if (kind === 'self') return undefined
  const name = label.replace(/ \(Bildschirm\)$/, '')
  if (!name || name === OWN_SCREEN_LABEL || /^Teilnehmer( \d+)?$/.test(name)) return undefined
  const p = state.participants.find((x) => x.name === name)
  if (p?.isMe) return undefined
  return { accountId: state.accountId, name, external: p?.external || streamExternal }
}

function act(action: CallAction, arg?: string): void {
  void api.callAction(action, arg)
}

type BarButtonProps = ComponentProps<'button'> & { icon: ReactNode; label: string; active?: boolean; badge?: number }

function BarButton({ icon, label, active, badge, className, ...rest }: BarButtonProps): JSX.Element {
  return (
    <button {...rest} className={`cw-bar-btn${active ? ' active' : ''} ${className ?? ''}`} aria-label={label}>
      <span className="cw-bar-icon">
        {icon}
        {badge ? <span className="cw-badge">{badge}</span> : null}
      </span>
      <span className="cw-bar-label">{label}</span>
    </button>
  )
}

function ScreenPicker({ sources, onDone }: { sources: DisplaySource[]; onDone: (id: string | null) => void }): JSX.Element {
  const sorted = useMemo(() => [...sources].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'screen' ? -1 : 1)), [sources])
  const [selected, setSelected] = useState<string | null>(sorted[0]?.id ?? null)
  const screens = sorted.filter((s) => s.kind === 'screen')
  const windows = sorted.filter((s) => s.kind === 'window')
  const grid = (list: DisplaySource[]) => (
    <div className="cw-picker-grid">
      {list.map((s) => (
        <button
          key={s.id}
          className={`cw-picker-item${selected === s.id ? ' selected' : ''}`}
          onClick={() => setSelected(s.id)}
          onDoubleClick={() => onDone(s.id)}
        >
          <img src={s.thumbnail} alt="" />
          <span>{s.name}</span>
        </button>
      ))}
    </div>
  )
  return (
    <div className="cw-modal-backdrop">
      <div className="cw-modal">
        <div className="cw-modal-head">
          <h2>Inhalt freigeben</h2>
          <button className="cw-icon-btn" onClick={() => onDone(null)} aria-label="Schließen">
            <Dismiss20Regular />
          </button>
        </div>
        <div className="cw-modal-body">
          {screens.length > 0 && (
            <>
              <h3>Bildschirme</h3>
              {grid(screens)}
            </>
          )}
          {windows.length > 0 && (
            <>
              <h3>Fenster</h3>
              {grid(windows)}
            </>
          )}
          {sources.length === 0 && <p className="cw-muted">Keine Quellen gefunden. Prüfe die Berechtigung für Bildschirmaufnahme in den Systemeinstellungen.</p>}
        </div>
        <div className="cw-modal-foot">
          <Button appearance="secondary" onClick={() => onDone(null)}>
            Abbrechen
          </Button>
          <Button appearance="primary" disabled={!selected} onClick={() => onDone(selected)}>
            Teilen
          </Button>
        </div>
      </div>
    </div>
  )
}

function Centered({ children }: { children: ReactNode }): JSX.Element {
  return <div className="cw-center">{children}</div>
}

function Prejoin({ state, self, onEffects }: { state: CallState; self?: BridgeStream; onEffects: () => void }): JSX.Element {
  return (
    <Centered>
      <div className="cw-prejoin">
        <h1>{state.title || 'Besprechung'}</h1>
        <p className="cw-muted">Wähle deine Audio- und Videoeinstellungen.</p>
        <div className="cw-prejoin-preview">
          {self?.media && state.cameraOn ? (
            <StreamVideo media={self.media} fit="cover" mirror />
          ) : (
            <div className="cw-prejoin-off">
              <VideoOff24Regular />
              <span>Deine Kamera ist ausgeschaltet</span>
            </div>
          )}
        </div>
        <div className="cw-prejoin-toggles">
          <button className={`cw-toggle${state.cameraOn ? ' on' : ''}`} onClick={() => act('toggleCamera')} disabled={state.available.toggleCamera === false}>
            {state.cameraOn ? <Video20Regular /> : <VideoOff20Regular />}
            <span>{state.cameraOn ? 'Kamera an' : 'Kamera aus'}</span>
          </button>
          <button className={`cw-toggle${!state.muted ? ' on' : ''}`} onClick={() => act('toggleMute')}>
            {state.muted ? <MicOff20Regular /> : <Mic20Regular />}
            <span>{state.muted ? 'Mikrofon aus' : 'Mikrofon an'}</span>
          </button>
          <button className="cw-toggle" onClick={onEffects} disabled={!state.cameraOn} title={state.cameraOn ? undefined : 'Schalte zuerst die Kamera ein'}>
            <ImageEdit20Regular />
            <span>Hintergrund</span>
          </button>
        </div>
        <div className="cw-prejoin-actions">
          <Button appearance="secondary" onClick={() => act('cancelJoin')}>
            Abbrechen
          </Button>
          <Button appearance="primary" size="large" disabled={state.available.join === false} onClick={() => act('join')}>
            Jetzt teilnehmen
          </Button>
        </div>
      </div>
    </Centered>
  )
}

function gridColumns(n: number, width: number, height: number): number {
  if (n <= 1) return 1
  let best = 1
  let bestArea = 0
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols)
    const w = width / cols
    const h = height / rows
    const tileW = Math.min(w, (h * 16) / 9)
    const area = tileW * ((tileW * 9) / 16)
    if (area > bestArea) {
      bestArea = area
      best = cols
    }
  }
  return best
}

function useElementSize(): [(el: HTMLDivElement | null) => void, { width: number; height: number }] {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 1, height: 1 })
  useEffect(() => {
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ width: e.contentRect.width, height: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return [setEl, size]
}

function Stage({
  state,
  streams,
  view,
  pinned,
  setPinned,
  fit
}: {
  state: CallState
  streams: BridgeStream[]
  view: 'gallery' | 'speaker'
  pinned: string | null
  setPinned: (id: string | null) => void
  fit: VideoFit
}): JSX.Element {
  const [stageRef, size] = useElementSize()
  const { self, tiles, main, strip } = stageModel(state, streams, view, pinned)

  const tileView = (t: TileModel, small = false) => (
    <VideoTile
      key={t.key}
      media={t.stream?.media ?? null}
      label={t.label}
      kind={t.kind}
      streamId={t.stream?.streamId}
      small={small}
      fit={fit}
      person={personFor(state, t.label, t.kind, t.stream?.external)}
      muted={t.participant?.muted}
      speaking={t.stream?.speaking || t.participant?.speaking}
      handRaised={t.participant?.handRaised}
      pinned={!!t.stream && pinned === t.stream.streamId}
      onPin={t.stream ? () => setPinned(pinned === t.stream!.streamId ? null : t.stream!.streamId) : undefined}
    />
  )

  const selfTile = (
    <div className="cw-self">
      <VideoTile media={state.cameraOn ? self?.media ?? null : null} label="Du" kind="self" streamId={self?.streamId} small fit={fit} muted={state.muted} hideActions={!self} />
    </div>
  )

  if (main) {
    return (
      <div className="cw-stage cw-stage-focus">
        <div className="cw-focus-main">
          <VideoTile
            media={main.media}
            label={main.label}
            kind={main.kind}
            streamId={main.streamId}
            fit={fit}
            person={personFor(state, main.label, main.kind, main.external)}
            pinned={pinned === main.streamId}
            onPin={() => setPinned(pinned === main.streamId ? null : main.streamId)}
          />
        </div>
        {strip.length > 0 && <div className="cw-filmstrip">{strip.map((t) => tileView(t, true))}</div>}
        {selfTile}
      </div>
    )
  }

  if (tiles.length === 0) {
    return (
      <div className="cw-stage" ref={stageRef}>
        <Centered>
          <div className="cw-alone">
            <Avatar name={state.title || 'Besprechung'} size={96} color="colorful" />
            <h2>{state.title || 'Besprechung'}</h2>
            <p className="cw-muted">Warten auf andere Teilnehmer …</p>
          </div>
        </Centered>
        {selfTile}
      </div>
    )
  }

  const cols = gridColumns(tiles.length, size.width, size.height)
  return (
    <div className="cw-stage" ref={stageRef}>
      <div className="cw-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${Math.ceil(tiles.length / cols)}, minmax(0, 1fr))` }}>
        {tiles.map((t) => tileView(t))}
      </div>
      {selfTile}
    </div>
  )
}

function PeoplePanel({ state, onClose }: { state: CallState; onClose: () => void }): JSX.Element {
  const list = [...state.participants].sort((a, b) => Number(!!b.handRaised) - Number(!!a.handRaised) || a.name.localeCompare(b.name, 'de'))
  return (
    <aside className="cw-panel">
      <div className="cw-panel-head">
        <h2>Personen ({list.length})</h2>
        <button className="cw-icon-btn" onClick={onClose} aria-label="Schließen">
          <Dismiss20Regular />
        </button>
      </div>
      <div className="cw-panel-body">
        {list.length === 0 && <p className="cw-muted">Die Teilnehmerliste ist noch nicht verfügbar.</p>}
        {list.map((p) => {
          const row = (
            <>
              <Avatar name={p.name} size={32} color="colorful" />
              <span className="cw-person-name">
                {p.name}
                {p.isMe ? ' (du)' : ''}
              </span>
              {p.external && <span className="cw-person-tag">Extern</span>}
              {p.handRaised && <HandRight16Filled className="cw-hand" />}
              {p.muted && <MicOff16Filled className="cw-muted" />}
            </>
          )
          // Die Personensuche findet das eigene Konto nicht, daher keine Karte für sich selbst
          if (p.isMe) return <div key={p.id} className="cw-person">{row}</div>
          return (
            <PersonPopover key={p.id} accountId={state.accountId} name={p.name} external={p.external} positioning="before-top">
              <button className="cw-person" title="Profil anzeigen">
                {row}
              </button>
            </PersonPopover>
          )
        })}
      </div>
    </aside>
  )
}

function CompactView({ state, streams, fit }: { state: CallState | null; streams: BridgeStream[]; fit: VideoFit }): JSX.Element {
  const main = compactMain(streams)
  const now = useNow(!!state?.startedAt)
  return (
    <div className="cw-compact">
      {main ? (
        <VideoTile media={main.media} label={main.label} kind={main.kind} fit={fit} hideActions />
      ) : (
        <div className="cw-compact-empty">
          <Avatar name={state?.title || 'Besprechung'} size={56} color="colorful" />
        </div>
      )}
      <div className="cw-compact-top">
        <span className="cw-compact-title">{state?.title || 'Besprechung'}</span>
        {state?.startedAt ? <span className="cw-timer">{duration(Math.max(0, (now - state.startedAt) / 1000))}</span> : null}
      </div>
      <div className="cw-compact-controls">
        <button className={`cw-round${state?.muted ? ' off' : ''}`} onClick={() => act('toggleMute')} aria-label="Mikrofon">
          {state?.muted ? <MicOff20Regular /> : <Mic20Regular />}
        </button>
        <button className={`cw-round${state?.cameraOn ? '' : ' off'}`} onClick={() => act('toggleCamera')} aria-label="Kamera">
          {state?.cameraOn ? <Video20Regular /> : <VideoOff20Regular />}
        </button>
        <button className="cw-round danger" onClick={() => act('hangup')} aria-label="Verlassen">
          <CallEnd20Filled />
        </button>
        <button className="cw-round" onClick={() => void api.setCallCompact(false)} aria-label="Vergrößern">
          <ArrowMaximize20Regular />
        </button>
      </div>
    </div>
  )
}

export default function CallApp(): JSX.Element {
  const state = useCallState()
  const { streams, setActive } = useBridge('all')
  const [compact, setCompact] = useState(false)
  const [view, setView] = useState<'gallery' | 'speaker'>('gallery')
  const [pinned, setPinned] = useState<string | null>(null)
  const [showPeople, setShowPeople] = useState(false)
  const [showEffects, setShowEffects] = useState(false)
  const [sources, setSources] = useState<DisplaySource[] | null>(null)
  const [fit, setFit] = useVideoFit()
  const now = useNow(!!state?.startedAt)

  const shown = shownStreams(state, streams, view, pinned, compact)
  const shownKey = shown.slice().sort().join('|')
  useEffect(() => {
    setActive(shownKey ? shownKey.split('|') : [])
  }, [shownKey, setActive])

  useEffect(() => {
    const offCompact = (window.teams.on as unknown as (e: string, cb: (p: unknown) => void) => () => void)('call-compact', (p) => setCompact(!!p))
    const offSources = onEvent('display-sources', (list) => setSources(list))
    return () => {
      offCompact()
      offSources()
    }
  }, [])

  useEffect(() => {
    document.title = state?.title ? `${state.title} | Besprechung` : 'Besprechung'
  }, [state?.title])

  // Angeheftete Streams, die verschwinden, wieder lösen
  useEffect(() => {
    if (pinned && !streams.some((s) => s.streamId === pinned)) setPinned(null)
  }, [pinned, streams])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || !e.shiftKey) return
      const k = e.key.toLowerCase()
      if (k === 'm') act('toggleMute')
      else if (k === 'o') act('toggleCamera')
      else if (k === 'h') act('hangup')
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const pickSource = useCallback((id: string | null) => {
    setSources(null)
    void api.pickDisplaySource(id)
  }, [])

  if (compact) return <CompactView state={state} streams={streams} fit={fit} />

  const can = (a: CallAction): boolean => !!state && state.available?.[a] !== false
  const inCall = state?.phase === 'in-call'
  const ownShare = state?.sharing

  let body: JSX.Element
  if (!state || state.phase === 'connecting' || state.phase === 'idle') {
    body = (
      <Centered>
        <Spinner size="large" label="Verbindung wird hergestellt …" labelPosition="below" />
      </Centered>
    )
  } else if (state.phase === 'prejoin') {
    body = (
      <Prejoin
        state={state}
        self={streams.find((s) => s.kind === 'self')}
        onEffects={() => {
          setShowPeople(false)
          setShowEffects(true)
        }}
      />
    )
  } else if (state.phase === 'lobby') {
    body = (
      <Centered>
        <div className="cw-alone">
          <Spinner size="large" />
          <h2>Du wartest im Wartebereich …</h2>
          <p className="cw-muted">Jemand in der Besprechung lässt dich gleich herein.</p>
        </div>
      </Centered>
    )
  } else if (state.phase === 'ended') {
    body = (
      <Centered>
        <div className="cw-alone">
          <h2>Anruf beendet</h2>
        </div>
      </Centered>
    )
  } else {
    body = <Stage state={state} streams={streams} view={view} pinned={pinned} setPinned={setPinned} fit={fit} />
  }

  return (
    <div className="cw-root">
      <header className="cw-bar">
        <div className="cw-bar-title">
          <span className="cw-title-text">{state?.title || 'Besprechung'}</span>
          {state?.startedAt ? <span className="cw-timer">{duration(Math.max(0, (now - state.startedAt) / 1000))}</span> : null}
        </div>
        <div className="cw-bar-group">
          <BarButton icon={<Chat24Regular />} label="Chat" disabled={!state || (!state.conversationId && !can('toggleChat'))} onClick={() => void api.openCallChat()} />
          <BarButton
            icon={<People24Regular />}
            label="Personen"
            active={showPeople}
            badge={state?.participants.length || undefined}
            disabled={!state}
            onClick={() => {
              setShowEffects(false)
              setShowPeople((v) => !v)
            }}
          />
          <BarButton
            icon={state?.handRaised ? <HandRight24Filled /> : <HandRight24Regular />}
            label={state?.handRaised ? 'Hand senken' : 'Hand heben'}
            active={state?.handRaised}
            disabled={!inCall || !can('raiseHand')}
            onClick={() => act('raiseHand')}
          />
          <Menu positioning="below-end">
            <MenuTrigger disableButtonEnhancement>
              <BarButton icon={<Emoji24Regular />} label="Reagieren" disabled={!inCall || !can('react')} />
            </MenuTrigger>
            <MenuPopover>
              <div className="cw-reactions">
                {REACTIONS.map((r) => (
                  <Tooltip key={r.emoji} content={r.label} relationship="label">
                    <button className="cw-reaction" onClick={() => act('react', r.match)}>
                      {r.emoji}
                    </button>
                  </Tooltip>
                ))}
              </div>
            </MenuPopover>
          </Menu>
          <Menu
            positioning="below-end"
            checkedValues={{ view: [view], fit: [fit] }}
            onCheckedValueChange={(_e, d) => {
              const v = d.checkedItems[0]
              if (d.name === 'view' && (v === 'gallery' || v === 'speaker')) setView(v)
              if (d.name === 'fit' && (v === 'contain' || v === 'cover')) setFit(v)
            }}
          >
            <MenuTrigger disableButtonEnhancement>
              <BarButton icon={view === 'gallery' ? <Grid24Regular /> : <PersonBoard24Regular />} label="Ansicht" disabled={!inCall} />
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuGroup>
                  <MenuGroupHeader>Anordnung</MenuGroupHeader>
                  <MenuItemRadio name="view" value="gallery" icon={<Grid24Regular />}>
                    Galerie
                  </MenuItemRadio>
                  <MenuItemRadio name="view" value="speaker" icon={<PersonBoard24Regular />}>
                    Sprecher
                  </MenuItemRadio>
                </MenuGroup>
                <MenuDivider />
                <MenuGroup>
                  <MenuGroupHeader>Videobild</MenuGroupHeader>
                  <MenuItemRadio name="fit" value="contain" icon={<ScaleFit24Regular />}>
                    Ganzes Bild zeigen
                  </MenuItemRadio>
                  <MenuItemRadio name="fit" value="cover" icon={<ScaleFill24Regular />}>
                    Kachel füllen
                  </MenuItemRadio>
                </MenuGroup>
              </MenuList>
            </MenuPopover>
          </Menu>
          <Menu positioning="below-end">
            <MenuTrigger disableButtonEnhancement>
              <BarButton icon={<MoreHorizontal24Regular />} label="Mehr" />
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem icon={<ArrowMinimize24Regular />} onClick={() => void api.setCallCompact(true)}>
                  Kompaktansicht
                </MenuItem>
                <MenuItem icon={<Open24Regular />} onClick={() => void api.showCallInTeams()}>
                  In Teams-Webansicht öffnen
                </MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        </div>
        <div className="cw-bar-sep" />
        <div className="cw-bar-group">
          <BarButton
            icon={state?.cameraOn ? <Video24Regular /> : <VideoOff24Regular />}
            label="Kamera"
            className={state?.cameraOn ? '' : 'off'}
            disabled={!state || !can('toggleCamera')}
            onClick={() => act('toggleCamera')}
          />
          <DeviceChevron
            kind="video"
            disabled={!state || state.phase === 'connecting'}
            onEffects={() => {
              setShowPeople(false)
              setShowEffects(true)
            }}
          />
          <BarButton
            icon={state?.muted ? <MicOff24Regular /> : <Mic24Regular />}
            label="Mikrofon"
            className={state?.muted ? 'off' : ''}
            disabled={!state}
            onClick={() => act('toggleMute')}
          />
          <DeviceChevron kind="audio" disabled={!state || state.phase === 'connecting'} />
          <BarButton
            icon={ownShare ? <ShareScreenStop24Regular /> : <ShareScreenStart24Regular />}
            label={ownShare ? 'Beenden' : 'Teilen'}
            active={ownShare}
            disabled={!inCall || (ownShare ? !can('stopShare') : !can('share'))}
            onClick={() => act(ownShare ? 'stopShare' : 'share')}
          />
        </div>
        <button className="cw-leave" onClick={() => act('hangup')} disabled={!state || state.phase === 'prejoin'}>
          <CallEnd24Filled />
          <span>Verlassen</span>
        </button>
      </header>
      {ownShare && inCall && (
        <div className="cw-share-banner">
          <ShareScreenStart24Regular />
          <span>Du gibst deinen Bildschirm frei.</span>
          <Button size="small" appearance="primary" onClick={() => act('stopShare')}>
            Freigabe beenden
          </Button>
        </div>
      )}
      <main className="cw-main">
        {body}
        {showPeople && state && <PeoplePanel state={state} onClose={() => setShowPeople(false)} />}
        {showEffects && state && <EffectsPanel onClose={() => setShowEffects(false)} />}
      </main>
      {sources && <ScreenPicker sources={sources} onDone={pickSource} />}
    </div>
  )
}
