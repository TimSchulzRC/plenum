# Mitmachen

Danke, dass du Teams Everywhere verbessern willst. Fehlerberichte, Ideen und Pull Requests sind willkommen.

## Fehler und Ideen

Nutze die Vorlagen unter [Issues](https://github.com/TimSchulzRC/teams-everywhere/issues/new/choose). Bevor du Logs anhängst, entferne Namen, Mailadressen und Nachrichteninhalte. Das Log liegt unter `~/Library/Application Support/Teams Everywhere/logs/main.log`, bei `pnpm run dev` unter `~/Library/Application Support/Teams Everywhere (dev)/logs/main.log`.

Sicherheitslücken meldest du bitte nicht öffentlich, sondern wie in [SECURITY.md](SECURITY.md) beschrieben.

## Entwickeln

```sh
pnpm install
pnpm run dev
```

Die Dev-Version hat eigene Konten und Anmeldungen und läuft neben der installierten App, ohne deren Daten anzufassen.

Vor jedem Pull Request:

```sh
pnpm run typecheck
pnpm run build
```

Die CI prüft beides bei jedem Pull Request.

## Pull Requests

- Ein Thema pro Pull Request. Kleine Änderungen werden schneller gemergt.
- Beschreibe, was sich ändert und wie du es getestet hast.
- Änderst du die Steuerung der Web-App in `src/preload/engine-main.ts`, teste einen echten Anruf oder eine Besprechung.
- Neue Abhängigkeiten nur, wenn es ohne sie deutlich aufwendiger wäre.
- Neue Nutzungsereignisse tragen nie Inhalte, Namen oder IDs und stehen in [docs/analytics.md](docs/analytics.md).

## Releases

Nightlies entstehen automatisch aus `main`. Stable-Releases legt der Maintainer an. Der Ablauf steht in [docs/releasing.md](docs/releasing.md).
