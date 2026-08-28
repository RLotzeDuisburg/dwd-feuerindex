/*!
 * DWD Feuerindex-Widget (Graslandfeuerindex + Waldbrandgefahrenindex)
 * Datenquelle: Deutscher Wetterdienst (DWD), CC BY 4.0
 * https://opendata.dwd.de/climate_environment/CDC/derived_germany/fire_danger_index/
 *
 * Einbindung:
 *   <script src=".../widget.js"
 *           data-base-url="https://raw.githubusercontent.com/<user>/<repo>/main/data"
 *           data-station="Duisburg-Baerl"        <!-- optional: auf eine Station fixieren -->
 *           data-index="both"                     <!-- "both" | "glfi" | "wbi" -->
 *           data-view="auto"                       <!-- "auto" | "map" | "list" -->
 *   ></script>
 *
 * Rendert ein reines HTML-Fragment mit scoped CSS (Präfix "dwdfi-"), ohne
 * globale Variablen oder externe Abhängigkeiten. Sicher für CMS-Einbettung.
 */
(function () {
  "use strict";

  if (window.__dwdFeuerindexWidgetLoaded) return;
  window.__dwdFeuerindexWidgetLoaded = true;

  var CURRENT_SCRIPT = document.currentScript;

  var LEVEL_COLORS = {
    1: "#3f9142",
    2: "#8bc34a",
    3: "#f5c518",
    4: "#f28c28",
    5: "#d9362f",
  };
  var LEVEL_LABELS = {
    1: "sehr geringe Gefahr",
    2: "geringe Gefahr",
    3: "mittlere Gefahr",
    4: "hohe Gefahr",
    5: "sehr hohe Gefahr",
  };
  var PARAM_LABELS = { glfi: "Graslandfeuerindex", wbi: "Waldbrandgefahrenindex" };

  // Grobe Bounding Box für Deutschland (WGS84), reicht für eine einfache
  // Punktprojektion ohne Kartenmaterial.
  var BBOX = { latMin: 47.2, latMax: 55.1, lonMin: 5.6, lonMax: 15.2 };

  function injectStyles() {
    if (document.getElementById("dwdfi-styles")) return;
    var css =
      ".dwdfi-root{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" +
      "font-size:14px;line-height:1.4;color:#1a1a1a;max-width:100%;box-sizing:border-box;}" +
      ".dwdfi-root *{box-sizing:border-box;}" +
      ".dwdfi-card{border:1px solid #ddd;border-radius:8px;padding:14px 16px;background:#fff;}" +
      ".dwdfi-card h3{margin:0 0 4px;font-size:16px;}" +
      ".dwdfi-sub{color:#666;font-size:12px;margin-bottom:10px;}" +
      ".dwdfi-badges{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px;}" +
      ".dwdfi-badge{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:6px;background:#f5f5f5;}" +
      ".dwdfi-dot{width:14px;height:14px;border-radius:50%;flex:none;}" +
      ".dwdfi-badge-label{font-size:11px;color:#666;}" +
      ".dwdfi-badge-value{font-weight:600;}" +
      ".dwdfi-forecast{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;}" +
      ".dwdfi-fday{flex:1 1 auto;min-width:44px;text-align:center;border-radius:6px;padding:4px 2px;color:#fff;font-size:11px;}" +
      ".dwdfi-fday b{display:block;font-size:13px;}" +
      ".dwdfi-toolbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px;flex-wrap:wrap;}" +
      ".dwdfi-toggle{display:flex;gap:4px;}" +
      ".dwdfi-toggle button{border:1px solid #ccc;background:#fff;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;}" +
      ".dwdfi-toggle button[aria-pressed=true]{background:#1a1a1a;color:#fff;border-color:#1a1a1a;}" +
      ".dwdfi-search{border:1px solid #ccc;border-radius:6px;padding:4px 8px;font-size:12px;min-width:160px;}" +
      ".dwdfi-map{width:100%;height:auto;border:1px solid #eee;border-radius:8px;background:#fafafa;}" +
      ".dwdfi-map circle{cursor:pointer;stroke:#fff;stroke-width:0.6;}" +
      ".dwdfi-map circle:hover{stroke:#1a1a1a;stroke-width:1.2;}" +
      ".dwdfi-list{max-height:360px;overflow:auto;border:1px solid #eee;border-radius:8px;}" +
      ".dwdfi-list table{width:100%;border-collapse:collapse;font-size:13px;}" +
      ".dwdfi-list th{position:sticky;top:0;background:#fafafa;text-align:left;padding:6px 8px;border-bottom:1px solid #eee;}" +
      ".dwdfi-list td{padding:5px 8px;border-bottom:1px solid #f2f2f2;cursor:pointer;}" +
      ".dwdfi-list tr:hover td{background:#f7f7f7;}" +
      ".dwdfi-pill{display:inline-block;min-width:18px;text-align:center;color:#fff;border-radius:4px;padding:1px 6px;font-weight:600;font-size:12px;}" +
      ".dwdfi-legend{display:flex;gap:10px;flex-wrap:wrap;margin-top:10px;font-size:11px;color:#555;}" +
      ".dwdfi-legend span{display:inline-flex;align-items:center;gap:4px;}" +
      ".dwdfi-legend i{width:10px;height:10px;border-radius:50%;display:inline-block;}" +
      ".dwdfi-attribution{margin-top:10px;font-size:11px;color:#888;}" +
      ".dwdfi-attribution a{color:#888;}" +
      ".dwdfi-error{color:#a33;font-size:13px;}" +
      ".dwdfi-detail-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px;}" +
      ".dwdfi-detail-box{background:#fff;border-radius:10px;padding:16px 18px;max-width:420px;width:100%;max-height:80vh;overflow:auto;}" +
      ".dwdfi-detail-close{float:right;border:none;background:none;font-size:18px;cursor:pointer;color:#888;}";
    var style = document.createElement("style");
    style.id = "dwdfi-styles";
    style.textContent = css;
    document.head.appendChild(style);
  }

  function levelDot(level) {
    var span = document.createElement("span");
    span.className = "dwdfi-dot";
    span.style.background = LEVEL_COLORS[level] || "#bbb";
    return span;
  }

  function pill(level) {
    var el = document.createElement("span");
    el.className = "dwdfi-pill";
    el.style.background = LEVEL_COLORS[level] || "#bbb";
    el.textContent = level == null ? "–" : level;
    el.title = level != null ? LEVEL_LABELS[level] || "" : "keine Daten";
    return el;
  }

  function fmtDate(iso) {
    try {
      var d = new Date(iso + "T00:00:00");
      return d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });
    } catch (e) {
      return iso;
    }
  }

  function project(lat, lon, width, height) {
    var x = ((lon - BBOX.lonMin) / (BBOX.lonMax - BBOX.lonMin)) * width;
    var y = (1 - (lat - BBOX.latMin) / (BBOX.latMax - BBOX.latMin)) * height;
    return [x, y];
  }

  function findStation(stations, query) {
    if (!query) return null;
    var q = String(query).trim();
    var qLower = q.toLowerCase();
    var byId = stations.find(function (s) { return String(s.id) === q; });
    if (byId) return byId;
    var exact = stations.find(function (s) { return s.name.toLowerCase() === qLower; });
    if (exact) return exact;
    var partial = stations.filter(function (s) { return s.name.toLowerCase().indexOf(qLower) !== -1; });
    return partial.length ? partial[0] : null;
  }

  function attribution() {
    var p = document.createElement("div");
    p.className = "dwdfi-attribution";
    p.innerHTML =
      'Daten: <a href="https://opendata.dwd.de/climate_environment/CDC/derived_germany/fire_danger_index/" target="_blank" rel="noopener">Deutscher Wetterdienst (DWD)</a>, ' +
      'Lizenz <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>';
    return p;
  }

  function legendRow(indexKeys) {
    var row = document.createElement("div");
    row.className = "dwdfi-legend";
    [1, 2, 3, 4, 5].forEach(function (lvl) {
      var span = document.createElement("span");
      var i = document.createElement("i");
      i.style.background = LEVEL_COLORS[lvl];
      span.appendChild(i);
      span.appendChild(document.createTextNode(lvl + " = " + LEVEL_LABELS[lvl]));
      row.appendChild(span);
    });
    return row;
  }

  function renderStationCard(container, station, indexKeys, combinedStation) {
    container.innerHTML = "";
    var card = document.createElement("div");
    card.className = "dwdfi-card";

    var h3 = document.createElement("h3");
    h3.textContent = station.name;
    card.appendChild(h3);

    var sub = document.createElement("div");
    sub.className = "dwdfi-sub";
    sub.textContent = station.bundesland;
    card.appendChild(sub);

    var badges = document.createElement("div");
    badges.className = "dwdfi-badges";
    indexKeys.forEach(function (key) {
      var val = station.today ? station.today[key] : null;
      var badge = document.createElement("div");
      badge.className = "dwdfi-badge";
      badge.appendChild(levelDot(val));
      var textWrap = document.createElement("div");
      var lab = document.createElement("div");
      lab.className = "dwdfi-badge-label";
      lab.textContent = PARAM_LABELS[key] || key;
      var value = document.createElement("div");
      value.className = "dwdfi-badge-value";
      value.textContent = val == null ? "keine Daten" : val + " – " + (LEVEL_LABELS[val] || "");
      textWrap.appendChild(lab);
      textWrap.appendChild(value);
      badge.appendChild(textWrap);
      badges.appendChild(badge);
    });
    card.appendChild(badges);

    if (combinedStation) {
      indexKeys.forEach(function (key) {
        var series = combinedStation.indices && combinedStation.indices[key];
        if (!series) return;
        var dates = Object.keys(series).sort();
        if (!dates.length) return;
        var label = document.createElement("div");
        label.className = "dwdfi-sub";
        label.style.marginTop = "6px";
        label.textContent = PARAM_LABELS[key] + " – Vorhersage";
        card.appendChild(label);
        var strip = document.createElement("div");
        strip.className = "dwdfi-forecast";
        dates.forEach(function (d) {
          var day = document.createElement("div");
          day.className = "dwdfi-fday";
          day.style.background = LEVEL_COLORS[series[d]] || "#bbb";
          var b = document.createElement("b");
          b.textContent = series[d];
          day.appendChild(document.createTextNode(fmtDate(d)));
          day.appendChild(b);
          strip.appendChild(day);
        });
        card.appendChild(strip);
      });
    }

    card.appendChild(attribution());
    container.appendChild(card);
  }

  function openDetailOverlay(station, indexKeys, combinedStation) {
    var overlay = document.createElement("div");
    overlay.className = "dwdfi-detail-overlay";
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) document.body.removeChild(overlay);
    });
    var box = document.createElement("div");
    box.className = "dwdfi-detail-box";
    var closeBtn = document.createElement("button");
    closeBtn.className = "dwdfi-detail-close";
    closeBtn.setAttribute("aria-label", "Schließen");
    closeBtn.textContent = "\u00D7";
    closeBtn.addEventListener("click", function () { document.body.removeChild(overlay); });
    box.appendChild(closeBtn);
    var inner = document.createElement("div");
    box.appendChild(inner);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    renderStationCard(inner, station, indexKeys, combinedStation);
  }

  function renderMap(container, stations, indexKeys, primaryKey, onSelect) {
    var width = 420, height = 520;
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.setAttribute("class", "dwdfi-map");
    stations.forEach(function (s) {
      var val = s.today ? s.today[primaryKey] : null;
      if (val == null) return;
      var pos = project(s.lat, s.lon, width, height);
      var c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("cx", pos[0].toFixed(1));
      c.setAttribute("cy", pos[1].toFixed(1));
      c.setAttribute("r", 4);
      c.setAttribute("fill", LEVEL_COLORS[val] || "#bbb");
      var title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = s.name + " (" + s.bundesland + "): " + val + " – " + (LEVEL_LABELS[val] || "");
      c.appendChild(title);
      c.addEventListener("click", function () { onSelect(s); });
      svg.appendChild(c);
    });
    container.innerHTML = "";
    container.appendChild(svg);
  }

  function renderList(container, stations, indexKeys, onSelect) {
    var wrap = document.createElement("div");
    wrap.className = "dwdfi-list";
    var table = document.createElement("table");
    var thead = document.createElement("thead");
    var headRow = document.createElement("tr");
    ["Station", "Bundesland"].concat(indexKeys.map(function (k) { return PARAM_LABELS[k] || k; }))
      .forEach(function (t) {
        var th = document.createElement("th");
        th.textContent = t;
        headRow.appendChild(th);
      });
    thead.appendChild(headRow);
    table.appendChild(thead);
    var tbody = document.createElement("tbody");
    stations
      .slice()
      .sort(function (a, b) { return a.bundesland.localeCompare(b.bundesland) || a.name.localeCompare(b.name); })
      .forEach(function (s) {
        var tr = document.createElement("tr");
        var tdName = document.createElement("td");
        tdName.textContent = s.name;
        var tdLand = document.createElement("td");
        tdLand.textContent = s.bundesland;
        tr.appendChild(tdName);
        tr.appendChild(tdLand);
        indexKeys.forEach(function (key) {
          var td = document.createElement("td");
          td.appendChild(pill(s.today ? s.today[key] : null));
          tr.appendChild(td);
        });
        tr.addEventListener("click", function () { onSelect(s); });
        tbody.appendChild(tr);
      });
    table.appendChild(tbody);
    wrap.appendChild(table);
    container.innerHTML = "";
    container.appendChild(wrap);
  }

  function renderOverview(container, latestData, opts) {
    container.innerHTML = "";
    var root = document.createElement("div");
    root.className = "dwdfi-root";

    var toolbar = document.createElement("div");
    toolbar.className = "dwdfi-toolbar";
    var toggle = document.createElement("div");
    toggle.className = "dwdfi-toggle";
    var btnMap = document.createElement("button");
    btnMap.textContent = "Karte";
    var btnList = document.createElement("button");
    btnList.textContent = "Liste";
    toggle.appendChild(btnMap);
    toggle.appendChild(btnList);
    var search = document.createElement("input");
    search.type = "search";
    search.placeholder = "Station suchen…";
    search.className = "dwdfi-search";
    toolbar.appendChild(toggle);
    toolbar.appendChild(search);
    root.appendChild(toolbar);

    var body = document.createElement("div");
    root.appendChild(body);
    root.appendChild(legendRow(opts.indexKeys));
    root.appendChild(attribution());
    container.appendChild(root);

    var view = opts.view === "list" ? "list" : "map";

    function combinedFor(station) {
      if (!opts.combinedPromise) return Promise.resolve(null);
      return opts.combinedPromise.then(function (combined) {
        return combined.stations.find(function (s) { return s.id === station.id; }) || null;
      });
    }

    function select(station) {
      combinedFor(station).then(function (c) {
        openDetailOverlay(station, opts.indexKeys, c);
      });
    }

    function draw() {
      var filter = search.value.trim().toLowerCase();
      var filtered = filter
        ? latestData.stations.filter(function (s) { return s.name.toLowerCase().indexOf(filter) !== -1; })
        : latestData.stations;
      btnMap.setAttribute("aria-pressed", view === "map");
      btnList.setAttribute("aria-pressed", view === "list");
      if (view === "map") {
        renderMap(body, filtered, opts.indexKeys, opts.indexKeys[0], select);
      } else {
        renderList(body, filtered, opts.indexKeys, select);
      }
    }

    btnMap.addEventListener("click", function () { view = "map"; draw(); });
    btnList.addEventListener("click", function () { view = "list"; draw(); });
    search.addEventListener("input", draw);
    draw();
  }

  function renderSingle(container, latestData, station, opts) {
    container.innerHTML = "";
    var root = document.createElement("div");
    root.className = "dwdfi-root";
    container.appendChild(root);
    if (opts.combinedPromise) {
      opts.combinedPromise.then(function (combined) {
        var c = combined.stations.find(function (s) { return s.id === station.id; }) || null;
        renderStationCard(root, station, opts.indexKeys, c);
      });
    } else {
      renderStationCard(root, station, opts.indexKeys, null);
    }
  }

  function renderError(container, message) {
    container.innerHTML = "";
    var div = document.createElement("div");
    div.className = "dwdfi-root dwdfi-error";
    div.textContent = message;
    container.appendChild(div);
  }

  function init(scriptEl) {
    injectStyles();
    var ds = scriptEl.dataset || {};
    var baseUrl = (ds.baseUrl || "").replace(/\/+$/, "");
    if (!baseUrl) {
      var mount = document.createElement("div");
      scriptEl.parentNode.insertBefore(mount, scriptEl.nextSibling);
      renderError(mount, "DWD-Feuerindex-Widget: data-base-url fehlt am <script>-Tag.");
      return;
    }
    var indexOpt = ds.index === "glfi" || ds.index === "wbi" ? ds.index : "both";
    var indexKeys = indexOpt === "both" ? ["glfi", "wbi"] : [indexOpt];
    var view = ds.view === "map" || ds.view === "list" ? ds.view : "auto";
    var stationQuery = ds.station || null;

    var mount = document.createElement("div");
    scriptEl.parentNode.insertBefore(mount, scriptEl.nextSibling);
    mount.textContent = "Lade Feuerindex-Daten…";

    var latestPromise = fetch(baseUrl + "/latest.json").then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
    var combinedPromise = fetch(baseUrl + "/combined.json")
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });

    latestPromise
      .then(function (latestData) {
        var opts = { indexKeys: indexKeys, view: view, combinedPromise: combinedPromise };
        if (stationQuery) {
          var station = findStation(latestData.stations, stationQuery);
          if (!station) {
            renderError(mount, 'DWD-Feuerindex-Widget: Station "' + stationQuery + '" nicht gefunden.');
            return;
          }
          renderSingle(mount, latestData, station, opts);
        } else {
          renderOverview(mount, latestData, opts);
        }
      })
      .catch(function (err) {
        renderError(mount, "DWD-Feuerindex-Widget: Daten konnten nicht geladen werden (" + err.message + ").");
      });
  }

  if (CURRENT_SCRIPT) {
    init(CURRENT_SCRIPT);
  }
})();
