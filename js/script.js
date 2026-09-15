/* TransitFlow — client-side GTFS visualizer.
 * Data model: `schedules` items get numeric `startSec`/`endSec` precomputed
 * once at load so the per-frame loop (updateBuses, ~60fps while playing)
 * never parses time strings. Bus position = linear interpolation along the
 * shape polyline by *vertex index* (assumes roughly constant speed and
 * even vertex spacing — fine for visualization, not for ETA guarantees).
 */
"use strict";

const MAP_CENTER = [44.319603, 23.801761];
const MAP_ZOOM = 14;
const DAY_SECONDS = 86400;
const SEARCH_NEAR_METERS = 150;

let map;
let routeLayer;
let searchTargetMarker = null;
let shapesData = null;
let schedules = [];
let colorData = {};
let stopsData = null;
let focusedBusId = null;
let lastFocusedBusId = null;
let shapesLookup = new Map();

const activeMarkers = new Map(); // trip_id -> L.Marker
const markerPool = [];
const iconCache = new Map(); // route_short_name.lower -> L.Icon

const slider = document.getElementById("time-slider");
const timeInput = document.getElementById("time-input");
const playPauseBtn = document.getElementById("play-pause-btn");
const speedSelector = document.getElementById("speed-selector");
const clearBtn = document.getElementById("clear-btn");
const searchToggle = document.getElementById("search-toggle");
const searchContent = document.getElementById("search-content");
const searchChevron = document.getElementById("search-chevron");
const stopSearchInput = document.getElementById("stop-search-input");
const searchTimeInput = document.getElementById("search-time-input");
const searchWindowInput = document.getElementById("search-window");
const searchResults = document.getElementById("search-results");
const searchFindBtn = document.getElementById("search-find-btn");
const loadingError = document.getElementById("loading-error");

const stopIcon = L.icon({
  iconUrl: "assets/icons/bus-stop.png",
  iconSize: [18, 18],
  iconAnchor: [9, 9],
  popupAnchor: [0, -10],
});

// ---------- helpers ----------

function pad2(n) {
  return String(n).padStart(2, "0");
}

