// Welche Ausgabe der App läuft: installierte Stable, installierte Nightly oder Entwicklung.
// Ohne Electron-Abhängigkeiten, damit `pnpm test` die Logik direkt prüfen kann.
import type { UpdateChannel } from './update/releases'

export type AppVariant = 'stable' | 'nightly' | 'dev'

export const BASE_NAME = 'Teams Everywhere'

// Nicht gepackt heißt `pnpm run dev` oder `pnpm start` aus einem Checkout.
// Den Kanal liefert channelOf() aus der Versionsnummer.
export function appVariant(packaged: boolean, channel: UpdateChannel): AppVariant {
  return packaged ? channel : 'dev'
}

// Name in Menüs und im Über-Fenster.
export function displayName(variant: AppVariant): string {
  return variant === 'stable' ? BASE_NAME : `${BASE_NAME} (${variant})`
}

// Interner Name (app.name), an dem der Datenordner hängt. Electron bildet daraus auch den
// Keychain-Eintrag „<Name> Safe Storage“ für safeStorage und Cookie-Verschlüsselung (beides
// ist derzeit aus). Stable und Nightly teilen sich Name und Daten, damit ein Kanalwechsel
// per Update die Anmeldungen behält. Dev bekommt eigene Daten, die über alle Checkouts
// und Versionen hinweg dieselben bleiben.
export function dataName(variant: AppVariant): string {
  return variant === 'dev' ? `${BASE_NAME} (dev)` : BASE_NAME
}
