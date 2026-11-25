import { Button } from '@fluentui/react-components'
import { DataUsage20Regular } from '@fluentui/react-icons'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { USAGE_DATA_DOC } from '../analytics'
import { useStore } from '../store'

// Einmalige Frage nach Nutzungsdaten und Fehlerberichten. Bis zur Antwort sendet die App nichts.
// Erscheint nur, wenn die App mit PostHog-Schlüssel gebaut wurde (Releases, nicht `pnpm run dev`).
export function UsageDataPrompt({ card }: { card?: boolean }): JSX.Element | null {
  const asked = useStore((s) => s.settings?.usageData !== undefined)
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    void api.getAnalyticsInfo().then((i) => setAvailable(i.available))
  }, [])
  if (!available || asked) return null
  const answer = (on: boolean) => void api.setUsageData(on, 'prompt')
  return (
    <div className={card ? 'usage-prompt card' : 'banner usage-prompt'}>
      <DataUsage20Regular className="usage-prompt-icon" />
      <div className="usage-prompt-text">
        <b>Hilf mit, Teams Everywhere zu verbessern.</b> Darf die App anonyme Nutzungsdaten und Fehlerberichte senden? Nachrichten, Namen und Kontodaten verlassen deinen Mac nie. Du kannst das jederzeit in den Einstellungen ändern.
      </div>
      <div className="usage-prompt-actions">
        <Button size="small" appearance="transparent" onClick={() => void api.openExternal(USAGE_DATA_DOC)}>
          Details
        </Button>
        <Button size="small" onClick={() => answer(false)}>
          Nein, danke
        </Button>
        <Button size="small" appearance="primary" onClick={() => answer(true)}>
          Ja, senden
        </Button>
      </div>
    </div>
  )
}
