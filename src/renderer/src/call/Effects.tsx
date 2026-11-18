import { useEffect, useState, type JSX } from 'react'
import { Menu, MenuDivider, MenuGroup, MenuGroupHeader, MenuItemCheckbox, MenuItemRadio, MenuList, MenuPopover, MenuTrigger, MenuItem, Spinner } from '@fluentui/react-components'
import { Add20Regular, Checkmark16Filled, ChevronDown16Regular, Dismiss20Regular, Prohibited24Regular, BlurRegular, ImageEdit20Regular } from '@fluentui/react-icons'
import type { BackgroundList, CallDevices } from '@shared/types'
import { api } from '../api'

// Seitenleiste mit den Hintergrundeffekten aus Teams
export function EffectsPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const [list, setList] = useState<BackgroundList | null>(null)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string | null>(null)

  const load = async () => {
    try {
      const l = await api.getBackgrounds()
      setList(l)
      setError(l.error)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  useEffect(() => {
    void load()
    return () => void api.closeBackgrounds()
  }, [])

  const choose = async (id: string) => {
    setBusy(id)
    try {
      await api.setBackground(id)
      setList((l) => (l ? { ...l, items: l.items.map((i) => ({ ...i, selected: i.id === id })) } : l))
      setTimeout(() => void load(), 1200)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const upload = async () => {
    setBusy('upload')
    try {
      const l = await api.addBackground()
      if (l) setList(l)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <aside className="cw-panel cw-effects">
      <div className="cw-panel-head">
        <h2>Hintergrundeffekte</h2>
        <button className="cw-icon-btn" onClick={onClose} aria-label="Schließen">
          <Dismiss20Regular />
        </button>
      </div>
      <div className="cw-panel-body">
        {!list && !error && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 30 }}>
            <Spinner size="small" />
          </div>
        )}
        {error && <p className="cw-muted">{error}</p>}
        {list && (
          <>
            {list.canUpload && (
              <button className="cw-add-bg" onClick={() => void upload()} disabled={busy === 'upload'}>
                {busy === 'upload' ? <Spinner size="tiny" /> : <Add20Regular />}
                <span>Eigenes Bild hinzufügen</span>
              </button>
            )}
            <div className="cw-bg-grid">
              {list.items.map((b) => (
                <button key={b.id} className={`cw-bg${b.selected ? ' selected' : ''}`} title={b.label} onClick={() => void choose(b.id)} disabled={!!busy}>
                  {b.thumbnail ? (
                    <img src={b.thumbnail} alt="" draggable={false} />
                  ) : (
                    <span className="cw-bg-icon">{b.kind === 'none' ? <Prohibited24Regular /> : b.kind === 'blur' ? <BlurRegular fontSize={24} /> : <ImageEdit20Regular />}</span>
                  )}
                  <span className="cw-bg-label">{b.label}</span>
                  {b.selected && (
                    <span className="cw-bg-check">
                      <Checkmark16Filled />
                    </span>
                  )}
                  {busy === b.id && (
                    <span className="cw-bg-busy">
                      <Spinner size="tiny" />
                    </span>
                  )}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </aside>
  )
}

// Pfeil neben Kamera bzw. Mikrofon mit Geräteauswahl wie in Teams
export function DeviceChevron({ kind, onEffects, disabled }: { kind: 'video' | 'audio'; onEffects?: () => void; disabled?: boolean }): JSX.Element {
  const [devices, setDevices] = useState<CallDevices | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    setDevices(null)
    void api
      .getCallDevices()
      .then(setDevices)
      .catch(() => setDevices({ cameras: [], mics: [], speakers: [] }))
  }, [open])

  const select = (k: 'camera' | 'mic' | 'speaker' | 'noise', id: string) => {
    void api.setCallDevice(k, id).then(() => setOpen(false))
  }

  const checked: Record<string, string[]> = {}
  if (devices) {
    checked.camera = devices.cameras.filter((d) => d.selected).map((d) => d.id)
    checked.mic = devices.mics.filter((d) => d.selected).map((d) => d.id)
    checked.speaker = devices.speakers.filter((d) => d.selected).map((d) => d.id)
    checked.noise = devices.noiseSuppression ? ['on'] : []
  }

  return (
    <Menu open={open} onOpenChange={(_e, d) => setOpen(d.open)} checkedValues={checked} positioning="below-end">
      <MenuTrigger disableButtonEnhancement>
        <button className="cw-chevron" disabled={disabled} aria-label={kind === 'video' ? 'Videooptionen' : 'Audiooptionen'}>
          <ChevronDown16Regular />
        </button>
      </MenuTrigger>
      <MenuPopover style={{ minWidth: 300 }}>
        <MenuList>
          {!devices && (
            <div style={{ padding: 16, display: 'flex', justifyContent: 'center' }}>
              <Spinner size="tiny" />
            </div>
          )}
          {devices && kind === 'video' && (
            <>
              <MenuGroup>
                <MenuGroupHeader>Kamera</MenuGroupHeader>
                {devices.cameras.length === 0 && <MenuItem disabled>Keine Kamera gefunden</MenuItem>}
                {devices.cameras.map((c) => (
                  <MenuItemRadio key={c.id} name="camera" value={c.id} onClick={() => select('camera', c.id)}>
                    {c.label}
                  </MenuItemRadio>
                ))}
              </MenuGroup>
              {onEffects && (
                <>
                  <MenuDivider />
                  <MenuItem icon={<ImageEdit20Regular />} onClick={onEffects}>
                    Hintergrundeffekte …
                  </MenuItem>
                </>
              )}
            </>
          )}
          {devices && kind === 'audio' && (
            <>
              <MenuGroup>
                <MenuGroupHeader>Lautsprecher</MenuGroupHeader>
                {devices.speakers.map((c) => (
                  <MenuItemRadio key={c.id} name="speaker" value={c.id} onClick={() => select('speaker', c.id)}>
                    {c.label}
                  </MenuItemRadio>
                ))}
              </MenuGroup>
              <MenuDivider />
              <MenuGroup>
                <MenuGroupHeader>Mikrofon</MenuGroupHeader>
                {devices.mics.map((c) => (
                  <MenuItemRadio key={c.id} name="mic" value={c.id} onClick={() => select('mic', c.id)}>
                    {c.label}
                  </MenuItemRadio>
                ))}
              </MenuGroup>
              {devices.noiseSuppression !== undefined && (
                <>
                  <MenuDivider />
                  <MenuItemCheckbox name="noise" value="on" onClick={() => select('noise', 'toggle')}>
                    Rauschunterdrückung
                  </MenuItemCheckbox>
                </>
              )}
            </>
          )}
        </MenuList>
      </MenuPopover>
    </Menu>
  )
}
