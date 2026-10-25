"use strict";

const LIVE_API_BASE =
  "https://app.craiova-transport.com/api/v1/ba79f1ee-c6f7-48ad-8a42-d23417a3ab53";
const LIVE_VEHICLES_PATH = "transport/planner/vehicles";
const LIVE_ROUTES_PATH = "transport/planner/routes";
const LIVE_POLL_MS = 10000;

let liveEnabled = false;
let liveTimer = null;
let liveFetching = false;
const liveMarkers = new Map(); // vehicleId -> L.Marker
const liveRouteNames = new Map(); // routeId -> shortName

const liveToggleBtn = document.getElementById("live-toggle-btn");
const liveStatus = document.getElementById("live-status");

function liveSetStatus(html, isError) {
  if (!liveStatus) return;
  liveStatus.hidden = false;
  liveStatus.innerHTML = html;
  liveStatus.classList.toggle("live-error", Boolean(isError));
}

function liveClearStatus() {
  if (!liveStatus) return;
  liveStatus.hidden = true;
  liveStatus.innerHTML = "";
  liveStatus.classList.remove("live-error");
}

function formatClock(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

function formatDelay(sec) {
  if (sec === null || sec === undefined) return "n/a";
  const m = Math.round(sec / 60);
  if (m === 0) return "on time";
  return m > 0 ? `+${m} min late` : `${-m} min early`;
}

async function liveFetchJson(path) {
  const res = await fetch(`${LIVE_API_BASE}/${path}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    referrerPolicy: "no-referrer",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
  return res.json();
}

async function liveLoadRoutes() {
  if (liveRouteNames.size > 0) return;
  const routes = await liveFetchJson(LIVE_ROUTES_PATH);
  for (const r of routes) {
    if (r && r.id !== undefined) liveRouteNames.set(r.id, r.shortName || String(r.id));
  }
}

function livePopupHtml(v) {
  const shortName = liveRouteNames.get(v.routeId) || String(v.routeId ?? "?");
  const updated = v.lastUpdated ? new Date(v.lastUpdated) : null;
  return (
    `<b>Route:</b> ${escapeHtml(shortName)}` +
    (v.label ? ` (${escapeHtml(v.label)})` : "") +
    `<br><b>Vehicle:</b> ${escapeHtml(v.vehicleId ?? "?")}` +
    (v.tripId ? `<br><b>Trip:</b> ${escapeHtml(v.tripId)}` : "") +
    (v.speed !== undefined ? `<br><b>Speed:</b> ${escapeHtml(Math.round(v.speed * 3.6))} km/h` : "") +
    (v.heading !== undefined ? `<br><b>Heading:</b> ${escapeHtml(Math.round(v.heading))}°` : "") +
    `<br><b>Delay:</b> ${escapeHtml(formatDelay(v.delaySeconds))}` +
    (v.nextStopArrival
      ? `<br><b>Next stop:</b> ${escapeHtml(String(v.nextStopArrival).substring(11, 16))}Z`
      : "") +
    (updated ? `<br><b>Updated:</b> ${escapeHtml(formatClock(updated))}` : "")
  );
}

function liveRender(vehicles) {
  const seen = new Set();
  for (const v of vehicles) {
    if (v.vehicleId === undefined || v.latitude === undefined || v.longitude === undefined)
      continue;
    seen.add(v.vehicleId);
    const latLng = [v.latitude, v.longitude];
    const shortName = liveRouteNames.get(v.routeId) || String(v.routeId ?? "?");
    let marker = liveMarkers.get(v.vehicleId);
    if (marker) {
      marker.setLatLng(latLng);
      marker.setIcon(routeIcon(shortName));
      const popup = marker.getPopup();
      if (popup) {
        marker.unbindPopup().bindPopup(livePopupHtml(v), { autoPan: false });
        if (popup.isOpen()) marker.openPopup();
      }
    } else {
      marker = L.marker(latLng, { icon: routeIcon(shortName), title: `Route ${shortName}` });
      marker.bindPopup(livePopupHtml(v), { autoPan: false });
      marker.addTo(map);
      liveMarkers.set(v.vehicleId, marker);
    }
  }
  for (const [id, marker] of liveMarkers) {
    if (!seen.has(id)) {
      map.removeLayer(marker);
      liveMarkers.delete(id);
    }
  }
}

async function liveRefresh() {
  if (!liveEnabled || liveFetching || typeof map === "undefined") return;
  liveFetching = true;
  try {
    await liveLoadRoutes();
    const vehicles = await liveFetchJson(LIVE_VEHICLES_PATH);
    liveRender(vehicles);
    liveSetStatus(
      `<span class="live-dot"></span>LIVE · ${vehicles.length} buses · ${escapeHtml(formatClock(new Date()))}`
    );
  } catch (err) {
    console.error("Live refresh failed:", err);
    liveSetStatus("LIVE · offline — retrying…", true);
  } finally {
    liveFetching = false;
  }
}

function liveHideSimulatedBuses() {
  for (const tripId of [...activeMarkers.keys()]) recycleMarker(tripId);
}

function liveEnable() {
  if (typeof map === "undefined") return;
  liveEnabled = true;
  if (typeof autoPlay !== "undefined") autoPlay.stop();
  liveHideSimulatedBuses();
  if (liveToggleBtn) {
    liveToggleBtn.classList.add("active");
    liveToggleBtn.setAttribute("aria-pressed", "true");
  }
  liveSetStatus('<span class="live-dot"></span>LIVE · connecting…');
  liveRefresh();
  liveTimer = setInterval(liveRefresh, LIVE_POLL_MS);
}

function liveDisable() {
  liveEnabled = false;
  if (liveTimer) {
    clearInterval(liveTimer);
    liveTimer = null;
  }
  for (const [, marker] of liveMarkers) map.removeLayer(marker);
  liveMarkers.clear();
  if (liveToggleBtn) {
    liveToggleBtn.classList.remove("active");
    liveToggleBtn.setAttribute("aria-pressed", "false");
  }
  liveClearStatus();
  if (typeof autoPlay !== "undefined") autoPlay.start();
  if (typeof updateBuses === "function") updateBuses();
}

if (liveToggleBtn) {
  liveToggleBtn.addEventListener("click", () => {
    if (liveEnabled) liveDisable();
    else liveEnable();
  });
}

document.addEventListener("visibilitychange", () => {
  if (liveEnabled && !document.hidden) liveRefresh();
});

// Console / debug access.
window.liveTransit = {
  toggle: () => (liveEnabled ? liveDisable() : liveEnable()),
  refresh: liveRefresh,
  get enabled() {
    return liveEnabled;
  },
};
