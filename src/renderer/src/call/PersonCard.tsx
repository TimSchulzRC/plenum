import { useEffect, useState, type JSX, type ReactElement } from 'react'
import { Avatar, Button, Popover, PopoverSurface, PopoverTrigger, Spinner, Tooltip, type PositioningShorthand } from '@fluentui/react-components'
import { Chat20Regular, Checkmark20Regular, Copy20Regular, Mail20Regular } from '@fluentui/react-icons'
import type { Person } from '@shared/types'
import { matchPerson, nameQueries } from '@shared/call-names'
import { api } from '../api'
import { avatarUrl } from '../lib/media'

type Lookup = { state: 'loading' } | { state: 'found'; person: Person } | { state: 'none' }

// Profil zum Namen im Anruf im Verzeichnis suchen
function usePersonLookup(accountId: string, name: string, external?: boolean): Lookup {
  // Ergebnis gilt nur für genau diese Anfrage. Ändern sich die Angaben, zählt es nicht mehr.
  const key = `${accountId}|${name}|${!!external}`
  const [result, setResult] = useState<{ key: string; lookup: Lookup } | null>(null)
  useEffect(() => {
    let alive = true
    void (async () => {
      // Erst alle Schreibweisen sammeln, damit gleichnamige Personen auffallen
      const found = await Promise.all(nameQueries(name).map((q) => api.searchPeople(accountId, q).catch(() => [])))
      const person = matchPerson(name, found.flat(), external)
      if (alive) setResult({ key, lookup: person ? { state: 'found', person } : { state: 'none' } })
    })()
    return () => {
      alive = false
    }
  }, [key, accountId, name, external])
  return result?.key === key ? result.lookup : { state: 'loading' }
}

function PersonCard({ accountId, name, external }: { accountId: string; name: string; external?: boolean }): JSX.Element {
  const lookup = usePersonLookup(accountId, name, external)
  const person = lookup.state === 'found' ? lookup.person : undefined
  const email = person?.email || person?.upn
  const [copied, setCopied] = useState(false)
  const img = person ? avatarUrl(accountId, person.mri, person.displayName, 'HR196x196') : undefined

  const copy = () => {
    if (!email) return
    void navigator.clipboard.writeText(email).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="cw-pcard">
      <div className="cw-pcard-head">
        <Avatar name={person?.displayName || name} size={56} color="colorful" idForColor={name} image={img ? { src: img } : undefined} />
        <div className="cw-pcard-titles">
          <div className="cw-pcard-name">{person?.displayName || name}</div>
          {person?.jobTitle && <div className="cw-pcard-sub">{person.jobTitle}</div>}
          {person?.department && <div className="cw-pcard-sub">{person.department}</div>}
          {external && <span className="cw-pcard-badge">Extern</span>}
        </div>
      </div>
      {lookup.state === 'loading' && <Spinner size="tiny" label="Profil wird gesucht …" />}
      {lookup.state === 'none' && <p className="cw-pcard-note">Im Verzeichnis gibt es zu diesem Namen kein eindeutiges Profil.</p>}
      {email && (
        <div className="cw-pcard-row">
          <Mail20Regular />
          <button className="cw-pcard-link" onClick={() => void api.openExternal(`mailto:${email}`)} title="E-Mail schreiben">
            {email}
          </button>
          <Tooltip content={copied ? 'Kopiert' : 'Adresse kopieren'} relationship="label" withArrow>
            <button className="cw-icon-btn" onClick={copy} aria-label="Adresse kopieren">
              {copied ? <Checkmark20Regular /> : <Copy20Regular />}
            </button>
          </Tooltip>
        </div>
      )}
      {person && (
        <div className="cw-pcard-actions">
          <Button size="small" icon={<Chat20Regular />} onClick={() => void api.openChatWith(accountId, person.mri)}>
            Chat
          </Button>
          {email && (
            <Button size="small" icon={<Mail20Regular />} onClick={() => void api.openExternal(`mailto:${email}`)}>
              E-Mail
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

// Öffnet beim Klick auf children eine Karte mit Profilangaben zur Person
export function PersonPopover({
  accountId,
  name,
  external,
  positioning = 'above-start',
  children
}: {
  accountId: string
  name: string
  external?: boolean
  positioning?: PositioningShorthand
  children: ReactElement
}): JSX.Element {
  return (
    <Popover withArrow positioning={positioning}>
      <PopoverTrigger disableButtonEnhancement>{children}</PopoverTrigger>
      <PopoverSurface className="cw-pcard-surface">
        <PersonCard accountId={accountId} name={name} external={external} />
      </PopoverSurface>
    </Popover>
  )
}
