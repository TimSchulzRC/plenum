# Versionen und Releases

Die Pipeline steht in [.github/workflows/release.yml](../.github/workflows/release.yml). Sie baut auf `macos-latest` eine DMG und eine ZIP für Apple Silicon (arm64) und Intel (x64) und hängt beide zusammen mit `SHA256SUMS.txt` an einen GitHub-Release.

## Kanäle

| Kanal   | Auslöser                                           | Versionsschema                          | Tag                                 | GitHub-Release       |
| ------- | -------------------------------------------------- | --------------------------------------- | ----------------------------------- | -------------------- |
| Nightly | automatisch höchstens alle 6 Stunden oder manuell  | `<basis>-nightly.<JJJJMMTT>.<Lauf-Nr.>` | `v0.1.0-nightly.20261118.7`         | Pre-Release          |
| Stable  | Tag-Push `v1.2.3` oder manuell mit Kanal „stable“  | `1.2.3`                                 | `v1.2.3`                            | Latest               |

Nightlies heißen „Plenum (nightly)“ und haben ein eigenes Icon, die Pipeline setzt dafür `build.productName` und `build.mac.icon` (`build/icon-nightly.icns`). Bundle-ID, Datenordner und der interne Name (`app.name`) bleiben dieselben wie bei Stable, ein Kanalwechsel per Update behält also Konten und Anmeldungen. Eine schon installierte App behält beim Update ihren Dateinamen in Programme und zeigt den neuen Namen in Menüleiste und Über-Fenster.

Der Zeitplan startet den Workflow alle 30 Minuten (Minute 8 und 38). Er baut nur, wenn der letzte Nightly mindestens 6 Stunden alt ist und `main` seitdem neue Commits hat. Sonst endet der Lauf nach dem Schritt „Version bestimmen“ ohne Build. Fällt bei GitHub ein geplanter Lauf aus, holt der nächste ihn also nach. Ein manuell gestarteter Nightly baut immer und setzt die 6 Stunden neu an.

Die Basis eines Nightlys ist die Version aus `package.json`. Gibt es diese Version schon als Stable-Tag, nimmt die Pipeline die nächste Patch-Version. Nach `v0.1.0` heißen Nightlies also automatisch `0.1.1-nightly.…` und sortieren damit nach dem Stable-Release.

Die Pipeline schreibt die Version nur im Build in `package.json`. Im Repo bleibt die Version stehen, bis du sie selbst änderst.

## Nightly von Hand starten

Unter Actions → Release → „Run workflow“ den Kanal „nightly“ wählen. Oder im Terminal:

```sh
gh workflow run release.yml -f channel=nightly
```

## Stable-Release anlegen

1. Version in `package.json` setzen, z. B. `0.2.0`, committen und nach `main` pushen.
2. Release auslösen, entweder per Tag:

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

   oder per Workflow, der den Tag selbst anlegt:

   ```sh
   gh workflow run release.yml -f channel=stable -f version=0.2.0
   ```

3. Die Release-Notes enthalten die Commits seit dem letzten Stable-Release. Wer mehr erklären will, bearbeitet den Release danach auf GitHub.

Für Minor- und Major-Sprünge erhöhst du die Version in `package.json` schon vorher. Die Nightlies heißen dann z. B. `0.3.0-nightly.…`.

## PR-Builds

Zu jedem Pull Request baut [.github/workflows/pr-build.yml](../.github/workflows/pr-build.yml) die App für Apple Silicon und schreibt einen Kommentar mit dem Download-Link in den Pull Request. Jeder neue Push ersetzt Build und Link im selben Kommentar. Die ZIP liegt 14 Tage als Artefakt am Workflow-Lauf, der Link braucht eine Anmeldung bei GitHub.

Ein PR-Build ist die Dev-Ausgabe, kein Release:

- Er heißt „Plenum (dev)“, hat das Dev-Icon und die Bundle-ID `io.github.timschulzrc.teamseverywhere.dev` wie `pnpm run dev`. Stable und Nightly bleiben daneben installiert, macOS fragt Mitteilungen getrennt ab.
- Die Version endet auf `-dev.pr<Nummer>.<Lauf-Nr.>`, z. B. `0.1.0-dev.pr31.4`. Daran erkennt die gepackte App, dass sie Dev ist (`src/main/variant.ts`).
- Er nutzt den Datenordner `~/Library/Application Support/Plenum (dev)`, denselben wie `pnpm run dev`. Konten und Anmeldungen bleiben über neue PR-Builds hinweg erhalten. Dev-Build und `pnpm run dev` können deshalb nicht gleichzeitig laufen.
- Er sucht keine Updates. Einen neueren Stand gibt es nur über den nächsten Build im Pull Request.

Installieren: ZIP laden, entpacken, „Plenum (dev)“ in den Ordner Programme ziehen und die Quarantäne entfernen:

```sh
xattr -dr com.apple.quarantine "/Applications/Plenum (dev).app"
```

Pull Requests aus Forks und von Dependabot bekommen den Build als Artefakt am Workflow-Lauf, aber keinen Kommentar, weil ihr Token keine Schreibrechte hat.

