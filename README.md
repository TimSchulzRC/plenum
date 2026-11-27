<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/icons/stable-light.svg">
  <img src="assets/icons/stable.svg" width="64" height="64" alt="">
</picture>

# Plenum

[![CI](https://github.com/TimSchulzRC/plenum/actions/workflows/ci.yml/badge.svg)](https://github.com/TimSchulzRC/plenum/actions/workflows/ci.yml)
[![Release](https://github.com/TimSchulzRC/plenum/actions/workflows/release.yml/badge.svg)](https://github.com/TimSchulzRC/plenum/actions/workflows/release.yml)
[![Neuester Nightly](https://img.shields.io/github/v/release/TimSchulzRC/plenum?include_prereleases&label=nightly)](https://github.com/TimSchulzRC/plenum/releases)
[![Lizenz: MIT](https://img.shields.io/github/license/TimSchulzRC/plenum)](LICENSE)

Eigener Client für Microsoft Teams mit Mail und Kalender, mit einer selbst gebauten Oberfläche im Stil der Teams-Desktop-App. Daten, Anmeldung und Anrufe kommen aus der Teams-Web-App, die pro Konto unsichtbar im Hintergrund läuft. Die App kann deshalb genau das, was die Web-App auf diesem Gerät kann.

Aktuell läuft Plenum auf macOS. Windows und Linux sind geplant.

Bis November 2026 hieß die App Teams Everywhere. Bestehende Installationen bekommen Plenum als normales Update. Beim ersten Start benennt sich die App in Programme um und übernimmt Konten, Anmeldungen und Einstellungen.

> [!NOTE]
> Plenum ist ein privates Open-Source-Projekt. Es steht in keiner Verbindung zu Microsoft und wird von Microsoft weder unterstützt noch geprüft. „Microsoft Teams“ ist eine Marke der Microsoft Corporation.

## Installation

Fertige Builds liegen unter [Releases](https://github.com/TimSchulzRC/plenum/releases). Im Moment gibt es nur Nightlies. Sie entstehen automatisch aus `main`, höchstens alle 6 Stunden und nur, wenn es neue Commits gibt.

1. Die passende DMG laden: `…-mac-arm64.dmg` für Apple Silicon (M1 und neuer), `…-mac-x64.dmg` für Intel-Macs.
2. Plenum aus der DMG in den Ordner Programme ziehen. Nightlies heißen „Plenum (nightly)“.
3. Die App ist nicht von Apple notarisiert, macOS blockiert sie deshalb beim ersten Start. Einmal im Terminal ausführen (bei Stable-Releases ohne „ (nightly)“):

   ```sh
   xattr -dr com.apple.quarantine "/Applications/Plenum (nightly).app"
   ```

Danach sucht die App selbst nach Updates, 15 Sekunden nach dem Start und dann alle 30 Minuten. Gibt es eine neue Version, erscheint unten in der linken Leiste der Knopf „Update“. Ein Klick lädt sie und prüft ihre SHA256-Summe, ein Klick auf „Neustart“ tauscht die App aus und startet sie neu. Unter Einstellungen → Updates siehst du Version und Kanal und kannst die Suche auch von Hand anstoßen. Nightly-Installationen bekommen Nightlies und Stable-Releases, Stable-Installationen nur Stable-Releases.

Das Update braucht Schreibrechte auf die App und ihren Ordner und klappt nicht, solange die App direkt aus der DMG läuft. Zieh sie in dem Fall wie in Schritt 2 in den Ordner Programme und starte sie von dort.

## Funktionen

- Mehrere Konten mit Kontowechsel, Anmeldung bleibt über Neustarts erhalten
- Chat-Liste wie in Teams: Favoriten (per Ziehen oder Rechtsklick sortierbar), eigene Abschnitte, Chats, Teams und Kanäle
- Nachrichten senden, bearbeiten, löschen, zitieren (Klick aufs Zitat springt zur Originalnachricht), Reaktionen, Lesebestätigung, große Emojis
- Kanäle mit Beiträgen und Antworten, Aktivität, Kalender (Woche/Arbeitswoche, Teilnehmen), Anrufverlauf, Personensuche
- E-Mail aller Konten: Ordner, gemeinsamer Posteingang, Lesen (externe Bilder erst auf Wunsch), Antworten, Allen antworten, Weiterleiten, neue Mail mit Anhängen bis 3 MB, als ungelesen markieren, löschen
- Status setzen, Benachrichtigungen, Dock-Badge
- Besprechungen und Anrufe: Vorschau, Kamera, Mikrofon, Hand heben, Reaktionen, Hintergrundbilder (inkl. eigener Bilder), Geräteauswahl, Bildschirm teilen, Pop-out einzelner Videos in eigene Fenster, Kompaktansicht immer im Vordergrund, eingehende Anrufe
- macOS-Videoeffekte (Menüleiste) stehen zur Verfügung, solange die App im Vordergrund ist
- Lokaler MCP-Server für Claude Code, Codex und andere MCP-Clients, nur lesend (siehe unten)

## Claude Code und Codex (MCP)

Plenum bringt einen lokalen MCP-Server mit. Claude Code, Codex und andere MCP-Clients auf demselben Gerät können darüber deine Teams-Daten lesen, in allen angemeldeten Konten: Chats, Kanäle, Nachrichten, geteilte Dateien und Bilder, Anrufverlauf, Aktivität, Kalender und das Personenverzeichnis. Senden, ändern oder als gelesen markieren kann der Server nichts.

1. Einstellungen → Claude Code und Codex → MCP-Server einschalten.
2. Bei Claude Code oder Codex auf „Eintragen“ klicken. Die App ruft dann `claude mcp add` bzw. `codex mcp add` auf und trägt den Server für alle Projekte ein. Alternativ den angezeigten Befehl kopieren und im Terminal ausführen. Für andere Clients stehen dort auch der JSON-Eintrag und der Abschnitt für `~/.codex/config.toml`.
3. Laufende Sitzungen von Claude Code oder Codex neu starten.

Aus der Zeit als Teams Everywhere eingetragene Server (`teams-everywhere`) funktionieren weiter. „Eintragen“ ersetzt sie durch `plenum`.

Danach reicht eine Frage wie „Was gab es heute Neues in Teams?“ oder „Welche Anrufe habe ich verpasst?“.

Der Server lauscht nur auf `127.0.0.1`, Port 47311 (Dev: 47312), und läuft, solange die App offen ist. Die Adresse enthält einen geheimen Schlüssel. „Neuer Schlüssel“ in den Einstellungen macht alte Einträge ungültig, danach den Server neu eintragen. Ist der Port belegt, nimmt die App einen freien Port und zeigt die neue Adresse an.

Werkzeuge: `list_accounts`, `list_conversations`, `list_teams`, `get_messages`, `search_messages`, `list_files`, `read_file`, `get_call_history`, `get_activity`, `get_calendar`, `search_people`. `search_messages` und `list_files` lesen die zuletzt aktiven Unterhaltungen ab einem Datum (Standard: 30 Tage) und durchsuchen sie lokal, eine Volltextsuche über das ganze Archiv ist das nicht. `read_file` legt jede Datei zusätzlich im Temp-Ordner unter „Plenum MCP“ ab, damit der Agent auch PDFs und Office-Dateien lesen kann. Dateien aus SharePoint und OneDrive holt die App über Microsoft Graph mit dem Token der Teams-Web-App.

## Datenschutz

Die App sendet anonyme Nutzungsdaten und Fehlerberichte an PostHog (EU). Nachrichten, Namen, Mailadressen, Kontodaten und IP-Adressen gehen nie mit. Unter Einstellungen › Feedback kannst du Probleme und Ideen direkt schicken. Welche Ereignisse die App sendet, steht in [docs/analytics.md](docs/analytics.md).

## Aufbau

- **Engine pro Konto** (`src/main/engine/`): ein verstecktes Fenster mit `teams.microsoft.com` in einer eigenen Sitzung (`persist:acct-<id>`). Die App liest die Auth-Header der Web-App mit (`tokens.ts`) und ruft dieselben internen Dienste auf wie sie: Chat-Dienst, CSA (Teams, Kanäle, Ordner), Middle Tier (Personen, Kalender), Präsenz. E-Mail läuft über Microsoft Graph mit dem Graph-Token der Web-App, sonst über Outlook REST. Senden geht immer über Outlook, nur dessen Token hat `Mail.Send`.
- **Skript in der Web-App** (`src/preload/engine-main.ts`): hält die Seite „sichtbar“, liest Anrufzustand, Teilnehmer und Videostreams aus, bedient Knöpfe (Stummschalten, Kamera, Hand, Hintergründe, Geräte) und schickt Video über eine lokale WebRTC-Verbindung an die eigenen Fenster.
- **Oberfläche** (`src/renderer/`): React mit Fluent UI. Hauptfenster, Anruffenster, Pop-out-Fenster für einzelne Videos, Klingelfenster.
- **MCP-Server** (`src/main/mcp/`): HTTP-Server auf 127.0.0.1 mit JSON-RPC nach MCP (Streamable HTTP, ohne SSE). `tools.ts` enthält die lesenden Werkzeuge, `source.ts` verbindet sie mit den Konten. Einstellungen und Schlüssel liegen in `mcp.json` im Datenordner.

## Entwickeln und bauen

Voraussetzung sind Node.js 24 (siehe `.nvmrc`) und pnpm in der Version aus `packageManager` in `package.json`.

```sh
pnpm install
pnpm run dev          # Entwicklung mit Hot Reload
pnpm run typecheck
pnpm run dist         # baut release/mac-arm64/Plenum.app (ad hoc signiert)
pnpm run dist:release # baut DMG und ZIP für arm64 und x64 wie die Release-Pipeline
```

`pnpm run dev` und `pnpm start` laufen als „Plenum (dev)“ mit eigenem Datenordner `~/Library/Application Support/Plenum (dev)`. Konten, Anmeldungen, Einstellungen und Logs der installierten App bleiben unberührt, und beide können gleichzeitig laufen. Der Dev-Ordner hängt nicht am Checkout, Anmeldungen bleiben also auch in neuen Worktrees und nach Updates erhalten. Vor jedem Start trägt `scripts/dev-app.mjs` Namen, eigene Bundle-ID (`io.github.timschulzrc.teamseverywhere.dev`) und das Dev-Icon in die Electron.app unter `node_modules` ein und signiert sie ad hoc neu. So zeigen Dock und Mitteilungen das Dev-Icon, und macOS fragt die Mitteilungen für Dev getrennt ab.

Jede Ausgabe hat ein eigenes Icon mit derselben Marke: Stable dunkel mit Amber-Punkt, Nightly unter einem Nachthimmel, Dev auf einer Blaupause. Im Dev-Modus setzt die App das Dev-Icon beim Start ins Dock. `pnpm run icons` erzeugt alle Icons aus `scripts/icons.mjs` neu: die SVGs unter `assets/icons` (dunkel und hell), `build/icon.icns`, `build/icon-nightly.icns` und `build/icon-dev.png`.

Zu jedem Pull Request gibt es einen fertigen Dev-Build zum Herunterladen. Er läuft ebenfalls als „Plenum (dev)“ mit demselben Datenordner, Anmeldungen aus Dev gelten also auch dort (siehe [docs/releasing.md](docs/releasing.md#pr-builds)).

Stable und Nightly teilen sich den Ordner `~/Library/Application Support/Plenum`. Mit `TE_USER_DATA_DIR=<Ordner>` startet jede Ausgabe mit einem anderen Datenordner.

Mit `TM_DEBUG_PORT=9339` startet die App mit Remote-Debugging. Nur dann ist die Diagnose-Schnittstelle `debugRaw` aktiv.

Wie Versionen und Releases entstehen, steht in [docs/releasing.md](docs/releasing.md). Hinweise für Beiträge stehen in [CONTRIBUTING.md](CONTRIBUTING.md).

## Bekannte Grenzen

- **Passkeys/Touch ID** bei der Microsoft-Anmeldung funktionieren in Electron nicht. Die App bricht diese Abfrage ab, dann bietet Microsoft andere Wege an (z. B. Authenticator-App).
- Die Anrufsteuerung bedient die Knöpfe der Web-App. Ändert Microsoft deren Kennungen (`data-tid`, `id`), muss `engine-main.ts` angepasst werden.
- Die interne Teams-API ist nicht dokumentiert und kann sich ändern.

## Lizenz

[MIT](LICENSE)
