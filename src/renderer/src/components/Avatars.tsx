import { Avatar, AvatarGroup, AvatarGroupItem, type PresenceBadgeStatus } from '@fluentui/react-components'
import { CalendarLtr20Regular, PeopleTeam20Regular } from '@fluentui/react-icons'
import { accountTitle } from '@shared/accounts'
import type { Availability, ChatSummary, Presence, Team } from '@shared/types'
import { avatarUrl, teamPictureUrl } from '../lib/media'
import { useScopedAccountId, useStore } from '../store'

export function presenceStatus(p?: Presence): PresenceBadgeStatus | undefined {
  if (!p) return undefined
  if (p.outOfOffice && p.availability !== 'Offline') return 'out-of-office'
  const map: Record<Availability, PresenceBadgeStatus> = {
    Available: 'available',
    AvailableIdle: 'away',
    Busy: 'busy',
    BusyIdle: 'busy',
    DoNotDisturb: 'do-not-disturb',
    BeRightBack: 'away',
    Away: 'away',
    Offline: 'offline',
    PresenceUnknown: 'unknown'
  }
  return map[p.availability] ?? 'unknown'
}

export function presenceLabel(p?: Presence): string {
  if (!p) return ''
  const map: Record<string, string> = {
    Available: 'Verfügbar',
    AvailableIdle: 'Verfügbar, untätig',
    Busy: 'Beschäftigt',
    BusyIdle: 'Beschäftigt',
    DoNotDisturb: 'Nicht stören',
    BeRightBack: 'Bin gleich zurück',
    Away: 'Abwesend',
    Offline: 'Offline',
    PresenceUnknown: 'Status unbekannt'
  }
  const activity: Record<string, string> = {
    InACall: 'In einem Anruf',
    InAConferenceCall: 'In einer Telefonkonferenz',
    InAMeeting: 'In einer Besprechung',
    Presenting: 'Präsentiert',
    UrgentInterruptionsOnly: 'Nur dringende Unterbrechungen',
    OutOfOffice: 'Nicht im Büro'
  }
  if (p.activity && activity[p.activity]) return activity[p.activity]
  if (p.outOfOffice) return 'Nicht im Büro'
  return map[p.availability] ?? p.availability
}

export function PersonAvatar({
  mri,
  name,
  size = 32,
  showPresence = true,
  accountId
}: {
  mri?: string
  name: string
  size?: 16 | 20 | 24 | 28 | 32 | 36 | 40 | 48 | 56 | 64 | 72 | 96
  showPresence?: boolean
  accountId?: string
}): JSX.Element {
  const scoped = useScopedAccountId()
  const acct = accountId ?? scoped
  const presence = useStore((s) => (mri && showPresence ? s.snapshots[acct]?.presence[mri] : undefined))
  const status = presenceStatus(presence)
  const img = mri ? avatarUrl(acct, mri, name, size > 48 ? 'HR196x196' : 'HR64x64') : undefined
  return (
    <Avatar
      name={name}
      size={size}
      color="colorful"
      image={img ? { src: img } : undefined}
      badge={status && showPresence ? { status, outOfOffice: !!presence?.outOfOffice && status !== 'out-of-office' } : undefined}
    />
  )
}

export function ChatAvatar({ chat, size = 32 }: { chat: ChatSummary; size?: 24 | 28 | 32 | 36 | 40 | 48 }): JSX.Element {
  const acct = useScopedAccountId()
  const me = useStore((s) => s.snapshots[acct]?.me)
  if (chat.kind === 'meeting') {
    return <Avatar size={size} icon={<CalendarLtr20Regular />} color="brand" aria-label={chat.title} />
  }
  if (chat.kind === 'channel') {
    return <Avatar shape="square" size={size} icon={<PeopleTeam20Regular />} color="colorful" name={chat.title} />
  }
  if (chat.kind === 'oneOnOne' || chat.members.length <= 1) {
    const mri = chat.members[0] ?? me?.mri
    return <PersonAvatar mri={mri} name={chat.memberNames?.[mri ?? ''] || chat.title} size={size} />
  }
  const items = chat.members.slice(0, 3)
  return (
    <AvatarGroup layout="pie" size={size}>
      {items.map((m) => {
        const n = chat.memberNames?.[m] || '?'
        return <AvatarGroupItem key={m} name={n} image={{ src: avatarUrl(acct, m, n, 'HR64x64') }} />
      })}
    </AvatarGroup>
  )
}

export function TeamAvatar({ team, size = 32 }: { team: Team; size?: 20 | 24 | 28 | 32 | 36 | 40 | 48 }): JSX.Element {
  const acct = useScopedAccountId()
  const groupId = (team as Team & { groupId?: string }).groupId
  const img = teamPictureUrl(acct, groupId, team.pictureETag, team.displayName)
  return <Avatar shape="square" size={size} name={team.displayName} color="colorful" image={img ? { src: img } : undefined} />
}

// Im Chatkopf: zu welchem Konto oder Mandanten die Unterhaltung gehört. Nur bei mehreren Konten,
// denn dann zeigt die Chatliste alle untereinander und Nachrichten gehen über das Konto des Chats.
export function AccountChip(): JSX.Element | null {
  const account = useStore((s) => (s.accounts.length > 1 ? s.accounts.find((a) => a.id === s.activeAccountId) : undefined))
  if (!account) return null
  const { name, sub } = accountTitle(account)
  return (
    <span className="acct-chip" title={`Du schreibst als ${account.upn ?? account.label}${account.parentId ? ` (Gast bei ${name})` : ''}`}>
      {account.parentId ? <Avatar shape="square" size={16} name={name} color="colorful" /> : <PersonAvatar mri={account.mri} name={account.label} size={16} accountId={account.id} showPresence={false} />}
      <span>{name}</span>
      {account.parentId && <span className="acct-chip-sub">{sub}</span>}
    </span>
  )
}
