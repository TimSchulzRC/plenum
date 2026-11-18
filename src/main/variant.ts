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

// Interner Name, an dem Datenordner und Keychain-Eintrag hängen. Electron bildet aus
// app.name den Keychain-Eintrag „<Name> Safe Storage“, mit dem Chromium die Cookies
// verschlüsselt. Stable und Nightly teilen sich deshalb Name und Daten, sonst wären
// nach einem Kanalwechsel alle Anmeldungen weg. Dev bekommt eigene Daten, die über
// alle Checkouts und Versionen hinweg dieselben bleiben.
export function dataName(variant: AppVariant): string {
  return variant === 'dev' ? `${BASE_NAME} (dev)` : BASE_NAME
}
