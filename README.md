# dwd-feuerindex

Graslandfeuerindex (GLFI) und Waldbrandgefahrenindex (WBI) für alle deutschen
DWD-Stationen, automatisch aktualisiert und als eingebettetes Widget für
Webseiten nutzbar.

## Datenquelle

Die Daten stammen direkt vom offiziellen **DWD OpenData-Server**:

- <https://opendata.dwd.de/climate_environment/CDC/derived_germany/fire_danger_index/grassland/forecast/recent/>
- <https://opendata.dwd.de/climate_environment/CDC/derived_germany/fire_danger_index/woodland/forecast/recent/>

Jede Station liegt dort als eigene `.csv.gz`-Datei mit einer 7-Tage-Vorhersage
vor (heute + 6 Folgetage), dazu eine Stationsliste mit Namen, Koordinaten und
Bundesland. Lizenz der Daten: **CC BY 4.0** (Namensnennung DWD erforderlich –
das Widget zeigt die Attribution automatisch an).

Das Update-Skript liest die Verzeichnis-Listings live aus und lädt für jede
gefundene Station die aktuelle Datei – es sind also keine Stations-IDs oder
Dateiversionen fest im Code hinterlegt.

## Repo-Struktur

```
scripts/update_indices.py   Lädt & verarbeitet die DWD-Daten
scripts/requirements.txt    Python-Abhängigkeiten (nur "requests")
.github/workflows/update.yml GitHub-Actions-Workflow (2x täglich, committet Änderungen)
data/combined.json           Alle Stationen, alle Indizes, 7-Tage-Vorhersage
data/latest.json             Kompakt: nur heutiger Wert je Station (fürs schnelle Kartenrendering)
widget/widget.js             Einbettbares Vanilla-JS-Widget (keine Abhängigkeiten)
widget/widget.css            (Styles sind inline im Widget, Datei nur als Referenz/Fallback)
widget/index.html            Demo-/Testseite
```

## Einrichtung

1. **Repo pushen** (siehe unten, `git remote add` + `git push`).
2. In den Repo-Settings unter *Actions → General* sicherstellen, dass
   „Workflow permissions" auf **Read and write** steht, damit der
   Update-Workflow committen darf.
3. Einmal manuell anstoßen: Tab *Actions* → *Update fire danger index data* →
   *Run workflow*. Danach läuft er automatisch 2x täglich (ca. 05:20 und
   14:20 UTC).
4. Nach dem ersten erfolgreichen Lauf liegen `data/combined.json` und
   `data/latest.json` im Repo und sind über
   `https://raw.githubusercontent.com/<user>/<repo>/main/data/latest.json`
   erreichbar (funktioniert ohne GitHub Pages, `raw.githubusercontent.com`
   setzt passende CORS-Header).

### Wichtig für den GitHub-Token

Für den Update-Workflow wird **kein** eigener Personal Access Token benötigt –
GitHub Actions bringt mit `permissions: contents: write` automatisch ein
`GITHUB_TOKEN` mit, das fürs Committen reicht. Einen fein-granularen PAT
brauchst du nur, falls du das Repo selbst per API/CLI anlegen willst
(`gh repo create`).

## Widget einbinden

```html
<script src="https://raw.githubusercontent.com/<user>/<repo>/main/widget/widget.js"
        data-base-url="https://raw.githubusercontent.com/<user>/<repo>/main/data"
        data-index="both"
        data-view="auto"></script>
```

Optionen (als `data-*`-Attribute am `<script>`-Tag):

| Attribut | Werte | Beschreibung |
|---|---|---|
| `data-base-url` | URL | **Pflicht.** Ordner mit `latest.json`/`combined.json` |
| `data-station` | Stationsname oder ID | Fixiert das Widget auf eine Station (z.B. `"Duisburg-Baerl"`), zeigt nur eine Detailkarte statt Karte/Liste |
| `data-index` | `both` \| `glfi` \| `wbi` | Welche Indizes angezeigt werden |
| `data-view` | `auto` \| `map` \| `list` | Startansicht in der Gesamtübersicht |

Das Widget rendert ein reines HTML-Fragment mit scoped CSS (Präfix `dwdfi-`)
und ohne externe Abhängigkeiten – analog zum bestehenden GLFI-Widget für
Duisburg, nur jetzt bundesweit und für beide Indizes.

## Lokal testen

```bash
cd scripts
pip install -r requirements.txt
python update_indices.py
```

Erzeugt `data/combined.json` und `data/latest.json`. Für die Demo-Seite
`widget/index.html` lokal öffnen (Base-URL im HTML anpassen oder einen
lokalen Server mit `python -m http.server` im Repo-Root starten und die
`data-base-url` auf `http://localhost:8000/data` zeigen lassen).

## Bekannte Einschränkungen / To-dos

- Die Karte im Widget ist eine einfache Punkt-Projektion (lineare
  Lat/Lon-Umrechnung auf die Bounding Box von Deutschland), **kein**
  Kartenmaterial oder Ländergrenzen-Overlay. Für eine schönere Karte könnte
  man z.B. eine simple SVG-Umrisslinie Deutschlands ergänzen.
  - Ich konnte das Repo nicht selbst live gegen den DWD-Server testen (mein
      Sandbox-Netzwerk hat keinen Zugriff auf opendata.dwd.de) – die
      Verzeichnisstruktur und das CSV-Format habe ich aber direkt gegen die
      echten DWD-Seiten verifiziert. Nach dem ersten Actions-Lauf lohnt sich
      ein Blick in die Logs, falls einzelne Stationen fehlschlagen.
