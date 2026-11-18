# Versionen und Releases

Die Pipeline steht in [.github/workflows/release.yml](../.github/workflows/release.yml). Sie baut auf `macos-latest` eine DMG und eine ZIP für Apple Silicon (arm64) und Intel (x64) und hängt beide zusammen mit `SHA256SUMS.txt` an einen GitHub-Release.

## Kanäle

| Kanal   | Auslöser                                           | Versionsschema                          | Tag                                 | GitHub-Release       |
| ------- | -------------------------------------------------- | --------------------------------------- | ----------------------------------- | -------------------- |
| Nightly | jede Nacht um 03:17 UTC oder manuell               | `<basis>-nightly.<JJJJMMTT>.<Lauf-Nr.>` | `v0.1.0-nightly.20261118.7`         | Pre-Release          |
| Stable  | Tag-Push `v1.2.3` oder manuell mit Kanal „stable“  | `1.2.3`                                 | `v1.2.3`                            | Latest               |

Der geplante Nightly-Lauf baut nur, wenn `main` seit dem letzten Nightly neue Commits hat. Ein manuell gestarteter Nightly baut immer.

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

## Signierung

Die Builds sind ad hoc signiert und nicht notarisiert. macOS blockiert sie deshalb nach dem Download, Nutzer entfernen die Quarantäne mit `xattr` (siehe README). Für eine echte Signierung braucht es ein Apple-Developer-Konto. Dann kommen das Zertifikat (`CSC_LINK`, `CSC_KEY_PASSWORD`) und die Notarisierungsdaten (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) als Secrets ins Repo, und `mac.identity` in `package.json` fällt weg.

`electron-updater` setzt auf macOS eine Apple-Signatur voraus und fällt deshalb aus. Die App hat einen eigenen Updater (`src/main/updater.ts`). Er liest die Releases über die GitHub-API, lädt die ZIP für die eigene Architektur, gleicht sie mit `SHA256SUMS.txt` ab und prüft Bundle-ID und Signatur des neuen Bundles. Nach dem Beenden der App ersetzt ein Shell-Skript das Bundle und startet die neue Version. Jeder Release braucht deshalb je Architektur eine ZIP mit genau dem Namen `Teams-Everywhere-<Version>-mac-<Architektur>.zip` und eine `SHA256SUMS.txt` mit einem Eintrag für jede ZIP. Fehlt die ZIP für eine Architektur, sehen Apps auf dieser Architektur das Update nicht. Fehlt `SHA256SUMS.txt` oder der Eintrag darin, schlägt der Download fehl.

Zusätzlich gibt es je Architektur ein Patch-ZIP `Teams-Everywhere-<Version>-mac-<Architektur>-patch.zip`. Es enthält die App ohne `Contents/Frameworks/*.framework` und ist nur wenige MB groß (`scripts/patch-zip.sh`, im Release-Workflow nach dem Build). Der Updater lädt zuerst das Patch-ZIP und kopiert die Frameworks aus der installierten App dazu. Solange die Electron-Version gleich bleibt, sind sie bitgleich, und das Bundle besteht die Signaturprüfung. Nach einem Electron-Upgrade scheitert die Prüfung, dann lädt der Updater die volle ZIP. Fehlt das Patch-ZIP oder sein Eintrag in `SHA256SUMS.txt`, nimmt er ebenfalls die volle ZIP.
