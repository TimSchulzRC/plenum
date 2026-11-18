import { Tooltip } from '@fluentui/react-components'
import { ArrowClockwise24Regular, ArrowDownload24Regular, ErrorCircle24Regular } from '@fluentui/react-icons'
import type { CSSProperties } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { confirmInstall, resolveUpdateAction, showUpdateButton, updateTooltip } from '../update'

// Update-Knopf unten in der App-Leiste. Erscheint nur, wenn es etwas zu tun gibt.
export function UpdateButton(): JSX.Element | null {
  const update = useStore((s) => s.update)
  const inCall = useStore((s) => s.callState !== null)
  if (!update || !showUpdateButton(update)) return null

  const action = resolveUpdateAction(update)
  const downloading = update.status === 'downloading'
  const installing = update.status === 'installing'
  const failed = update.status === 'error'
  const percent = update.downloadPercent ?? 0

  const label = downloading ? `${percent} %` : installing ? 'Startet neu' : action === 'install' ? 'Neustart' : 'Update'
  const Icon = failed ? ErrorCircle24Regular : action === 'install' || installing ? ArrowClockwise24Regular : ArrowDownload24Regular

  const onClick = () => {
    if (action === 'download') void api.downloadUpdate()
    else if (action === 'install' && confirmInstall(update, inCall)) void api.installUpdate()
  }

  return (
    <Tooltip content={updateTooltip(update)} relationship="description" positioning="after" withArrow>
      <button
        className={`rail-item rail-update ${failed ? 'failed' : ''}`}
        disabled={downloading || installing}
        onClick={onClick}
        style={downloading ? ({ '--update-progress': `${percent}%` } as CSSProperties) : undefined}
      >
        <Icon />
        <span>{label}</span>
      </button>
    </Tooltip>
  )
}
