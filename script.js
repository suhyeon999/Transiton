/**
 * TransitON — UI + smarttransit.py API 연동
 */

(function () {
  "use strict";

  const API_BASE = window.location.origin;
  const VIEWS = ["home", "search", "realtime", "routes", "golden", "saved"];
  const MAP_CENTER = { lat: 35.1341, lng: 129.0963, label: "부산 남구 대연동" };
  let kakaoMap = null;
  let routeMap = null;
  let geocoder = null;
  let places = null;
  let kakaoReadyResolve = null;
  const kakaoReady = new Promise((resolve) => {
    kakaoReadyResolve = resolve;
  });
  let mapMarkers = { current: null, destination: null };
  let mapPolylines = [];
  const mapLayers = {
    home: { markers: [], lines: [], overlays: [] },
    route: { markers: [], lines: [], overlays: [] },
  };

  const locationState = {
    current: { ...MAP_CENTER, source: "fallback" },
    destination: null,
  };

  const state = {
    currentView: "home",
    destination: "부산역",
    favoriteAdded: false,
    analysis: null,
    realtime: null,
  };

  const views = {};
  VIEWS.forEach((name) => {
    views[name] = document.getElementById(`view-${name}`);
  });

  const bottomNavItems = document.querySelectorAll(".bottom-nav__item");
  const destinationInput = document.getElementById("destination");
  const originInput = document.getElementById("origin");
  const routeSummaryLabel = document.getElementById("route-summary-label");
  const mapLocationLabel = document.getElementById("map-location-label");
  const routeMapLabel = document.getElementById("route-map-label");
  const placeAutocomplete = document.getElementById("place-autocomplete");
  const toastEl = document.getElementById("toast");
  let autocompleteTimer = null;

  /* ---- Navigation ---- */

  function showView(viewName) {
    if (!views[viewName]) return;
    state.currentView = viewName;
    Object.values(views).forEach((el) => el.classList.remove("view--active"));
    views[viewName].classList.add("view--active");
    bottomNavItems.forEach((item) => {
      item.classList.toggle("bottom-nav__item--active", item.dataset.nav === viewName);
    });
    window.scrollTo(0, 0);

    if (viewName === "home") relayoutMap();
    if (viewName === "routes") {
      initRouteMap();
      updateMapRoute();
      relayoutRouteMap();
    }
    if (viewName === "realtime" && !state.realtime) loadRealtime();
    if (viewName === "golden" && !state.analysis) loadAnalysis();
  }

  document.querySelectorAll("[data-nav]").forEach((el) => {
    el.addEventListener("click", async () => {
      const target = el.dataset.nav;
      if (!target) return;

      if (target === "routes") {
        const query = destinationInput?.value.trim() || state.destination;
        if (query && (!locationState.destination || locationState.destination.name !== query)) {
          const ok = await setDestination(query);
          if (!ok) return;
        } else {
          updateRouteSummary();
          loadAnalysis(state.destination);
        }
      }

      showView(target);
    });
  });

  function updateRouteSummary() {
    const from = locationState.current.label || MAP_CENTER.label;
    const to = locationState.destination?.name || state.destination;
    if (routeSummaryLabel) routeSummaryLabel.textContent = `${from} → ${to}`;
    if (routeMapLabel) routeMapLabel.textContent = `${from} → ${to}`;
  }

  function updateOriginField() {
    if (!originInput) return;
    const prefix = locationState.current.source === "gps" ? "현재 위치" : "기본 위치";
    originInput.value = `${prefix} · ${locationState.current.label}`;
  }

  /* ---- API ---- */

  async function fetchJSON(path) {
    const res = await fetch(`${API_BASE}${path}`);
    if (!res.ok) throw new Error(`API ${res.status}`);
    return res.json();
  }

  function formatEta(minutes) {
    if (minutes <= 0) return "곧 도착";
    if (minutes === 1) return "1분";
    return `${minutes}분`;
  }

  function renderBusPanel(bus) {
    const container = document.getElementById("bus-list");
    if (!container || !bus) return;

    const arrivals = (bus.arrivals || [])
      .map(
        (a) => `
      <li class="arrival-item">
        <span class="route-badge route-badge--bus">${a.line_no}</span>
        <div class="arrival-item__info">
          <strong>${a.destination || "운행"}</strong>
          <span class="${a.eta <= 2 ? "arrival-item__status arrival-item__status--soon" : ""}">
            ${formatEta(a.eta)}${a.eta > 0 ? " 후" : ""}
          </span>
        </div>
      </li>`
      )
      .join("");

    container.innerHTML = `
      <article class="realtime-card">
        <header class="realtime-card__head">
          <div>
            <h3>${bus.stop_name}</h3>
            <p>정류장 ID ${bus.stop_id} · ${bus.dist}m</p>
          </div>
          <span class="badge badge--live">${bus.source === "api" ? "LIVE" : "DEMO"}</span>
        </header>
        <ul class="arrival-list">${arrivals || '<li class="arrival-item"><span>도착 정보 없음</span></li>'}</ul>
      </article>`;
  }

  function renderSubwayPanel(subway) {
    const container = document.getElementById("subway-list");
    if (!container || !subway) return;

    const arrivals = (subway.arrivals || [])
      .map((a) => {
        const label = a.direction.length > 4 ? a.direction.slice(0, 4) : a.direction;
        return `
      <li class="arrival-item">
        <span class="route-badge route-badge--subway">${label}</span>
        <div class="arrival-item__info">
          <strong>${a.direction}</strong>
          <span class="${a.eta <= 2 ? "arrival-item__status arrival-item__status--soon" : ""}">
            ${formatEta(a.eta)}
          </span>
        </div>
      </li>`;
      })
      .join("");

    container.innerHTML = `
      <article class="realtime-card">
        <header class="realtime-card__head">
          <div>
            <h3>${subway.stop_name.replace("(지하철)", "")} <span class="line-tag line-tag--2">${subway.line}</span></h3>
            <p>역 ID ${subway.station_id} · ${subway.dist}m</p>
          </div>
          <span class="badge badge--live">${subway.source === "api" ? "LIVE" : "DEMO"}</span>
        </header>
        <ul class="arrival-list">${arrivals || '<li class="arrival-item"><span>도착 정보 없음</span></li>'}</ul>
      </article>`;
  }

  function renderNearbyList(data) {
    const container = document.getElementById("nearby-list");
    if (!container || !data) return;

    const { bus, subway } = data;
    const busFirst = bus.arrivals?.[0];
    const subwayFirst = subway.arrivals?.[0];

    container.innerHTML = `
      <article class="nearby-card">
        <div class="nearby-card__icon nearby-card__icon--bus">🚌</div>
        <div class="nearby-card__body">
          <h3>${bus.stop_name}</h3>
          <p>도보 ${Math.ceil(bus.dist / 80)}분 · ${busFirst ? `${busFirst.line_no}번 ${formatEta(busFirst.eta)}` : "정보 확인"}</p>
        </div>
        <span class="badge badge--live">${bus.source === "api" ? "실시간" : "데모"}</span>
      </article>
      <article class="nearby-card">
        <div class="nearby-card__icon nearby-card__icon--subway">🚇</div>
        <div class="nearby-card__body">
          <h3>경성대부경대역 (${subway.line})</h3>
          <p>도보 ${Math.ceil(subway.dist / 80)}분 · ${subwayFirst ? `${subwayFirst.direction} ${formatEta(subwayFirst.eta)}` : "정보 확인"}</p>
        </div>
        <span class="badge badge--live">${subway.source === "api" ? "실시간" : "데모"}</span>
      </article>`;
  }

  function renderAnalysis(result) {
    if (!result) return;
    state.analysis = result;
    state.realtime = result;

    const { best, analysis, bus, subway, using_fallback } = result;
    const statusEl = document.getElementById("api-status");
    if (statusEl) {
      statusEl.textContent = using_fallback
        ? "API 연결 실패 — 시연용 데이터 표시"
        : `BIMS · Humetro API · ${result.updated_at} 갱신`;
      statusEl.classList.toggle("api-status--warn", using_fallback);
    }

    renderNearbyList(result);
    renderBusPanel(bus);
    renderSubwayPanel(subway);

    const totalMin = best.eta + analysis.ride_minutes;
    const homeTime = document.getElementById("home-route-time");
    const homeMode = document.getElementById("home-route-mode");
    const homePath = document.getElementById("home-route-path");
    if (homeTime) homeTime.textContent = `약 ${totalMin}분`;
    if (homeMode) homeMode.textContent = `${best.type} ${best.name}`;
    if (homePath) {
      homePath.textContent = `${best.stop_name} → ${best.type} → ${result.destination || state.destination}`;
    }

    const goldenTime = document.getElementById("golden-time");
    const goldenDepartEm = document.getElementById("golden-depart-em");
    const goldenDest = document.getElementById("golden-destination");
    if (goldenTime) goldenTime.textContent = analysis.departure_time;
    if (goldenDepartEm) goldenDepartEm.textContent = analysis.departure_time;
    if (goldenDest) goldenDest.textContent = result.destination || state.destination;

    const schedule = document.getElementById("golden-schedule");
    if (schedule) {
      schedule.innerHTML = `
        <div class="golden-schedule__item golden-schedule__item--urgent">
          <span class="golden-schedule__icon">${best.type === "버스" ? "🚌" : "🚇"}</span>
          <div>
            <strong>추천 · ${best.type} ${best.name}</strong>
            <p>${best.stop_name} · ${formatEta(best.eta)} 후 도착</p>
          </div>
          <span class="golden-schedule__countdown">${formatEta(best.eta)}</span>
        </div>
        <div class="golden-schedule__item">
          <span class="golden-schedule__icon">🚶</span>
          <div>
            <strong>도보 이동</strong>
            <p>${best.dist}m · 약 ${analysis.walk_minutes}분</p>
          </div>
        </div>
        <div class="golden-schedule__item">
          <span class="golden-schedule__icon">🏁</span>
          <div>
            <strong>귀가 완료 예상</strong>
            <p>${analysis.arrival_time} · 여유 ${analysis.golden_minutes}분</p>
          </div>
        </div>`;
    }

    const gRouteTime = document.getElementById("golden-route-time");
    const gRouteMode = document.getElementById("golden-route-mode");
    const gRoutePath = document.getElementById("golden-route-path");
    if (gRouteTime) gRouteTime.textContent = `약 ${totalMin}분`;
    if (gRouteMode) gRouteMode.textContent = `${best.type} 추천`;
    if (gRoutePath) {
      gRoutePath.textContent = `${best.stop_name} → ${best.type}(${best.name}) → ${result.destination || state.destination}`;
    }

    const stats = document.querySelectorAll(".summary-stat__value");
    if (stats.length >= 3) {
      stats[0].textContent = `${totalMin}분`;
      stats[1].textContent = best.type;
      stats[2].textContent = analysis.arrival_time;
    }

    const timeline = document.querySelector(".timeline");
    if (timeline && best) {
      timeline.innerHTML = `
        <li class="timeline__item">
          <div class="timeline__dot timeline__dot--walk"></div>
          <div class="timeline__content">
            <strong>도보 ${analysis.walk_minutes}분</strong>
            <p>${locationState.current.label} → ${best.stop_name}</p>
          </div>
        </li>
        <li class="timeline__item">
          <div class="timeline__dot ${best.type === "지하철" ? "timeline__dot--subway line-2" : "timeline__dot--walk"}"></div>
          <div class="timeline__content">
            <strong>${best.type} ${best.name}</strong>
            <p>${best.stop_name} 탑승 · ${formatEta(best.eta)} 후 도착</p>
            <span class="timeline__chip">추천 수단</span>
          </div>
        </li>
        <li class="timeline__item">
          <div class="timeline__dot timeline__dot--walk"></div>
          <div class="timeline__content">
            <strong>이동 ${analysis.ride_minutes}분</strong>
            <p>목적지 ${result.destination || state.destination} 도착 예정 ${analysis.arrival_time}</p>
          </div>
        </li>`;
    }

    const banner = document.getElementById("route-info-banner");
    if (banner) {
      banner.textContent = using_fallback
        ? "API 연결 실패 — smarttransit.py 시연용 데이터로 표시 중입니다."
        : `실시간 ${best.type}(${best.name}) 기반 · 골든타임 출발 ${analysis.departure_time}`;
    }
  }

  async function loadRealtime() {
    try {
      const data = await fetchJSON("/api/realtime");
      state.realtime = data;
      renderNearbyList(data);
      renderBusPanel(data.bus);
      renderSubwayPanel(data.subway);
      const statusEl = document.getElementById("api-status");
      if (statusEl) {
        statusEl.textContent = data.using_fallback
          ? "API 연결 실패 — 시연용 데이터"
          : `갱신 ${data.updated_at}`;
      }
    } catch {
      showToast("서버에 연결할 수 없습니다. python smarttransit.py 실행");
    }
  }

  async function loadAnalysis(destination) {
    const dest = destination || state.destination || "집";
    try {
      const data = await fetchJSON(`/api/analysis?destination=${encodeURIComponent(dest)}`);
      renderAnalysis(data);
    } catch {
      showToast("분석 API 연결 실패 — smarttransit.py 서버 확인");
    }
  }

  document.getElementById("refresh-realtime")?.addEventListener("click", () => {
    state.realtime = null;
    loadRealtime();
    showToast("실시간 정보를 새로고침합니다");
  });

  /* ---- Search & Geocoding ---- */

  function whenKakaoReady() {
    return kakaoReady;
  }

  function hideAutocomplete() {
    if (placeAutocomplete) {
      placeAutocomplete.hidden = true;
      placeAutocomplete.innerHTML = "";
    }
  }

  function parseGeocodeItem(item, fallbackName) {
    return {
      lat: parseFloat(item.y),
      lng: parseFloat(item.x),
      name: fallbackName,
      address: item.address_name || item.road_address?.address_name || fallbackName,
    };
  }

  function parsePlaceItem(item) {
    return {
      lat: parseFloat(item.y),
      lng: parseFloat(item.x),
      name: item.place_name,
      address: item.road_address_name || item.address_name || item.place_name,
    };
  }

  function searchPlaces(keyword) {
    return new Promise((resolve, reject) => {
      if (!places) {
        reject(new Error("no places"));
        return;
      }
      places.keywordSearch(
        keyword,
        (data, status) => {
          if (status === kakao.maps.services.Status.OK && data.length) {
            resolve(parsePlaceItem(data[0]));
          } else {
            reject(new Error("not found"));
          }
        },
        { location: toLatLng(locationState.current), radius: 30000 }
      );
    });
  }

  function searchAddress(keyword) {
    return new Promise((resolve, reject) => {
      if (!geocoder) {
        reject(new Error("no geocoder"));
        return;
      }
      geocoder.addressSearch(keyword, (result, status) => {
        if (status === kakao.maps.services.Status.OK && result.length) {
          resolve(parseGeocodeItem(result[0], keyword));
        } else {
          reject(new Error("not found"));
        }
      });
    });
  }

  async function geocodeDestination(keyword) {
    await whenKakaoReady();

    const queries = [keyword, `부산 ${keyword}`];
    for (const query of queries) {
      try {
        return await searchPlaces(query);
      } catch {
        /* try address next */
      }
      try {
        return await searchAddress(query);
      } catch {
        /* try next query */
      }
    }
    throw new Error("not found");
  }

  function showAutocompleteResults(items) {
    if (!placeAutocomplete) return;
    if (!items.length) {
      hideAutocomplete();
      return;
    }

    placeAutocomplete.innerHTML = items
      .slice(0, 5)
      .map(
        (item, index) => `
      <li>
        <button type="button" class="place-autocomplete__item" data-index="${index}">
          <strong>${item.name}</strong>
          <small>${item.address}</small>
        </button>
      </li>`
      )
      .join("");
    placeAutocomplete.hidden = false;

    placeAutocomplete.querySelectorAll(".place-autocomplete__item").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const item = items[Number(btn.dataset.index)];
        locationState.destination = item;
        state.destination = item.name;
        if (destinationInput) destinationInput.value = item.name;
        hideAutocomplete();
        updateRouteSummary();
        updateMapRoute();
        loadAnalysis(item.name);
        showToast(`${item.name}(으)로 설정했습니다`);
      });
    });
  }

  function fetchAutocomplete(keyword) {
    if (!keyword || keyword.length < 2) {
      hideAutocomplete();
      return;
    }

    whenKakaoReady().then(() => {
      if (!places) return;
      places.keywordSearch(
        keyword,
        (data, status) => {
          if (status !== kakao.maps.services.Status.OK) {
            hideAutocomplete();
            return;
          }
          showAutocompleteResults(data.map(parsePlaceItem));
        },
        { location: toLatLng(locationState.current), radius: 30000 }
      );
    });
  }

  async function setDestination(keyword, options = {}) {
    const { silent = false, navigate = false } = options;
    const query = keyword.trim();
    if (!query) {
      if (!silent) showToast("도착지를 입력해 주세요");
      destinationInput?.focus();
      return false;
    }

    try {
      if (!silent) showToast("목적지 좌표를 검색 중…");
      await whenKakaoReady();
      const dest = await geocodeDestination(query);
      locationState.destination = dest;
      state.destination = dest.name;
      if (destinationInput) destinationInput.value = dest.name;
      hideAutocomplete();
      updateRouteSummary();
      updateMapRoute();
      loadAnalysis(dest.name);
      if (!silent) showToast(`${dest.name}(으)로 경로를 설정했습니다`);
      if (navigate) showView("routes");
      return true;
    } catch {
      if (!silent) showToast("목적지를 찾을 수 없습니다. 다른 키워드로 검색해 보세요");
      return false;
    }
  }

  document.querySelectorAll(".suggestion-item").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const dest = btn.dataset.dest;
      if (destinationInput) destinationInput.value = dest;
      await setDestination(dest);
    });
  });

  document.getElementById("clear-search")?.addEventListener("click", () => {
    if (destinationInput) destinationInput.value = "";
    locationState.destination = null;
    updateMapRoute();
    destinationInput?.focus();
  });

  document.getElementById("search-submit")?.addEventListener("click", async () => {
    await setDestination(destinationInput?.value || "", { navigate: true });
  });

  document.getElementById("btn-locate")?.addEventListener("click", () => {
    requestCurrentLocation(true);
  });

  destinationInput?.addEventListener("input", () => {
    clearTimeout(autocompleteTimer);
    autocompleteTimer = setTimeout(() => {
      fetchAutocomplete(destinationInput.value.trim());
    }, 300);
  });

  destinationInput?.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      hideAutocomplete();
      await setDestination(destinationInput.value, { navigate: true });
    }
    if (e.key === "Escape") hideAutocomplete();
  });

  document.addEventListener("click", (e) => {
    if (!placeAutocomplete || !destinationInput) return;
    if (e.target === destinationInput || placeAutocomplete.contains(e.target)) return;
    hideAutocomplete();
  });

  /* ---- Realtime tabs ---- */

  const realtimeTabs = document.querySelectorAll("#view-realtime .tab[data-tab]");
  const realtimePanels = { bus: document.getElementById("panel-bus"), subway: document.getElementById("panel-subway") };

  realtimeTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const key = tab.dataset.tab;
      realtimeTabs.forEach((t) => {
        t.classList.toggle("tab--active", t === tab);
        t.setAttribute("aria-selected", t === tab ? "true" : "false");
      });
      Object.entries(realtimePanels).forEach(([name, panel]) => {
        panel?.classList.toggle("tab-panel--active", name === key);
      });
    });
  });

  /* ---- Saved tabs ---- */

  const savedTabs = document.querySelectorAll("[data-saved-tab]");
  const savedPanels = {
    favorites: document.getElementById("panel-favorites"),
    recent: document.getElementById("panel-recent"),
  };

  savedTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const key = tab.dataset.savedTab;
      savedTabs.forEach((t) => t.classList.toggle("tab--active", t === tab));
      Object.entries(savedPanels).forEach(([name, panel]) => {
        panel?.classList.toggle("saved-panel--active", name === key);
      });
    });
  });

  /* ---- Route options (UI) ---- */

  document.querySelectorAll(".route-option").forEach((option) => {
    option.addEventListener("click", () => {
      document.querySelectorAll(".route-option").forEach((o) => o.classList.remove("route-option--active"));
      option.classList.add("route-option--active");
    });
  });

  document.getElementById("add-favorite")?.addEventListener("click", () => {
    state.favoriteAdded = !state.favoriteAdded;
    showToast(state.favoriteAdded ? "즐겨찾기에 추가 (Supabase 연동 예정)" : "즐겨찾기 해제");
  });

  /* ---- Toast ---- */

  let toastTimer;
  function showToast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.add("toast--visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("toast--visible"), 2500);
  }

  /* ---- Kakao Map & Location ---- */

  function toLatLng(point) {
    return new kakao.maps.LatLng(point.lat, point.lng);
  }

  function createMap(containerId, center) {
    const container = document.getElementById(containerId);
    if (!container) return null;
    return new kakao.maps.Map(container, {
      center: toLatLng(center),
      level: 3,
    });
  }

  function clearMapLayer(key) {
    mapLayers[key].markers.forEach((m) => m.setMap(null));
    mapLayers[key].lines.forEach((l) => l.setMap(null));
    mapLayers[key].overlays?.forEach((o) => o.setMap(null));
    mapLayers[key] = { markers: [], lines: [], overlays: [] };
    if (key === "home") mapPolylines = [];
  }

  function attachInfoWindow(map, marker, title, desc) {
    const overlay = new kakao.maps.InfoWindow({
      content: `<div style="padding:6px 10px;font-size:12px;line-height:1.4"><strong>${title}</strong><br>${desc}</div>`,
    });
    overlay.open(map, marker);
    return overlay;
  }

  function renderMapLayer(map, layerKey) {
    if (!map) return;
    clearMapLayer(layerKey);

    const startMarker = new kakao.maps.Marker({
      map,
      position: toLatLng(locationState.current),
      title: "출발지",
    });
    mapLayers[layerKey].markers.push(startMarker);
    mapLayers[layerKey].overlays.push(
      attachInfoWindow(map, startMarker, "출발", locationState.current.label)
    );
    if (layerKey === "home") mapMarkers.current = startMarker;

    if (locationState.destination) {
      const endMarker = new kakao.maps.Marker({
        map,
        position: toLatLng(locationState.destination),
        title: "목적지",
      });
      mapLayers[layerKey].markers.push(endMarker);
      mapLayers[layerKey].overlays.push(
        attachInfoWindow(map, endMarker, "목적지", locationState.destination.name)
      );
      if (layerKey === "home") mapMarkers.destination = endMarker;

      const path = [toLatLng(locationState.current), toLatLng(locationState.destination)];
      const line = new kakao.maps.Polyline({
        map,
        path,
        strokeWeight: 4,
        strokeColor: "#0064ff",
        strokeOpacity: 0.85,
      });
      mapLayers[layerKey].lines.push(line);
      if (layerKey === "home") mapPolylines.push(line);

      const bounds = new kakao.maps.LatLngBounds();
      path.forEach((coord) => bounds.extend(coord));
      map.setBounds(bounds, 48, 48, 48, 48);
    } else {
      map.setCenter(toLatLng(locationState.current));
      map.setLevel(3);
    }
  }

  function updateMapRoute() {
    if (!window.kakao || !kakaoMap) return;

    renderMapLayer(kakaoMap, "home");

    if (mapLocationLabel) {
      mapLocationLabel.textContent =
        locationState.current.source === "gps"
          ? `현재 위치 · ${locationState.current.label}`
          : `기본 위치 · ${locationState.current.label}`;
    }

    if (routeMap) renderMapLayer(routeMap, "route");
  }

  function applyCurrentLocation(point, source) {
    locationState.current = { ...point, source };
    updateOriginField();
    updateMapRoute();
    updateRouteSummary();
  }

  function reverseGeocodeCurrent(lat, lng) {
    if (!geocoder) {
      applyCurrentLocation({ lat, lng, label: "현재 위치" }, "gps");
      return;
    }

    geocoder.coord2Address(lng, lat, (result, status) => {
      let label = "현재 위치";
      if (status === kakao.maps.services.Status.OK && result[0]) {
        const addr = result[0].road_address || result[0].address;
        label = addr?.address_name || label;
      }
      applyCurrentLocation({ lat, lng, label }, "gps");
    });
  }

  function requestCurrentLocation(showFeedback) {
    const btn = document.getElementById("btn-locate");
    if (btn) btn.disabled = true;

    if (!navigator.geolocation) {
      applyCurrentLocation({ ...MAP_CENTER }, "fallback");
      if (showFeedback) showToast("Geolocation 미지원 — 기본 위치 사용");
      if (btn) btn.disabled = false;
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        reverseGeocodeCurrent(pos.coords.latitude, pos.coords.longitude);
        if (showFeedback) showToast("현재 위치를 불러왔습니다");
        if (btn) btn.disabled = false;
      },
      () => {
        applyCurrentLocation({ ...MAP_CENTER }, "fallback");
        if (showFeedback) showToast("위치 권한 실패 — 기본 좌표 사용");
        if (btn) btn.disabled = false;
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  function initKakaoMap() {
    if (!window.kakao || !window.kakao.maps) {
      console.warn("Kakao Maps SDK를 불러오지 못했습니다.");
      updateOriginField();
      kakaoReadyResolve?.();
      requestCurrentLocation(false);
      return;
    }

    kakao.maps.load(function () {
      geocoder = new kakao.maps.services.Geocoder();
      places = new kakao.maps.services.Places();

      kakaoMap = createMap("map", locationState.current);
      updateMapRoute();
      kakaoMap.relayout();
      kakaoReadyResolve();

      requestCurrentLocation(false);
      setDestination(state.destination, { silent: true });
    });
  }

  function initRouteMap() {
    if (routeMap || !window.kakao?.maps) return;
    const container = document.getElementById("route-map");
    if (!container) return;

    routeMap = createMap("route-map", locationState.current);
    updateMapRoute();
  }

  function relayoutMap() {
    if (!kakaoMap || !window.kakao) return;
    kakaoMap.relayout();
    updateMapRoute();
  }

  function relayoutRouteMap() {
    if (!routeMap || !window.kakao) return;
    routeMap.relayout();
    updateMapRoute();
  }

  /* ---- Init ---- */

  updateOriginField();
  updateRouteSummary();
  initKakaoMap();
  showView("home");
  loadAnalysis(state.destination);
})();