## Signierung

Die Builds sind ad hoc signiert und nicht notarisiert. macOS blockiert sie deshalb nach dem Download, Nutzer entfernen die Quarantäne mit `xattr` (siehe README). Für eine echte Signierung braucht es ein Apple-Developer-Konto. Dann kommen das Zertifikat (`CSC_LINK`, `CSC_KEY_PASSWORD`) und die Notarisierungsdaten (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) als Secrets ins Repo, und `mac.identity` in `package.json` fällt weg.

`electron-updater` setzt auf macOS eine Apple-Signatur voraus und fällt deshalb aus. Die App hat einen eigenen Updater (`src/main/updater.ts`). Er liest die Releases über die GitHub-API, lädt die ZIP für die eigene Architektur, gleicht sie mit `SHA256SUMS.txt` ab und prüft Bundle-ID und Signatur des neuen Bundles. Nach dem Beenden der App ersetzt ein Shell-Skript das Bundle und startet die neue Version. Jeder Release braucht deshalb je Architektur eine ZIP mit genau dem Namen `Plenum-<Version>-mac-<Architektur>.zip` und eine `SHA256SUMS.txt` mit einem Eintrag für jede ZIP. Fehlt die ZIP für eine Architektur, sehen Apps auf dieser Architektur das Update nicht. Fehlt `SHA256SUMS.txt` oder der Eintrag darin, schlägt der Download fehl.

Zusätzlich gibt es je Architektur ein Patch-ZIP `Plenum-<Version>-mac-<Architektur>-patch.zip`. Es enthält die App ohne `Contents/Frameworks/*.framework` und ist nur wenige MB groß (`scripts/patch-zip.sh`, im Release-Workflow nach dem Build). Der Updater lädt zuerst das Patch-ZIP und kopiert die Frameworks aus der installierten App dazu. Solange die Electron-Version gleich bleibt, sind sie bitgleich, und das Bundle besteht die Signaturprüfung. Nach einem Electron-Upgrade scheitert die Prüfung, dann lädt der Updater die volle ZIP. Fehlt das Patch-ZIP oder sein Eintrag in `SHA256SUMS.txt`, nimmt er ebenfalls die volle ZIP.

Nach dem Tausch setzt das Skript ein neues Änderungsdatum und registriert das Bundle neu (`lsregister -f`), damit Finder und Dock ein geändertes Icon zeigen. Notification Center lädt das Icon für Mitteilungen erst nach einem Neustart des Prozesses neu. Deshalb merkt sich die App die SHA256-Summe von `Contents/Resources/icon.icns` in `notification-icon.txt` im Datenordner. Weicht sie beim Start ab, beendet die App einmal `NotificationCenter`, launchd startet ihn sofort neu (`src/main/notification-icon.ts`).

## Übergang von Teams Everywhere

Bis November 2026 hieß die App „Teams Everywhere“. Installationen aus dieser Zeit kommen ohne Neuinstallation auf Plenum:

- Die Bundle-ID bleibt `io.github.timschulzrc.teamseverywhere`. Der alte Updater nimmt nur Bundles mit seiner eigenen ID an, und macOS knüpft die Mitteilungsrechte daran.
- Der alte Updater sucht nach `Teams-Everywhere-<Version>-mac-<Architektur>.zip` und dem Patch-ZIP dazu. Der Release-Workflow lädt deshalb jede ZIP zusätzlich unter dem alten Namen hoch (Schritt „ZIPs unter altem Namen“). Der Schritt kann weg, sobald keine Installation mehr Teams Everywhere ist.
- Der alte Updater legt Plenum unter den alten Pfad, etwa `/Applications/Teams Everywhere.app`. Beim ersten Start beendet sich Plenum, ein Skript benennt das Bundle in `Plenum.app` bzw. `Plenum (nightly).app` um und startet es neu (`renamedBundlePath` in `src/main/legacy-data.ts`, `renameBundleAfterQuit` in `src/main/updater.ts`). Liegt unter dem neuen Namen schon eine App oder fehlen die Schreibrechte, bleibt der alte Name. Das Protokoll steht in `logs/update.log`.
- Der Datenordner zieht von `Teams Everywhere` nach `Plenum` um, Dev von `Teams Everywhere (dev)` nach `Plenum (dev)`. Läuft die alte App noch, bittet Plenum darum, sie zu beenden.
- Der MCP-Server heißt jetzt `plenum` (Dev: `plenum-dev`). Alte Einträge `teams-everywhere` funktionieren weiter, weil Port und Schlüssel gleich bleiben. „Eintragen“ in den Einstellungen entfernt sie und trägt `plenum` ein.

Das Repo hieß bis zur Umbenennung `TimSchulzRC/teams-everywhere`. GitHub leitet die alten Adressen weiter, auch API-Aufrufe und Downloads. Alte Installationen fragen genau diese Adresse ab und finden Updates nur über die Weiterleitung. Deshalb unter diesem Konto nie wieder ein Repo `teams-everywhere` anlegen, sonst endet die Weiterleitung.