function secondsToTime(totalSeconds) {
  const s = ((Math.floor(totalSeconds) % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(sec)}`;
}

/** Accepts "HH:MM" or "HH:MM:SS" (what <input type=time> emits). Returns NaN on garbage. */
function timeToSeconds(str) {
  if (typeof str !== "string") return NaN;
  const parts = str.trim().split(":").map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n))) return NaN;
  const [h, m, s = 0] = parts;
  if (h < 0 || h > 23 || m < 0 || m > 59 || s < 0 || s > 59) return NaN;
  return h * 3600 + m * 60 + s;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

function routeIcon(routeShortName) {
  const key = String(routeShortName).toLowerCase();
  let icon = iconCache.get(key);
  if (!icon) {
    icon = L.icon({
      iconUrl: `assets/icons/route_icon_${key}.png`,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
      className: "route-icon-marker",
    });
    iconCache.set(key, icon);
  }
  return icon;
}

// ---------- map ----------

function initMap() {
  map = L.map("map").setView(MAP_CENTER, MAP_ZOOM);
  map.createPane("routePane").style.zIndex = 400;
  map.createPane("stopPane").style.zIndex = 500;
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap",
  }).addTo(map);
  map.on("click", () => {
    focusedBusId = null;
    if (searchTargetMarker) {
      map.removeLayer(searchTargetMarker);
      searchTargetMarker = null;
    }
    updateBuses();
  });
}

async function loadData() {
  try {
    const [colors, shapes, trips, stops] = await Promise.all([
      fetch("data/route_colors.json").then((r) => r.json()),
      fetch("data/gtfs_shapes.geojson").then((r) => r.json()),
      fetch("data/bus_schedules.json").then((r) => r.json()),
      fetch("data/gtfs_stops.geojson").then((r) => r.json()),
    ]);
    colorData = colors;
    shapesData = shapes;
    stopsData = stops;

    shapesLookup = new Map(
      shapesData.features.map((f) => [f.properties.shape_id, f.geometry.coordinates])
    );

    // Precompute numeric times once — updateBuses must not parse strings per frame.
    schedules = trips.map((t) => ({
      ...t,
      startSec: timeToSeconds(t.start_time),
      endSec: timeToSeconds(t.end_time),
    }));

    renderStaticLayers();
    setToCurrentTime();
    updateBuses();
    autoPlay.start();
  } catch (err) {
    console.error("Error loading resources:", err);
    if (loadingError) {
      loadingError.textContent = "Error loading transit data. Check your connection and reload.";
      loadingError.hidden = false;
    }
  }
}

function renderStaticLayers() {
  routeLayer = L.geoJSON(shapesData, {
    pane: "routePane",
    style: (feature) => ({
      color: colorData[feature.properties.shape_id]?.color || "#3388ff",
      weight: 8,
      opacity: 0.8,
    }),
    onEachFeature: (feature, layer) => {
      const name = colorData[feature.properties.shape_id]?.route_name || "Unknown";
      layer.bindPopup(
        `<strong>Route: ${escapeHtml(name)}</strong><br>ID: ${escapeHtml(feature.properties.shape_id)}`
      );
    },
  }).addTo(map);

  L.geoJSON(stopsData, {
    pane: "stopPane",
    pointToLayer: (_feature, latlng) => L.marker(latlng, { icon: stopIcon }),
    onEachFeature: (feature, layer) => {
      layer.bindPopup(
        `<strong>Stop:</strong> ${escapeHtml(feature.properties.stop_name)}<br>ID: ${escapeHtml(feature.properties.stop_id)}`
      );
    },
  }).addTo(map);
}

// ---------- buses ----------

let lastProcessedSecond = -1;

function updateBuses() {
  if (!schedules.length || !shapesData || !routeLayer) return;
  const nowSec = parseFloat(slider.value);
  const floored = Math.floor(nowSec);
  if (floored !== lastProcessedSecond) {
    timeInput.value = secondsToTime(floored);
    lastProcessedSecond = floored;
  }

  if (focusedBusId !== lastFocusedBusId) {
    let focusShapeId = null;
    if (focusedBusId) {
      const trip = schedules.find((t) => t.trip_id === focusedBusId);
      if (trip) focusShapeId = trip.shape_id;
    }
    routeLayer.setStyle((feature) => {
      const active = !focusShapeId || feature.properties.shape_id === focusShapeId;
      return { opacity: active ? 0.8 : 0.1, weight: active ? 8 : 3, interactive: active };
    });
    lastFocusedBusId = focusedBusId;
  }

  for (const trip of schedules) {
    if (focusedBusId !== null && focusedBusId !== trip.trip_id) {
      recycleMarker(trip.trip_id);
      continue;
    }
    if (nowSec >= trip.startSec && nowSec <= trip.endSec) {
      const coords = shapesLookup.get(trip.shape_id);
      if (!coords) continue;
      const span = trip.endSec - trip.startSec;
      const frac = span > 0 ? (nowSec - trip.startSec) / span : 0;
      const pos = frac * (coords.length - 1);
      const i = Math.floor(pos);
      const j = Math.min(i + 1, coords.length - 1);
      const p = pos - i;
      const a = coords[i];
      const b = coords[j];
      const latLng = [a[1] + (b[1] - a[1]) * p, a[0] + (b[0] - a[0]) * p];

      const existing = activeMarkers.get(trip.trip_id);
      if (existing) {
        existing.setLatLng(latLng);
        const popup = existing.getPopup();
        if (popup && popup.isOpen()) popup.setLatLng(latLng);
      } else {
        const marker = getMarkerFromPool(trip, latLng);
        marker.addTo(map);
        activeMarkers.set(trip.trip_id, marker);
      }
    } else {
      recycleMarker(trip.trip_id);
      if (focusedBusId === trip.trip_id) focusedBusId = null;
    }
  }
}

function getMarkerFromPool(trip, latLng) {
  let marker;
  if (markerPool.length > 0) {
    marker = markerPool.pop();
    marker.setLatLng(latLng);
    marker.setIcon(routeIcon(trip.route_short_name));
  } else {
    marker = L.marker(latLng, { icon: routeIcon(trip.route_short_name) });
  }
  marker
    .unbindPopup()
    .bindPopup(
      `<b>Route:</b> ${escapeHtml(trip.route_short_name)}<br>` +
        `<b>Trip ID:</b> ${escapeHtml(trip.trip_id)}<br>` +
        `<b>Ends at:</b> ${escapeHtml(trip.end_time)}`,
      { autoPan: false }
    );
  marker.off("click").on("click", (ev) => {
    L.DomEvent.stopPropagation(ev);
    focusedBusId = focusedBusId === trip.trip_id ? null : trip.trip_id;
    updateBuses();
    if (focusedBusId === trip.trip_id) marker.openPopup();
    else marker.closePopup();
  });
  return marker;
}

function recycleMarker(tripId) {
  const marker = activeMarkers.get(tripId);
  if (!marker) return;
  map.removeLayer(marker);
  // Cap the pool: concurrent buses are bounded, old markers beyond that are dropped.
  if (markerPool.length < 300) markerPool.push(marker);
  activeMarkers.delete(tripId);
}

// ---------- search ----------

function toggleSearch() {
  const willOpen = searchContent.hidden;
  searchContent.hidden = !willOpen;
  searchToggle.setAttribute("aria-expanded", String(willOpen));
  searchChevron.classList.toggle("fa-chevron-down", !willOpen);
  searchChevron.classList.toggle("fa-chevron-up", willOpen);
}

function findStops(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const features = stopsData.features;
  // Exact ID match first (stop_id like "104002-380"), then fuzzy name match.
  const exact = features.filter((f) => f.properties.stop_id.toLowerCase() === q);
  if (exact.length > 0) return exact;
  return features.filter((f) => f.properties.stop_name.toLowerCase().includes(q));
}

function searchBusAtStop() {
  const query = stopSearchInput.value;
  const targetTime = searchTimeInput.value; // "HH:MM"
  const windowMins = parseInt(searchWindowInput.value, 10) || 10;

  if (!query.trim() || !targetTime) {
    alert("Please enter a stop name/ID and a target time.");
    return;
  }
  const targetSec = timeToSeconds(`${targetTime}:00`);
  if (!Number.isFinite(targetSec)) {
    alert("Please enter a valid target time.");
    return;
  }
  const windowSec = windowMins * 60;

  const matches = findStops(query);
  if (matches.length === 0) {
    searchResults.innerHTML =
      "<div style='color: #666; padding: 10px;'>No stop found.</div>";
    searchResults.style.display = "block";
    return;
  }
  const stop = matches[0];
  const [lon, lat] = stop.geometry.coordinates;
  const stopLatLng = [lat, lon];
  map.setView(stopLatLng, 16);

  if (searchTargetMarker) map.removeLayer(searchTargetMarker);
  searchTargetMarker = L.circleMarker(stopLatLng, {
    radius: 18,
    color: "#0078ff",
    fillColor: "#ff3300",
    fillOpacity: 0.5,
    weight: 3,
    dashArray: "5, 5",
  }).addTo(map);
  searchTargetMarker
    .bindPopup(`<b>${escapeHtml(stop.properties.stop_name)}</b>`)
    .openPopup();

  // Estimate arrivals: for trips active around the target time, find the
  // shape vertex nearest the stop and interpolate a timestamp for it.
  const candidates = [];
  for (const trip of schedules) {
    if (targetSec < trip.startSec - windowSec || targetSec > trip.endSec + windowSec) continue;
    const coords = shapesLookup.get(trip.shape_id);
    if (!coords) continue;
    let bestDist = Infinity;
    let bestIdx = -1;
    for (let k = 0; k < coords.length; k++) {
      const d = map.distance(stopLatLng, [coords[k][1], coords[k][0]]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = k;
      }
    }
    if (bestDist > SEARCH_NEAR_METERS || bestIdx < 0) continue;
    const estSec = trip.startSec + (trip.endSec - trip.startSec) * (bestIdx / (coords.length - 1));
    if (estSec < targetSec || estSec > targetSec + windowSec) continue;
    candidates.push({ trip, estArrival: secondsToTime(Math.floor(estSec)) });
  }

  const note =
    matches.length > 1
      ? `<div style='color:#666; padding:8px 10px 0;'>${matches.length} stops match — showing first: ${escapeHtml(stop.properties.stop_name)}</div>`
      : "";
  renderSearchResults(candidates, note);
}

function renderSearchResults(candidates, noteHtml = "") {
  searchResults.innerHTML = noteHtml;
  searchResults.style.display = "block";
  if (candidates.length === 0) {
    searchResults.innerHTML +=
      "<div style='color:#999; padding:10px; text-align:center;'>No upcoming services.</div>";
    return;
  }
  const seen = new Set();
  candidates
    .filter(({ trip, estArrival }) => {
      const key = `${trip.route_short_name}-${estArrival}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((x, y) => timeToSeconds(x.estArrival) - timeToSeconds(y.estArrival))
    .forEach(({ trip, estArrival }) => {
      const el = document.createElement("div");
      el.className = "search-result-item";
      el.innerHTML =
        `<div class="service-info"><span class="label">Service:</span> ` +
        `<span class="value">${escapeHtml(trip.route_short_name)}</span></div>` +
        `<div class="arrival-info"><span class="arrival-time">${escapeHtml(estArrival.substring(0, 5))}</span> ` +
        `<span class="arrival-label">Arrival</span></div>`;
      el.addEventListener("click", () => {
        slider.value = timeToSeconds(estArrival);
        focusedBusId = trip.trip_id;
        updateBuses();
        const marker = activeMarkers.get(trip.trip_id);
        if (marker) {
          map.panTo(marker.getLatLng());
          marker.openPopup();
        }
      });
      searchResults.appendChild(el);
    });
}

// ---------- playback ----------

const autoPlay = {
  active: false,
  speedMultiplier: 30,
  lastTimestamp: 0,

  toggle() {
    if (this.active) this.stop();
    else this.start();
  },
  start() {
    if (this.active) return;
    this.active = true;
    this.lastTimestamp = performance.now();
    playPauseBtn.innerHTML = '<i class="fas fa-pause" aria-hidden="true"></i>';
    requestAnimationFrame(this.step.bind(this));
  },
  stop() {
    this.active = false;
    playPauseBtn.innerHTML = '<i class="fas fa-play" aria-hidden="true"></i>';
  },
  setSpeed(value) {
    this.speedMultiplier = parseFloat(value) || 30;
  },
  step(timestamp) {
    if (!this.active) return;
    const dt = (timestamp - this.lastTimestamp) / 1000;
    this.lastTimestamp = timestamp;
    // Clamp dt: switching tabs can otherwise jump the clock by minutes.
    const safeDt = Math.min(Math.max(dt, 0), 1);
    let next = parseFloat(slider.value) + safeDt * this.speedMultiplier;
    if (next > DAY_SECONDS - 1) next = 0;
    slider.value = next;
    updateBuses();
    requestAnimationFrame(this.step.bind(this));
  },
};

function setToCurrentTime() {
  const now = new Date();
  slider.value = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
}

function clearSearch() {
  searchResults.innerHTML = "";
  searchResults.style.display = "none";
  if (searchTargetMarker) {
    map.removeLayer(searchTargetMarker);
    searchTargetMarker = null;
  }
  for (const marker of activeMarkers.values()) {
    const popup = marker.getPopup();
    if (popup && popup.isOpen()) marker.closePopup();
  }
  focusedBusId = null;
  updateBuses();
}

// ---------- wiring ----------

slider.addEventListener("input", updateBuses);
initMap();
loadData();

timeInput.addEventListener("change", () => {
  const sec = timeToSeconds(timeInput.value); // handles HH:MM and HH:MM:SS
  if (Number.isFinite(sec)) {
    slider.value = sec;
    updateBuses();
  }
});

playPauseBtn.addEventListener("click", () => autoPlay.toggle());
speedSelector.addEventListener("change", (e) => autoPlay.setSpeed(e.target.value));
clearBtn.addEventListener("click", clearSearch);
searchToggle.addEventListener("click", toggleSearch);
searchFindBtn.addEventListener("click", searchBusAtStop);
stopSearchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") searchBusAtStop();
});

document.addEventListener("visibilitychange", () => {
  // Avoid a huge dt jump when returning to the tab.
  if (autoPlay.active && !document.hidden) autoPlay.lastTimestamp = performance.now();
});

window.addEventListener("keydown", (e) => {
  const el = document.activeElement;
  if (el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA")) return;
  const current = parseFloat(slider.value);
  if (e.key === "ArrowRight") {
    slider.value = Math.min(current + 30, DAY_SECONDS - 1);
    updateBuses();
  } else if (e.key === "ArrowLeft") {
    slider.value = Math.max(current - 30, 0);
    updateBuses();
  }
});

// Backwards compatibility for any remaining inline handlers / console use.
window.toggleSearch = toggleSearch;
window.searchBusAtStop = searchBusAtStop;
window.clearSearch = clearSearch;
window.autoPlay = autoPlay;
window.updateBuses = updateBuses;
