/**
 * TransitON — UI + smarttransit.py API 연동
 */

(function () {
  "use strict";

  const API_BASE = window.location.origin;
  const VIEWS = ["home", "search", "realtime", "routes", "golden", "saved"];

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
  const routeSummaryLabel = document.getElementById("route-summary-label");
  const toastEl = document.getElementById("toast");

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

    if (viewName === "realtime" && !state.realtime) loadRealtime();
    if (viewName === "golden" && !state.analysis) loadAnalysis();
  }

  document.querySelectorAll("[data-nav]").forEach((el) => {
    el.addEventListener("click", () => {
      const target = el.dataset.nav;
      if (!target) return;
      if (target === "routes" && destinationInput) {
        state.destination = destinationInput.value.trim() || state.destination;
        updateRouteSummary();
        loadAnalysis(state.destination);
      }
      showView(target);
    });
  });

  function updateRouteSummary() {
    if (routeSummaryLabel) {
      routeSummaryLabel.textContent = `부산 남구 대연동 → ${state.destination}`;
    }
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
            <p>부산 남구 대연동 → ${best.stop_name}</p>
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

  /* ---- Search ---- */

  document.querySelectorAll(".suggestion-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const dest = btn.dataset.dest;
      if (destinationInput) destinationInput.value = dest;
      state.destination = dest;
      showToast(`${dest}(으)로 경로를 검색합니다`);
    });
  });

  document.getElementById("clear-search")?.addEventListener("click", () => {
    if (destinationInput) destinationInput.value = "";
    destinationInput?.focus();
  });

  document.getElementById("search-submit")?.addEventListener("click", () => {
    const dest = destinationInput?.value.trim();
    if (!dest) {
      showToast("도착지를 입력해 주세요");
      destinationInput?.focus();
      return;
    }
    state.destination = dest;
    updateRouteSummary();
    loadAnalysis(dest);
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

  /* ---- Init ---- */

  updateRouteSummary();
  showView("home");
  loadAnalysis(state.destination);
})();
