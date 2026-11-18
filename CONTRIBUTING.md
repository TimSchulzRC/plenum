# Mitmachen

Danke, dass du Teams Everywhere verbessern willst. Fehlerberichte, Ideen und Pull Requests sind willkommen.

## Fehler und Ideen

Nutze die Vorlagen unter [Issues](https://github.com/TimSchulzRC/teams-everywhere/issues/new/choose). Bevor du Logs anhängst, entferne Namen, Mailadressen und Nachrichteninhalte. Das Log liegt unter `~/Library/Application Support/Teams Everywhere/logs/main.log`.

Sicherheitslücken meldest du bitte nicht öffentlich, sondern wie in [SECURITY.md](SECURITY.md) beschrieben.

## Entwickeln

```sh
pnpm install
pnpm run dev
```

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

## Releases

Nightlies entstehen automatisch aus `main`. Stable-Releases legt der Maintainer an. Der Ablauf steht in [docs/releasing.md](docs/releasing.md).
