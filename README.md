<img src="assets/icon.svg" width="64" height="64" alt="">

# Teams Everywhere

[![CI](https://github.com/TimSchulzRC/teams-everywhere/actions/workflows/ci.yml/badge.svg)](https://github.com/TimSchulzRC/teams-everywhere/actions/workflows/ci.yml)
[![Release](https://github.com/TimSchulzRC/teams-everywhere/actions/workflows/release.yml/badge.svg)](https://github.com/TimSchulzRC/teams-everywhere/actions/workflows/release.yml)
[![Neuester Nightly](https://img.shields.io/github/v/release/TimSchulzRC/teams-everywhere?include_prereleases&label=nightly)](https://github.com/TimSchulzRC/teams-everywhere/releases)
[![Lizenz: MIT](https://img.shields.io/github/license/TimSchulzRC/teams-everywhere)](LICENSE)

Eigener Teams-Client mit einer selbst gebauten Oberfläche im Stil der Teams-Desktop-App. Daten, Anmeldung und Anrufe kommen aus der Teams-Web-App, die pro Konto unsichtbar im Hintergrund läuft. Die App kann deshalb genau das, was die Web-App auf diesem Gerät kann.

Aktuell läuft Teams Everywhere auf macOS. Windows und Linux sind geplant.

> [!NOTE]
> Teams Everywhere ist ein privates Open-Source-Projekt. Es steht in keiner Verbindung zu Microsoft und wird von Microsoft weder unterstützt noch geprüft. „Microsoft Teams“ ist eine Marke der Microsoft Corporation.

## Installation

Fertige Builds liegen unter [Releases](https://github.com/TimSchulzRC/teams-everywhere/releases). Im Moment gibt es nur Nightlies. Sie entstehen jede Nacht automatisch aus `main`, sobald es neue Commits gibt.

1. Die passende DMG laden: `…-mac-arm64.dmg` für Apple Silicon (M1 und neuer), `…-mac-x64.dmg` für Intel-Macs.
2. Teams Everywhere aus der DMG in den Ordner Programme ziehen.
3. Die App ist nicht von Apple notarisiert, macOS blockiert sie deshalb beim ersten Start. Einmal im Terminal ausführen:

   ```sh
   xattr -dr com.apple.quarantine "/Applications/Teams Everywhere.app"
   ```

Danach sucht die App selbst nach Updates, 15 Sekunden nach dem Start und dann alle vier Stunden. Gibt es eine neue Version, erscheint unten in der linken Leiste der Knopf „Update“. Ein Klick lädt sie und prüft ihre SHA256-Summe, ein Klick auf „Neustart“ tauscht die App aus und startet sie neu. Unter Einstellungen → Updates siehst du Version und Kanal und kannst die Suche auch von Hand anstoßen. Nightly-Installationen bekommen Nightlies und Stable-Releases, Stable-Installationen nur Stable-Releases.

Das Update braucht Schreibrechte auf die App und ihren Ordner und klappt nicht, solange die App direkt aus der DMG läuft. Zieh sie in dem Fall wie in Schritt 2 in den Ordner Programme und starte sie von dort.

## Funktionen

- Mehrere Konten mit Kontowechsel, Anmeldung bleibt über Neustarts erhalten
- Chat-Liste wie in Teams: Favoriten (per Ziehen oder Rechtsklick sortierbar), eigene Abschnitte, Chats, Teams und Kanäle
- Nachrichten senden, bearbeiten, löschen, zitieren (Klick aufs Zitat springt zur Originalnachricht), Reaktionen, Lesebestätigung, große Emojis
- Kanäle mit Beiträgen und Antworten, Aktivität, Kalender (Woche/Arbeitswoche, Teilnehmen), Anrufverlauf, Personensuche
- Status setzen, Benachrichtigungen, Dock-Badge
- Besprechungen und Anrufe: Vorschau, Kamera, Mikrofon, Hand heben, Reaktionen, Hintergrundbilder (inkl. eigener Bilder), Geräteauswahl, Bildschirm teilen, Pop-out einzelner Videos in eigene Fenster, Kompaktansicht immer im Vordergrund, eingehende Anrufe
- macOS-Videoeffekte (Menüleiste) stehen zur Verfügung, solange die App im Vordergrund ist

## Aufbau

- **Engine pro Konto** (`src/main/engine/`): ein verstecktes Fenster mit `teams.microsoft.com` in einer eigenen Sitzung (`persist:acct-<id>`). Die App liest die Auth-Header der Web-App mit (`tokens.ts`) und ruft dieselben internen Dienste auf wie sie: Chat-Dienst, CSA (Teams, Kanäle, Ordner), Middle Tier (Personen, Kalender), Präsenz.
- **Skript in der Web-App** (`src/preload/engine-main.ts`): hält die Seite „sichtbar“, liest Anrufzustand, Teilnehmer und Videostreams aus, bedient Knöpfe (Stummschalten, Kamera, Hand, Hintergründe, Geräte) und schickt Video über eine lokale WebRTC-Verbindung an die eigenen Fenster.
- **Oberfläche** (`src/renderer/`): React mit Fluent UI. Hauptfenster, Anruffenster, Pop-out-Fenster für einzelne Videos, Klingelfenster.

## Entwickeln und bauen

Voraussetzung ist Node.js 24 (siehe `.nvmrc`).

```sh
npm install
npm run dev          # Entwicklung mit Hot Reload
npm run typecheck
npm run dist         # baut release/mac-arm64/Teams Everywhere.app (ad hoc signiert)
npm run dist:release # baut DMG und ZIP für arm64 und x64 wie die Release-Pipeline
```

Mit `TM_DEBUG_PORT=9339` startet die App mit Remote-Debugging. Nur dann ist die Diagnose-Schnittstelle `debugRaw` aktiv.

Wie Versionen und Releases entstehen, steht in [docs/releasing.md](docs/releasing.md). Hinweise für Beiträge stehen in [CONTRIBUTING.md](CONTRIBUTING.md).

## Bekannte Grenzen

- **Passkeys/Touch ID** bei der Microsoft-Anmeldung funktionieren in Electron nicht. Die App bricht diese Abfrage ab, dann bietet Microsoft andere Wege an (z. B. Authenticator-App).
- Die Anrufsteuerung bedient die Knöpfe der Web-App. Ändert Microsoft deren Kennungen (`data-tid`, `id`), muss `engine-main.ts` angepasst werden.
- Die interne Teams-API ist nicht dokumentiert und kann sich ändern.

## Lizenz

[MIT](LICENSE)
