# Nutzungsdaten und Fehlerberichte

Teams Everywhere sendet anonyme Nutzungsdaten und Fehlerberichte an [PostHog](https://posthog.com), ein Analysewerkzeug mit Rechenzentrum in der EU. Damit sehe ich, welche Funktionen genutzt werden, wo Anrufe scheitern und welche Fehler bei wem auftreten.

## Wann die App sendet

- Builds mit Projektschlüssel senden immer, ohne Abfrage und ohne Schalter. Die Release-Pipeline setzt den Schlüssel aus den Repository-Variablen. `pnpm run dev` und Builds aus Forks haben keinen Schlüssel und senden nichts.
- Unter Einstellungen › Datenschutz steht die anonyme ID der Installation. Wer einen Fehler meldet, kann sie nennen, dann lassen sich die passenden Fehlermeldungen finden.
- Feedback unter Einstellungen › Feedback trägt dieselbe ID.

## Was nie gesendet wird

- Inhalte von Nachrichten, Betreffzeilen, Suchbegriffe, Dateinamen
- Namen, Mailadressen, Telefonnummern, Konto- und Tenant-IDs
- IDs von Chats, Kanälen, Teams, Besprechungen und Personen
- Gerätenamen von Kamera, Mikrofon und Lautsprecher (nur, ob eins gewählt ist)
- Anmeldetokens und Cookies
- IP-Adressen: Das PostHog-Projekt speichert sie nicht (`anonymize_ips`), GeoIP ist aus

Fehlermeldungen und Stacktraces laufen vor dem Senden durch `scrubText` in [src/shared/analytics.ts](../src/shared/analytics.ts). Die Funktion ersetzt Mailadressen, Teams-IDs (`19:…@thread.v2`, `8:orgid:…`), GUIDs, Tokens, Query-Strings von URLs und den Benutzernamen in Pfaden. Die Tests in [test/analytics.test.ts](../test/analytics.test.ts) prüfen das.

## Was gesendet wird

Kennung ist eine zufällige ID pro Installation (`analytics.json` im Datenordner). Stable und Nightly teilen sich den Datenordner und damit die ID. Eine Sitzung endet nach 30 Minuten ohne Bedienung.

Jedes Ereignis trägt: App-Version, Kanal (`stable`, `nightly`, `dev`), Betriebssystem und Version, Architektur, Electron-Version, Sprache des Systems und die Zahl der Konten.

Aktionen aus der Oberfläche tragen zusätzlich `duration_ms`, die Dauer des Aufrufs.

### App

| Ereignis | Wann | Eigenschaften |
| --- | --- | --- |
| `app_started` | Start | `launch_ms`, `first_launch`, `updated_from`, `notifications` |
| `app_updated` | erster Start nach einem Update | `from_version` |
| `app_focused` | ein Fenster der App bekommt den Fokus, höchstens alle 30 Minuten | `route` |
| `$screen` | Ansicht gewechselt | `$screen_name`: `welcome`, `chat`, `teams`, `activity`, `calendar`, `calls`, `settings` |
| `keyboard_shortcut` | Tastenkürzel im Hauptfenster | `shortcut` |
| `setting_changed` | Einstellung geändert | `setting`, `value` |
| `feedback_sent` | Feedback abgeschickt | `kind`, `message`, `message_length` |

### Konten und Verbindung

| Ereignis | Wann | Eigenschaften |
| --- | --- | --- |
| `account_add_started`, `account_removed`, `account_switched` | Konto hinzugefügt, entfernt, gewechselt | |
| `sign_in_required` | neues Konto muss sich anmelden | |
| `sign_in_expired` | Anmeldung eines bekannten Kontos ist abgelaufen | |
| `account_connected` | Konto ist verbunden | `seconds`, `after` (`start`, `sign_in`, `reconnect`), `first_sign_in`, `complete` (Teams und Kanäle verfügbar) |
| `account_connect_slow` | Konto ist nach 2 Minuten noch nicht verbunden | `status`, `seconds` |
| `web_app_load_failed` | Teams-Web-App lädt nicht | `code`, `error` |
| `web_app_crashed` | Teams-Web-App abgestürzt | `reason`, `exit_code` |
| `sync_failed` | Synchronisierung gescheitert, höchstens alle 30 Minuten | `kind`, `status`, `error` |
| `sign_in_window_opened`, `web_view_opened`, `account_reconnect_clicked`, `connection_details_opened` | Knöpfe in Einstellungen und Menü | |

### Chats und Kanäle

| Ereignis | Wann | Eigenschaften |
| --- | --- | --- |
| `conversation_opened` | Chat oder Kanal geöffnet | `kind` (`oneOnOne`, `group`, `meeting`, `channel` …), `view` |
| `new_chat_opened`, `chat_created` | neuer Chat | `members`, `has_topic` |
| `message_sent` | Nachricht gesendet | `conversation_kind`, `is_thread_reply`, `has_subject`, `importance`, `has_images`, `has_quote`, `has_code`, `has_list`, `has_link` |
| `message_edited`, `message_deleted` | Nachricht bearbeitet oder gelöscht | `conversation_kind` |
| `reaction_added`, `reaction_removed` | Reaktion | `reaction` (z. B. `like`, `heart`), `conversation_kind` |
| `people_searched` | Personensuche, höchstens einmal pro Minute | |
| `presence_changed` | eigener Status gesetzt | `availability` |
| `chat_section_changed` | Favoriten und Abschnitte | `action` |
| `image_action` | Bild kopiert oder gespeichert | `action` |
| `activity_marked_read`, `chat_opened_from_call` | | |

### Anrufe und Besprechungen

| Ereignis | Wann | Eigenschaften |
| --- | --- | --- |
| `call_start_clicked` | Anruf gestartet | `video`, `target` (`chat` oder `people`), `people` |
| `meeting_join_clicked` | Besprechung beigetreten | |
| `meeting_opened_in_browser` | Zoom- oder Webex-Link | |
| `call_connected` | Anruf verbunden | `origin` (`call`, `meeting`, `incoming`, `web_view`), `seconds_to_connect`, `waited_in_lobby`, `camera_on`, `participants` |
| `call_ended` | Anruf beendet | `origin`, `duration_s`, `max_participants`, `shared_screen`, `camera_used` |
| `call_start_failed` | Start gescheitert | `origin`, `reason` (`timeout`, `web_app`), `seconds` |
| `call_start_cancelled` | Start abgebrochen | `origin`, `seconds` |
| `call_not_joined` | Vorschau oder Wartebereich verlassen, ohne beizutreten | `origin`, `last_phase`, `seconds` |
| `call_action` | Knopf im Anruf | `action`, `reaction` |
| `incoming_call_received`, `incoming_call_missed` | eingehender Anruf | `video` |
| `incoming_call_answered` | angenommen oder abgelehnt | `mode` |
| `screen_share_source_picked` | Freigabe gewählt | `kind` (`screen`, `window`, `cancelled`) |
| `screen_share_failed` | Bildschirmquellen nicht lesbar, meist fehlende Berechtigung | `reason` |
| `call_background_changed`, `call_background_uploaded`, `call_device_changed` | Hintergrund und Geräte | `kind` |
| `call_video_popped_out`, `call_compact_view`, `call_opened_in_web_view`, `call_window_close_prompt` | Fenster des Anrufs | `on`, `choice` |

### MCP-Server für Claude Code und Codex

| Ereignis | Wann | Eigenschaften |
| --- | --- | --- |
| `mcp_toggled` | Server ein- oder ausgeschaltet | `on` |
| `mcp_install_clicked` | Eintrag für Claude Code oder Codex angelegt | `client`, `ok` |
| `mcp_token_reset` | neuer Schlüssel | |
| `mcp_tool_called` | ein Agent ruft ein Werkzeug auf, je Werkzeug höchstens alle 10 Minuten | `tool` (nur der Name, nie Argumente oder Ergebnisse) |

### Mitteilungen und Updates

| Ereignis | Wann | Eigenschaften |
| --- | --- | --- |
| `notification_clicked` | Mitteilung angeklickt | `kind` |
| `notification_failed` | macOS lehnt Mitteilungen ab | `error` |
| `notification_tested` | Testmitteilung | `ok`, `error` |
| `update_available`, `update_download_started`, `update_downloaded`, `update_install_started` | Ablauf eines Updates | `available_version` |
| `update_failed` | Update gescheitert | `step` (`check`, `download`, `install`), `error` |
| `update_check_clicked`, `update_download_clicked`, `update_install_clicked` | Knöpfe | |

### Fehler

| Ereignis | Wann | Eigenschaften |
| --- | --- | --- |
| `$exception` | Fehler im Hauptprozess, in der Oberfläche, bei einer Aktion oder in einem MCP-Werkzeug | `error_source` (`main`, `renderer`, `ipc`, `mcp`), `handled`, `mechanism`, `route`, `method`, `tool` |
| `api_call_failed` | Aufruf aus der Oberfläche gescheitert, je Methode und Status höchstens alle 10 Minuten | `method`, `status`, `error_type`, `error` |
| `ui_crashed` | Fenster der App abgestürzt | `reason`, `exit_code`, `route` |
| `child_process_crashed` | GPU- oder anderer Hilfsprozess abgestürzt | `type`, `reason`, `exit_code`, `service` |

Derselbe Fehler geht höchstens einmal pro Minute raus. Bei einem unbehandelten Fehler im Hauptprozess zeigt Electron wie bisher einen Fehlerdialog. Der Dialog hält die App an, der Bericht geht erst nach dem Schließen raus.

Fehler aus der Teams-Web-App selbst erfasst die App nicht, nur ob sie lädt oder abstürzt.

## Einrichten

Für Maintainer. Das Skript [scripts/posthog-setup.mjs](../scripts/posthog-setup.mjs) richtet das PostHog-Projekt ein und lässt sich beliebig oft ausführen:

```sh
POSTHOG_PERSONAL_API_KEY=phx_… node scripts/posthog-setup.mjs
```

Den persönlichen API-Schlüssel legst du in PostHog unter Einstellungen › Persönliche API-Schlüssel an. Das Skript braucht Lese- und Schreibrechte für Projekte, Dashboards, Insights, Abfragen und Warnungen. Es

- nimmt das Projekt „Teams Everywhere“, sonst das leere „Default project“ einer neuen Organisation (und benennt es um), sonst legt es eins an (`POSTHOG_PROJECT_ID` wählt ein anderes),
- schaltet das Speichern von IP-Adressen, Sitzungsaufzeichnungen und Autocapture aus und zählt Tage in deutscher Zeit,
- filtert Dev-Builds (`app_channel = dev`, auch PR-Builds) als Testkonten aus allen Auswertungen, vorhandene Testkonten-Filter bleiben,
- legt die Dashboards „Teams Everywhere – Nutzung“ und „Teams Everywhere – Probleme und Fehler“ an,
- schickt dir eine Mail, wenn mehr als 20 Fehler pro Stunde auftreten (`POSTHOG_ALERT_THRESHOLD`),
- gibt Projektschlüssel und Host für den Build aus.

Danach die beiden Repository-Variablen setzen. Der nächste Release-Build sendet dann:

```sh
gh variable set POSTHOG_KEY --body phc_…
gh variable set POSTHOG_HOST --body https://eu.i.posthog.com
```

Lokal testen geht mit `POSTHOG_KEY=phc_… pnpm run dev`. Dev-Builds tragen den Kanal `dev` und erscheinen in den Dashboards nicht.

Neue Ereignisse kommen nach [src/main/usage-events.ts](../src/main/usage-events.ts) (Aktionen aus der Oberfläche), [src/main/usage.ts](../src/main/usage.ts) (Konten, Fehler) oder direkt als `analytics.track(…)` an die Stelle, an der etwas passiert. Jedes neue Ereignis gehört in die Tabellen oben. Eigenschaften enthalten nie Inhalte, Namen oder IDs.
