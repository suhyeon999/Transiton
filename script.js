/**
 * TransitON — 정적 웹 (Kakao Maps JavaScript API)
 */

(function () {
  "use strict";

  const VIEWS = ["home", "search", "realtime", "routes", "golden", "saved"];
  const MAP_CENTER = { lat: 35.1341, lng: 129.0963, label: "부산 남구 대연동" };
  const KAKAO_APP_KEY = "296c5ade868479775159b17f059f53e0";
  const KAKAO_SDK_URL = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KAKAO_APP_KEY}&libraries=services&autoload=false`;
  const WALK_SPEED = 1.2; // m/s
  const UNAVAILABLE_MSG =
    "부산 BIMS·Humetro 공공데이터 API 연동 후 제공됩니다. (백엔드 서버 불필요 시 REST 프록시 필요)";

  let kakaoMap = null;
  let routeMap = null;
  let geocoder = null;
  let places = null;
  let directions = null;
  let kakaoReadyResolve = null;
  let kakaoReadyReject = null;
  const kakaoReady = new Promise((resolve, reject) => {
    kakaoReadyResolve = resolve;
    kakaoReadyReject = reject;
  });
  let kakaoServicesReady = false;
  let kakaoBootstrapError = null;
  let lastKakaoCspViolation = null;
  const PLACES_MAX_RADIUS = 20000;

  document.addEventListener("securitypolicyviolation", (e) => {
    if (!e.blockedURI?.includes("dapi.kakao.com") && !e.sourceFile?.includes("sdk.js")) return;
    lastKakaoCspViolation = {
      blockedURI: e.blockedURI,
      violatedDirective: e.violatedDirective,
      effectiveDirective: e.effectiveDirective,
      disposition: e.disposition,
      originalPolicy: e.originalPolicy?.slice(0, 200),
    };
    logKakaoError("CSP 위반 — Kakao SDK 차단 가능", lastKakaoCspViolation);
  });

  function formatErrorForLog(err, depth = 0) {
    if (err == null) return null;
    if (typeof err === "string") return { message: err };
    const out = {
      name: err.name,
      message: err.message,
      code: err.code,
      location: err.location,
      bootstrapStep: err.bootstrapStep,
      sdkUrl: err.sdkUrl,
      hostname: err.hostname,
      eventType: err.eventType,
      failureKind: err.failureKind,
      appkey: err.appkey,
      probeHttpStatus: err.probeHttpStatus,
      probeJson: err.probeJson,
      network: err.network,
      diagnosis: err.diagnosis,
    };
    if (err.stack) out.stack = err.stack;
    if (err.diag) out.diag = err.diag;
    if (err.cause && depth < 4) out.cause = formatErrorForLog(err.cause, depth + 1);
    return out;
  }

  function logKakao(label, detail) {
    console.log(`[TransitON:Kakao] ${label}`);
    if (detail instanceof Error) {
      console.log(formatErrorForLog(detail));
      if (detail.stack) console.log(detail.stack);
    } else if (detail !== undefined) {
      console.log(detail);
    }
  }

  function logKakaoError(label, detail) {
    console.error(`[TransitON:Kakao] ${label}`);

    if (detail instanceof Error) {
      const info = formatErrorForLog(detail);
      console.error("message:", info?.message ?? "(empty)");
      console.error("name:", info?.name ?? "Error");
      if (info?.code) console.error("code:", info.code);
      if (info?.location) console.error("location:", info.location);
      if (info?.bootstrapStep) console.error("bootstrapStep:", info.bootstrapStep);
      if (info?.sdkUrl) console.error("sdkUrl:", info.sdkUrl);
      if (detail.stack) console.error("stack:\n" + detail.stack);
      if (info?.cause) console.error("cause:", info.cause);
      return;
    }

    if (typeof detail === "object" && detail !== null) {
      Object.entries(detail).forEach(([key, val]) => {
        if (val instanceof Error) {
          console.error(`${key}.message:`, val.message);
          console.error(`${key}.name:`, val.name);
          if (val.stack) console.error(`${key}.stack:\n` + val.stack);
          if (val.cause) console.error(`${key}.cause:`, formatErrorForLog(val.cause));
        } else {
          console.error(`${key}:`, val);
        }
      });
      return;
    }

    console.error(String(detail ?? ""));
  }

  function makeKakaoError(message, location, extra = {}) {
    const err = new Error(message);
    err.location = location;
    Object.assign(err, extra);
    return err;
  }

  function buildKakaoDomainHelp() {
    const origin = location.origin;
    return [
      `현재 접속 주소: ${origin}`,
      "카카오 Developers → 내 애플리케이션 → JavaScript 키 → Web → 사이트 도메인에 아래 주소를 등록:",
      `  ${origin}`,
      "※ https:// 포함, 끝에 / 없이 입력",
      "※ Vercel Preview URL(*-git-*.vercel.app)은 production과 다르면 별도 등록 필요",
      "※ 등록 후 콘솔 저장 → 1~2분 대기 → 새로고침",
    ].join("\n");
  }

  function getKakaoSdkNetworkEntries() {
    return performance
      .getEntriesByType("resource")
      .filter((e) => e.name.includes("dapi.kakao.com") && e.name.includes("sdk.js"))
      .map((e) => ({
        url: e.name,
        initiatorType: e.initiatorType,
        durationMs: Math.round(e.duration),
        transferSize: e.transferSize,
        encodedBodySize: e.encodedBodySize,
        decodedBodySize: e.decodedBodySize,
        responseStatus: e.responseStatus || 0,
        startTime: Math.round(e.startTime),
      }));
  }

  function getHtmlSdkScriptInfo() {
    const tag = findKakaoSdkScriptTag();
    if (!tag?.src) return { found: false };
    let parsed;
    try {
      parsed = new URL(tag.src);
    } catch {
      return { found: true, src: tag.src, parseError: true };
    }
    const htmlAppkey = parsed.searchParams.get("appkey");
    return {
      found: true,
      src: tag.src,
      htmlAppkey,
      libraries: parsed.searchParams.get("libraries"),
      autoload: parsed.searchParams.get("autoload"),
      appkeyMatchesJs: htmlAppkey === KAKAO_APP_KEY,
      readyState: tag.readyState,
    };
  }

  function logKakaoSdkConfig(context) {
    const htmlInfo = getHtmlSdkScriptInfo();
    const config = {
      context,
      sdkUrl: KAKAO_SDK_URL,
      appkey: KAKAO_APP_KEY,
      appkeyPrefix: `${KAKAO_APP_KEY.slice(0, 8)}…${KAKAO_APP_KEY.slice(-4)}`,
      appkeyLength: KAKAO_APP_KEY.length,
      origin: location.origin,
      href: location.href,
      referrer: document.referrer || "(none)",
      userAgent: navigator.userAgent,
      htmlSdkScript: htmlInfo,
      allKakaoScriptTags: [...document.scripts]
        .filter((s) => s.src?.includes("dapi.kakao.com"))
        .map((s) => s.src),
      pageCspMeta: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || null,
    };
    logKakao("SDK 설정", config);
    console.info("[TransitON:Kakao] SDK URL:", KAKAO_SDK_URL);
    console.info("[TransitON:Kakao] appkey:", KAKAO_APP_KEY);
    return config;
  }

  function classifyKakaoProbe(probeJson, probeHttpStatus, probeBodyPreview) {
    const msg = probeJson?.message || probeBodyPreview || "";
    if (/domain mismatched/i.test(msg)) {
      return {
        failureKind: "DOMAIN_MISMATCH",
        summary: `Web 도메인 미등록/불일치 — ${msg}`,
        help: buildKakaoDomainHelp(),
      };
    }
    if (/wrong appKey|appkey|app key/i.test(msg)) {
      return {
        failureKind: "INVALID_APPKEY",
        summary: `JavaScript appkey 오류 — ${msg}`,
        help: "카카오 Developers → JavaScript 키가 코드의 appkey와 동일한지 확인하세요.",
      };
    }
    if (probeHttpStatus === 403 || probeHttpStatus === 404) {
      return {
        failureKind: "ACCESS_DENIED",
        summary: `카카오 API 거부 (HTTP ${probeHttpStatus}) — ${msg || "본문 없음"}`,
        help: buildKakaoDomainHelp(),
      };
    }
    if (probeHttpStatus >= 500) {
      return { failureKind: "KAKAO_SERVER_ERROR", summary: `카카오 서버 오류 HTTP ${probeHttpStatus}` };
    }
    return null;
  }

  async function diagnoseKakaoSdkScriptFailure(sdkUrl, event, scriptEl) {
    const htmlInfo = getHtmlSdkScriptInfo();
    const networkEntries = getKakaoSdkNetworkEntries();
    const diagnosis = {
      sdkUrl,
      appkey: KAKAO_APP_KEY,
      origin: location.origin,
      href: location.href,
      eventType: event?.type || null,
      scriptSrc: scriptEl?.src || null,
      htmlSdkScript: htmlInfo,
      networkEntries,
      lastCspViolation: lastKakaoCspViolation,
      pageCspMeta: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || null,
      probeHttpStatus: null,
      probeOk: null,
      probeJson: null,
      probeBodyPreview: null,
      probeFetchError: null,
      failureKind: "UNKNOWN",
      summary: "SDK script.onerror — 원인 분류 중",
    };

    if (htmlInfo.found && htmlInfo.appkeyMatchesJs === false) {
      diagnosis.failureKind = "APPKEY_MISMATCH";
      diagnosis.summary = "index.html SDK appkey와 script.js KAKAO_APP_KEY 불일치";
      diagnosis.help =
        `HTML appkey: ${htmlInfo.htmlAppkey}\nJS appkey: ${KAKAO_APP_KEY}\n두 값을 동일한 JavaScript 키로 맞추세요.`;
      return diagnosis;
    }

    if (lastKakaoCspViolation) {
      diagnosis.failureKind = "CSP_BLOCKED";
      diagnosis.summary = `CSP가 Kakao SDK 로드를 차단 — ${lastKakaoCspViolation.violatedDirective}`;
      diagnosis.help = `차단 URI: ${lastKakaoCspViolation.blockedURI}\nscript-src에 https://dapi.kakao.com 허용 필요`;
      return diagnosis;
    }

    try {
      const res = await fetch(sdkUrl, { method: "GET", cache: "no-store", credentials: "omit" });
      diagnosis.probeHttpStatus = res.status;
      diagnosis.probeOk = res.ok;
      const text = await res.text();
      diagnosis.probeBodyPreview = text.slice(0, 400);
      try {
        diagnosis.probeJson = JSON.parse(text);
      } catch {
        /* JS 본문이면 정상 SDK */
      }
      const classified = classifyKakaoProbe(diagnosis.probeJson, res.status, text);
      if (classified) {
        Object.assign(diagnosis, classified);
        return diagnosis;
      }
      if (res.ok && text.includes("kakao")) {
        diagnosis.failureKind = "SCRIPT_EXECUTION";
        diagnosis.summary =
          "fetch로 SDK 본문은 수신됐으나 script 태그 실행 실패 — CSP/adblock/중복 로드 확인";
      }
    } catch (fetchErr) {
      diagnosis.probeFetchError = fetchErr?.message || String(fetchErr);
      if (/failed to fetch|cors|network/i.test(diagnosis.probeFetchError)) {
        diagnosis.probeNote =
          "fetch probe CORS/네트워크 실패 (script 태그와 fetch 정책이 다를 수 있음) — Network 탭 확인";
      }
    }

    const lastNet = networkEntries[networkEntries.length - 1];
    if (lastNet) {
      diagnosis.network = lastNet;
      if (lastNet.responseStatus === 404 || lastNet.responseStatus === 403) {
        if (diagnosis.failureKind === "UNKNOWN") {
          diagnosis.failureKind = "NETWORK_HTTP_ERROR";
          diagnosis.summary = `Network: sdk.js HTTP ${lastNet.responseStatus} (도메인/appkey 거부 가능)`;
          diagnosis.help = buildKakaoDomainHelp();
        }
      } else if (lastNet.transferSize === 0 && lastNet.responseStatus === 0) {
        if (diagnosis.failureKind === "UNKNOWN") {
          diagnosis.failureKind = "NETWORK_BLOCKED";
          diagnosis.summary =
            "Network: transferSize=0 — CSP/adblock/오프라인/확장 프로그램 차단 가능";
        }
      }
    } else if (diagnosis.failureKind === "UNKNOWN") {
      diagnosis.failureKind = "NO_NETWORK_ENTRY";
      diagnosis.summary = "Performance API에 sdk.js 요청 기록 없음 — 차단 또는 요청 미발생";
    }

    if (diagnosis.failureKind === "UNKNOWN") {
      diagnosis.summary = "SDK script.onerror — Network 탭에서 sdk.js 상태 코드 확인 필요";
      diagnosis.help = buildKakaoDomainHelp();
    }

    return diagnosis;
  }

  async function handleKakaoScriptLoadError(reject, at, sdkUrl, event, scriptEl) {
    logKakaoSdkConfig(`script.onerror @ ${at}`);

    const diagnosis = await diagnoseKakaoSdkScriptFailure(sdkUrl, event, scriptEl);

    console.group("[TransitON:Kakao] SDK script.onerror — Network/진단");
    console.error("location:", at);
    console.error("failureKind:", diagnosis.failureKind);
    console.error("summary:", diagnosis.summary);
    console.error("sdkUrl:", sdkUrl);
    console.error("appkey:", KAKAO_APP_KEY);
    if (diagnosis.network) console.error("network (Performance):", diagnosis.network);
    if (diagnosis.networkEntries?.length) console.error("networkEntries:", diagnosis.networkEntries);
    if (diagnosis.probeHttpStatus != null) console.error("probeHttpStatus:", diagnosis.probeHttpStatus);
    if (diagnosis.probeJson) console.error("probeJson:", diagnosis.probeJson);
    if (diagnosis.probeBodyPreview) console.error("probeBodyPreview:", diagnosis.probeBodyPreview);
    if (diagnosis.probeFetchError) console.error("probeFetchError:", diagnosis.probeFetchError);
    if (diagnosis.lastCspViolation) console.error("cspViolation:", diagnosis.lastCspViolation);
    if (diagnosis.help) console.error("help:\n" + diagnosis.help);
    console.groupEnd();

    reject(
      makeKakaoError(diagnosis.summary, at, {
        code: diagnosis.failureKind,
        sdkUrl,
        appkey: KAKAO_APP_KEY,
        hostname: location.hostname,
        origin: location.origin,
        protocol: location.protocol,
        eventType: event?.type,
        help: diagnosis.help,
        diagnosis,
        network: diagnosis.network,
        probeHttpStatus: diagnosis.probeHttpStatus,
        probeJson: diagnosis.probeJson,
        failureKind: diagnosis.failureKind,
      })
    );
  }

  function showKakaoBootstrapError(err) {
    const message = err?.message || "알 수 없는 오류";
    const at = err?.location ? ` @ ${err.location}` : "";
    const full = `${message}${at}`;

    logKakaoError("부트스트랩 실패 (상세)", err instanceof Error ? err : { message: full, raw: err });
    if (err?.failureKind) console.error("failureKind:", err.failureKind);
    if (err?.diagnosis) console.error("diagnosis:", err.diagnosis);
    if (err?.network) console.error("network:", err.network);
    if (err?.probeJson) console.error("probeJson:", err.probeJson);
    if (err?.appkey) console.error("appkey:", err.appkey);
    if (err?.sdkUrl) console.error("sdkUrl:", err.sdkUrl);
    if (err?.help) console.error("help:\n" + err.help);
    if (err?.origin) console.error("등록 필요 도메인:", err.origin);

    const banner = document.getElementById("kakao-error-banner");
    if (banner) {
      banner.hidden = false;
      const help =
        err?.help ||
        (err?.code === "KAKAO_SCRIPT_ERROR" ||
        err?.code === "KAKAO_DOMAIN_MISMATCH" ||
        err?.failureKind === "DOMAIN_MISMATCH"
          ? buildKakaoDomainHelp()
          : "");
      const kindLine = err?.failureKind ? `[${err.failureKind}] ` : "";
      banner.textContent = help
        ? `카카오맵 초기화 실패\n${kindLine}${message}\n\n${help}`
        : `카카오맵 초기화 실패: ${kindLine}${full}`;
    }

    if (mapLocationLabel) {
      mapLocationLabel.textContent = `카카오맵 · Web 도메인 등록 필요 (${window.location.origin})`;
    }

    showToast(`카카오맵: Web 도메인 ${window.location.origin} 등록 확인`);
  }

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
    nearbyStops: { bus: [], subway: [] },
    routeInfo: null,
    recentSearches: JSON.parse(localStorage.getItem("transiton-recent") || "[]"),
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
    if (viewName === "realtime") renderUnavailableRealtime();
    if (viewName === "golden") renderUnavailableGolden();
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
        } else if (locationState.destination) {
          computeRoute();
        }
      }

      showView(target);
    });
  });

  function updateRouteSummary() {
    const from = shortLabel(locationState.current.label);
    const to = locationState.destination?.name || state.destination;
    if (routeSummaryLabel) routeSummaryLabel.textContent = `${from} → ${to}`;
    if (routeMapLabel) routeMapLabel.textContent = `${from} → ${to}`;
  }

  function updateOriginField() {
    if (!originInput) return;
    const prefix = locationState.current.source === "gps" ? "현재 위치" : "기본 위치";
    originInput.value = `${prefix} · ${shortLabel(locationState.current.label)}`;
  }

  function shortLabel(text) {
    if (!text) return MAP_CENTER.label;
    return text.length > 22 ? `${text.slice(0, 22)}…` : text;
  }

  /* ---- Utilities ---- */

  function haversineM(a, b) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  function walkMinutes(meters) {
    return Math.max(1, Math.ceil(meters / WALK_SPEED / 60));
  }

  function formatDistance(m) {
    if (m < 1000) return `${Math.round(m)}m`;
    return `${(m / 1000).toFixed(1)}km`;
  }

  function formatDuration(min) {
    if (min < 60) return `${min}분`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h}시간 ${m}분` : `${h}시간`;
  }

  function estimateFare(meters) {
    return Math.min(2050, 1500 + Math.floor(meters / 5000) * 50);
  }

  async function whenKakaoReady() {
    try {
      await kakaoReady;
    } catch (err) {
      if (err instanceof Error) throw err;
      throw makeKakaoError(String(err), "script.js:whenKakaoReady:reject");
    }
    if (!kakaoServicesReady) {
      if (kakaoBootstrapError instanceof Error) throw kakaoBootstrapError;
      throw makeKakaoError("KAKAO_NOT_READY", "script.js:whenKakaoReady:services", { code: "KAKAO_NOT_READY" });
    }
  }

  function ensureKakaoServices(context) {
    const diag = {
      context,
      hostname: location.hostname,
      protocol: location.protocol,
      kakaoServicesReady,
      hasWindowKakao: !!window.kakao,
      hasMaps: !!window.kakao?.maps,
      hasServices: !!window.kakao?.maps?.services,
      hasPlacesCtor: typeof window.kakao?.maps?.services?.Places === "function",
      placesInstance: !!places,
      geocoderInstance: !!geocoder,
    };

    if (!kakaoServicesReady || !places || !geocoder || !window.kakao?.maps?.services) {
      logKakaoError("서비스 미준비", diag);
      const err = new Error("KAKAO_NOT_READY");
      err.code = "KAKAO_NOT_READY";
      err.diag = diag;
      throw err;
    }
  }

  function isValidCoord(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng);
  }

  let toastTimer;
  function showToast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.add("toast--visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("toast--visible"), 2500);
  }

  function renderPlaceholderCard(title, message) {
    return `
      <article class="realtime-card">
        <header class="realtime-card__head">
          <div><h3>${title}</h3><p>카카오맵 기반 UI</p></div>
        </header>
        <div class="info-banner" style="margin:0;border-radius:0">
          <p>${message}</p>
        </div>
      </article>`;
  }

  /* ---- Unavailable features (no public API) ---- */

  function renderUnavailableRealtime() {
    const statusEl = document.getElementById("api-status");
    if (statusEl) {
      statusEl.textContent = "실시간 도착 정보 — 공공데이터 API 연동 예정";
      statusEl.classList.add("api-status--warn");
    }
    const busList = document.getElementById("bus-list");
    const subwayList = document.getElementById("subway-list");
    if (busList) {
      busList.innerHTML = renderPlaceholderCard("실시간 버스 도착", UNAVAILABLE_MSG);
    }
    if (subwayList) {
      subwayList.innerHTML = renderPlaceholderCard("실시간 지하철 도착", UNAVAILABLE_MSG);
    }
  }

  function renderUnavailableGolden() {
    const goldenTime = document.getElementById("golden-time");
    const goldenDepartEm = document.getElementById("golden-depart-em");
    const goldenDest = document.getElementById("golden-destination");
    if (goldenTime) goldenTime.textContent = "--:--";
    if (goldenDepartEm) goldenDepartEm.textContent = "연동 예정";
    if (goldenDest) goldenDest.textContent = locationState.destination?.name || state.destination;

    const schedule = document.getElementById("golden-schedule");
    if (schedule) {
      schedule.innerHTML = `
        <div class="info-banner">
          <p>${UNAVAILABLE_MSG}<br>막차·골든타임은 Humetro 운행정보 API 연동 후 제공됩니다.</p>
        </div>`;
    }

    const gRouteTime = document.getElementById("golden-route-time");
    const gRouteMode = document.getElementById("golden-route-mode");
    const gRoutePath = document.getElementById("golden-route-path");
    if (gRouteTime) gRouteTime.textContent = state.routeInfo ? `약 ${state.routeInfo.durationMin}분` : "경로 검색 필요";
    if (gRouteMode) gRouteMode.textContent = "막차 API 예정";
    if (gRoutePath) {
      gRoutePath.textContent = state.routeInfo
        ? `${shortLabel(locationState.current.label)} → ${state.destination}`
        : "목적지를 검색해 주세요";
    }
  }

  document.getElementById("refresh-realtime")?.addEventListener("click", () => {
    renderUnavailableRealtime();
    showToast("실시간 정보는 공공데이터 API 연동 후 제공됩니다");
  });

  /* ---- Nearby stops (Kakao Places) ---- */

  function searchNearbyCategory(code, radius) {
    return new Promise((resolve) => {
      if (!places) {
        resolve([]);
        return;
      }
      places.categorySearch(
        code,
        (data, status) => {
          if (status !== kakao.maps.services.Status.OK) {
            resolve([]);
            return;
          }
          resolve(
            data.map((item) => ({
              name: item.place_name,
              address: item.road_address_name || item.address_name || "",
              lat: parseFloat(item.y),
              lng: parseFloat(item.x),
              distance: parseInt(item.distance, 10) || haversineM(locationState.current, {
                lat: parseFloat(item.y),
                lng: parseFloat(item.x),
              }),
              type: code === "SW8" ? "subway" : "bus",
            }))
          );
        },
        { location: toLatLng(locationState.current), radius }
      );
    });
  }

  function searchNearbyKeyword(keyword, radius) {
    return new Promise((resolve) => {
      if (!places) {
        resolve([]);
        return;
      }
      places.keywordSearch(
        keyword,
        (data, status) => {
          if (status !== kakao.maps.services.Status.OK) {
            resolve([]);
            return;
          }
          resolve(
            data.slice(0, 5).map((item) => ({
              name: item.place_name,
              address: item.road_address_name || item.address_name || "",
              lat: parseFloat(item.y),
              lng: parseFloat(item.x),
              distance: parseInt(item.distance, 10) || haversineM(locationState.current, {
                lat: parseFloat(item.y),
                lng: parseFloat(item.x),
              }),
              type: "bus",
            }))
          );
        },
        { location: toLatLng(locationState.current), radius }
      );
    });
  }

  async function loadNearbyStops() {
    try {
      await whenKakaoReady();
      const [subway, busKeyword] = await Promise.all([
        searchNearbyCategory("SW8", 2000),
        searchNearbyKeyword("버스정류장", 1500),
      ]);

      state.nearbyStops.subway = subway.slice(0, 3);
      state.nearbyStops.bus = busKeyword.slice(0, 3);
      renderNearbyList();
      updateMapRoute();
    } catch (err) {
      logKakaoError("주변 정류장 로드 실패", err instanceof Error ? err : new Error(String(err)));
      const container = document.getElementById("nearby-list");
      if (container) {
        container.innerHTML = `<p class="loading-text">카카오맵 준비 후 주변 정류장을 표시합니다.</p>`;
      }
    }
  }

  function renderNearbyList() {
    const container = document.getElementById("nearby-list");
    if (!container) return;

    const { bus, subway } = state.nearbyStops;
    if (!bus.length && !subway.length) {
      container.innerHTML = `<p class="loading-text">주변 정류장·역 정보를 찾지 못했습니다.</p>`;
      return;
    }

    const cards = [];

    bus.forEach((stop) => {
      cards.push(`
        <article class="nearby-card">
          <div class="nearby-card__icon nearby-card__icon--bus">🚌</div>
          <div class="nearby-card__body">
            <h3>${stop.name}</h3>
            <p>${formatDistance(stop.distance)} · ${shortLabel(stop.address)}</p>
          </div>
          <span class="badge">근처</span>
        </article>`);
    });

    subway.forEach((stop) => {
      cards.push(`
        <article class="nearby-card">
          <div class="nearby-card__icon nearby-card__icon--subway">🚇</div>
          <div class="nearby-card__body">
            <h3>${stop.name}</h3>
            <p>${formatDistance(stop.distance)} · ${shortLabel(stop.address)}</p>
          </div>
          <span class="badge">근처</span>
        </article>`);
    });

    container.innerHTML = cards.join("");
  }

  function addNearbyMarkersToHomeMap() {
    if (!kakaoMap) return;
    const all = [...state.nearbyStops.bus, ...state.nearbyStops.subway];
    all.forEach((stop) => {
      const marker = new kakao.maps.Marker({
        map: kakaoMap,
        position: toLatLng(stop),
        opacity: 0.75,
      });
      mapLayers.home.markers.push(marker);
    });
  }

  /* ---- Route (Kakao Directions or estimate) ---- */

  function requestDrivingRoute(origin, destination) {
    return new Promise((resolve) => {
      if (!directions || !kakao.maps.services?.Directions) {
        resolve(null);
        return;
      }
      try {
        directions.route(
          {
            origin: toLatLng(origin),
            destination: toLatLng(destination),
            priority: kakao.maps.services.RoutePriority?.RECOMMEND,
          },
          (result, status) => {
            if (status !== kakao.maps.services.Status.OK || !result?.routes?.length) {
              resolve(null);
              return;
            }
            const route = result.routes[0];
            const path = [];
            route.sections?.forEach((section) => {
              section.roads?.forEach((road) => {
                road.vertexes?.forEach((v, i) => {
                  if (i % 2 === 0 && road.vertexes[i + 1] !== undefined) {
                    path.push(new kakao.maps.LatLng(road.vertexes[i + 1], road.vertexes[i]));
                  }
                });
              });
            });
            resolve({
              distance: route.summary?.distance || haversineM(origin, destination),
              durationSec: route.summary?.duration || 0,
              path: path.length ? path : [toLatLng(origin), toLatLng(destination)],
            });
          }
        );
      } catch {
        resolve(null);
      }
    });
  }

  async function computeRoute() {
    if (!locationState.destination) return;

    const origin = locationState.current;
    const dest = locationState.destination;
    const straightDist = haversineM(origin, dest);

    let routePath = null;
    let distance = straightDist;
    let durationMin = Math.max(5, Math.ceil(straightDist / 400));

    try {
      await whenKakaoReady();
      if (window.kakao?.maps?.LatLng) {
        routePath = [toLatLng(origin), toLatLng(dest)];
      }
      const driving = await requestDrivingRoute(origin, dest);
      if (driving?.path?.length) {
        routePath = driving.path;
        distance = driving.distance || straightDist;
        durationMin = driving.durationSec
          ? Math.ceil(driving.durationSec / 60)
          : Math.max(5, Math.ceil(distance / 400));
      }
    } catch (err) {
      console.warn("경로 계산 보조 실패 — 직선 거리로 표시:", err);
      if (window.kakao?.maps?.LatLng) {
        routePath = [toLatLng(origin), toLatLng(dest)];
      }
    }

    const fare = estimateFare(distance);
    const arrival = new Date(Date.now() + durationMin * 60000);

    state.routeInfo = {
      distance,
      durationMin,
      fare,
      arrivalTime: `${String(arrival.getHours()).padStart(2, "0")}:${String(arrival.getMinutes()).padStart(2, "0")}`,
      path: routePath,
      originLabel: shortLabel(origin.label),
      destName: dest.name,
    };

    renderRouteResult();
    updateMapRoute();
    updateHomeRoutePreview();
  }

  function renderRouteResult() {
    const info = state.routeInfo;
    if (!info) return;

    const stats = document.querySelectorAll(".summary-stat__value");
    if (stats.length >= 3) {
      stats[0].textContent = formatDuration(info.durationMin);
      stats[1].textContent = `${info.fare.toLocaleString()}원`;
      stats[2].textContent = info.arrivalTime;
    }

    document.querySelectorAll(".route-option__time").forEach((el, i) => {
      const variants = [
        { min: info.durationMin, detail: `직선 ${formatDistance(info.distance)} · 추정` },
        { min: Math.max(3, info.durationMin - 4), detail: "빠른 경로 · 추정" },
        { min: info.durationMin + 8, detail: "여유 경로 · 추정" },
      ];
      const v = variants[i] || variants[0];
      el.textContent = formatDuration(v.min);
      const detail = el.parentElement?.querySelector(".route-option__detail");
      if (detail) detail.textContent = v.detail;
    });

    const timeline = document.querySelector(".timeline");
    if (timeline) {
      timeline.innerHTML = `
        <li class="timeline__item">
          <div class="timeline__dot timeline__dot--walk"></div>
          <div class="timeline__content">
            <strong>출발</strong>
            <p>${info.originLabel}</p>
          </div>
        </li>
        <li class="timeline__item">
          <div class="timeline__dot timeline__dot--subway line-2"></div>
          <div class="timeline__content">
            <strong>이동 ${formatDuration(info.durationMin)}</strong>
            <p>${formatDistance(info.distance)} · 카카오맵 경로 기준 추정</p>
            <span class="timeline__chip">대중교통 상세는 API 연동 예정</span>
          </div>
        </li>
        <li class="timeline__item">
          <div class="timeline__dot timeline__dot--walk"></div>
          <div class="timeline__content">
            <strong>도착 ${info.arrivalTime}</strong>
            <p>${info.destName}</p>
          </div>
        </li>`;
    }

    const banner = document.getElementById("route-info-banner");
    if (banner) {
      banner.textContent =
        "카카오맵 경로·거리 기반 추정입니다. 실시간 버스·지하철 환승 정보는 공공데이터 API 연동 후 제공됩니다.";
    }
  }

  function updateHomeRoutePreview() {
    const info = state.routeInfo;
    const homeTime = document.getElementById("home-route-time");
    const homeMode = document.getElementById("home-route-mode");
    const homePath = document.getElementById("home-route-path");
    if (!info) return;
    if (homeTime) homeTime.textContent = `약 ${formatDuration(info.durationMin)}`;
    if (homeMode) homeMode.textContent = formatDistance(info.distance);
    if (homePath) {
      homePath.textContent = `${info.originLabel} → ${info.destName}`;
    }
  }

  /* ---- Search & Geocoding (Kakao Places + Geocoder) ---- */

  function hideAutocomplete() {
    if (placeAutocomplete) {
      placeAutocomplete.hidden = true;
      placeAutocomplete.innerHTML = "";
    }
  }

  function parseGeocodeItem(item, fallbackName) {
    const lat = parseFloat(item.y);
    const lng = parseFloat(item.x);
    if (!isValidCoord(lat, lng)) return null;
    return {
      lat,
      lng,
      name: fallbackName,
      address: item.address_name || item.road_address?.address_name || fallbackName,
    };
  }

  function parsePlaceItem(item) {
    const lat = parseFloat(item.y);
    const lng = parseFloat(item.x);
    if (!isValidCoord(lat, lng)) return null;
    return {
      lat,
      lng,
      name: item.place_name,
      address: item.road_address_name || item.address_name || item.place_name,
    };
  }

  /** Kakao Places keywordSearch — 결과 배열 반환 (실패 시 reject) */
  function placesKeywordSearch(keyword, options) {
    return new Promise((resolve, reject) => {
      try {
        ensureKakaoServices("placesKeywordSearch");
      } catch (err) {
        reject(err);
        return;
      }

      logKakao("keywordSearch 요청", { keyword, options: options ?? "none" });

      const callback = (data, status) => {
        logKakao("keywordSearch 응답", {
          keyword,
          status,
          count: data?.length ?? 0,
        });

        if (status === kakao.maps.services.Status.OK && data?.length) {
          const parsed = data.map(parsePlaceItem).filter(Boolean);
          if (parsed.length) resolve(parsed);
          else reject(new Error("INVALID_COORDS"));
        } else {
          reject(new Error(`PLACES_${status}`));
        }
      };

      if (options) {
        places.keywordSearch(keyword, callback, options);
      } else {
        places.keywordSearch(keyword, callback);
      }
    });
  }

  function geocoderAddressSearch(keyword) {
    return new Promise((resolve, reject) => {
      try {
        ensureKakaoServices("geocoderAddressSearch");
      } catch (err) {
        reject(err);
        return;
      }

      logKakao("addressSearch 요청", { keyword });

      geocoder.addressSearch(keyword, (result, status) => {
        logKakao("addressSearch 응답", { keyword, status, count: result?.length ?? 0 });

        if (status === kakao.maps.services.Status.OK && result?.length) {
          const parsed = parseGeocodeItem(result[0], keyword);
          if (parsed) resolve(parsed);
          else reject(new Error("INVALID_COORDS"));
        } else {
          reject(new Error(`GEOCODER_${status}`));
        }
      });
    });
  }

  /**
   * 목적지 검색: Places 우선 → Geocoder 보조
   * 첫 번째 유효 결과 반환
   */
  async function geocodeDestination(keyword) {
    await whenKakaoReady();
    ensureKakaoServices();

    const queries = [...new Set([keyword, `부산 ${keyword}`, `${keyword} 부산`])];
    const busanCenter = toLatLng(MAP_CENTER);

    // 1) Places — 전국 검색 (옵션 없음)
    for (const query of queries) {
      try {
        const results = await placesKeywordSearch(query);
        return results[0];
      } catch (err) {
        console.warn(`[TransitON:Kakao] Places 전국 실패 (${query}):`, err.message);
      }
    }

    // 2) Places — 부산 중심 반경 검색 (radius 최대 20km)
    for (const query of queries) {
      try {
        const results = await placesKeywordSearch(query, {
          location: busanCenter,
          radius: PLACES_MAX_RADIUS,
        });
        return results[0];
      } catch (err) {
        console.warn(`[TransitON:Kakao] Places 부산 실패 (${query}):`, err.message);
      }
    }

    // 3) Places — 현재 위치 기준 반경 검색
    for (const query of queries) {
      try {
        const results = await placesKeywordSearch(query, {
          location: toLatLng(locationState.current),
          radius: PLACES_MAX_RADIUS,
        });
        return results[0];
      } catch (err) {
        console.warn(`[TransitON:Kakao] Places 현위치 실패 (${query}):`, err.message);
      }
    }

    // 4) Geocoder — 주소 검색
    for (const query of queries) {
      try {
        return await geocoderAddressSearch(query);
      } catch (err) {
        console.warn(`[TransitON:Kakao] Geocoder 실패 (${query}):`, err.message);
      }
    }

    const err = new Error("NOT_FOUND");
    err.code = "NOT_FOUND";
    throw err;
  }

  function saveRecentSearch(name) {
    state.recentSearches = [name, ...state.recentSearches.filter((s) => s !== name)].slice(0, 8);
    localStorage.setItem("transiton-recent", JSON.stringify(state.recentSearches));
  }

  function showAutocompleteResults(items) {
    if (!placeAutocomplete || !items.length) {
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
        saveRecentSearch(item.name);
        updateRouteSummary();
        updateMapRoute();
        await computeRoute();
        showToast(`${item.name}(으)로 설정했습니다`);
      });
    });
  }

  function fetchAutocomplete(keyword) {
    if (!keyword || keyword.length < 2) {
      hideAutocomplete();
      return;
    }
    whenKakaoReady()
      .then(() => {
        ensureKakaoServices("fetchAutocomplete");
        return placesKeywordSearch(keyword, {
          location: toLatLng(locationState.current),
          radius: PLACES_MAX_RADIUS,
        });
      })
      .then((results) => showAutocompleteResults(results))
      .catch((err) => {
        logKakaoError("자동완성 실패", err instanceof Error ? err : new Error(String(err)));
        hideAutocomplete();
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

    let dest;
    try {
      if (!silent) showToast("목적지를 검색 중…");
      dest = await geocodeDestination(query);
    } catch (err) {
      logKakaoError("목적지 검색 실패", err instanceof Error ? err : new Error(String(err)));
      if (!silent) {
        if (err.code === "KAKAO_NOT_READY") {
          showToast(`카카오맵 준비 실패 (${location.hostname}) — F12 콘솔 확인`);
        } else {
          showToast("목적지를 찾을 수 없습니다");
        }
      }
      return false;
    }

    locationState.destination = dest;
    state.destination = dest.name;
    if (destinationInput) destinationInput.value = dest.name;
    hideAutocomplete();
    saveRecentSearch(dest.name);
    updateRouteSummary();
    updateMapRoute();

    try {
      await computeRoute();
    } catch (routeErr) {
      console.warn("[경로 계산]", routeErr);
    }

    if (!silent) showToast(`${dest.name}(으)로 경로를 설정했습니다`);
    if (navigate) showView("routes");
    return true;
  }

  document.querySelectorAll(".suggestion-item").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (destinationInput) destinationInput.value = btn.dataset.dest;
      await setDestination(btn.dataset.dest);
    });
  });

  document.getElementById("clear-search")?.addEventListener("click", () => {
    if (destinationInput) destinationInput.value = "";
    locationState.destination = null;
    state.routeInfo = null;
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
    autocompleteTimer = setTimeout(() => fetchAutocomplete(destinationInput.value.trim()), 300);
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

  /* ---- Tabs & misc UI ---- */

  document.querySelectorAll("#view-realtime .tab[data-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      const key = tab.dataset.tab;
      document.querySelectorAll("#view-realtime .tab[data-tab]").forEach((t) => {
        t.classList.toggle("tab--active", t === tab);
      });
      document.getElementById("panel-bus")?.classList.toggle("tab-panel--active", key === "bus");
      document.getElementById("panel-subway")?.classList.toggle("tab-panel--active", key === "subway");
    });
  });

  document.querySelectorAll("[data-saved-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      const key = tab.dataset.savedTab;
      document.querySelectorAll("[data-saved-tab]").forEach((t) => t.classList.toggle("tab--active", t === tab));
      document.getElementById("panel-favorites")?.classList.toggle("saved-panel--active", key === "favorites");
      document.getElementById("panel-recent")?.classList.toggle("saved-panel--active", key === "recent");
    });
  });

  document.querySelectorAll(".route-option").forEach((option) => {
    option.addEventListener("click", () => {
      document.querySelectorAll(".route-option").forEach((o) => o.classList.remove("route-option--active"));
      option.classList.add("route-option--active");
    });
  });

  document.getElementById("add-favorite")?.addEventListener("click", () => {
    state.favoriteAdded = !state.favoriteAdded;
    showToast(state.favoriteAdded ? "즐겨찾기 (Supabase 연동 예정)" : "즐겨찾기 해제");
  });

  /* ---- Kakao Map ---- */

  function toLatLng(point) {
    if (!window.kakao?.maps?.LatLng) {
      throw new Error("KAKAO_NOT_READY");
    }
    return new kakao.maps.LatLng(point.lat, point.lng);
  }

  function createMap(containerId, center) {
    const container = document.getElementById(containerId);
    if (!container) return null;
    return new kakao.maps.Map(container, { center: toLatLng(center), level: 3 });
  }

  function clearMapLayer(key) {
    mapLayers[key].markers.forEach((m) => m.setMap(null));
    mapLayers[key].lines.forEach((l) => l.setMap(null));
    mapLayers[key].overlays?.forEach((o) => o.close?.() || o.setMap?.(null));
    mapLayers[key] = { markers: [], lines: [], overlays: [] };
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
      attachInfoWindow(map, startMarker, "출발", shortLabel(locationState.current.label))
    );

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

      const path =
        layerKey === "route" && state.routeInfo?.path?.length
          ? state.routeInfo.path
          : [toLatLng(locationState.current), toLatLng(locationState.destination)];

      const line = new kakao.maps.Polyline({
        map,
        path,
        strokeWeight: 5,
        strokeColor: layerKey === "route" ? "#0064ff" : "#3b82f6",
        strokeOpacity: 0.85,
      });
      mapLayers[layerKey].lines.push(line);

      const bounds = new kakao.maps.LatLngBounds();
      path.forEach((coord) => bounds.extend(coord));
      map.setBounds(bounds, 48, 48, 48, 48);
    } else {
      map.setCenter(toLatLng(locationState.current));
      map.setLevel(3);
    }

    if (layerKey === "home") addNearbyMarkersToHomeMap();
  }

  function updateMapRoute() {
    if (!kakaoMap) return;
    renderMapLayer(kakaoMap, "home");
    if (mapLocationLabel) {
      mapLocationLabel.textContent =
        locationState.current.source === "gps"
          ? `현재 위치 · ${shortLabel(locationState.current.label)}`
          : `기본 위치 · ${shortLabel(locationState.current.label)}`;
    }
    if (routeMap) renderMapLayer(routeMap, "route");
  }

  async function applyCurrentLocation(point, source) {
    locationState.current = { ...point, source };
    updateOriginField();
    updateRouteSummary();
    await loadNearbyStops();
    if (locationState.destination) await computeRoute();
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

  function isKakaoSdkReady() {
    return !!(window.kakao && window.kakao.maps && typeof window.kakao.maps.load === "function");
  }

  function findKakaoSdkScriptTag() {
    return (
      document.querySelector("script[data-transiton-kakao-sdk]") ||
      [...document.scripts].find((s) => s.src && s.src.includes("dapi.kakao.com/v2/maps/sdk.js"))
    );
  }

  function waitForKakaoGlobal(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const at = "script.js:waitForKakaoGlobal";

      (function tick() {
        if (isKakaoSdkReady()) {
          logKakao("window.kakao.maps.load 확인됨", { at });
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          reject(
            makeKakaoError(
              `KAKAO_GLOBAL_TIMEOUT: window.kakao.maps.load 없음 (${timeoutMs}ms)`,
              at,
              { code: "KAKAO_GLOBAL_TIMEOUT", hasKakao: !!window.kakao, hasMaps: !!window.kakao?.maps }
            )
          );
          return;
        }
        setTimeout(tick, 50);
      })();
    });
  }

  function injectKakaoSdkScript() {
    const at = "script.js:injectKakaoSdkScript";

    return new Promise((resolve, reject) => {
      if (isKakaoSdkReady()) {
        logKakao("SDK 이미 로드됨 — inject 생략", { at: `${at}:L1-skip` });
        resolve();
        return;
      }

      const existing = findKakaoSdkScriptTag();
      if (existing) {
        logKakao("기존 SDK script 태그 감지", { at: `${at}:L2-existing`, src: existing.src });

        if (isKakaoSdkReady()) {
          resolve();
          return;
        }

        const onLoad = () => {
          waitForKakaoGlobal()
            .then(resolve)
            .catch((e) => {
              reject(
                makeKakaoError(
                  `SDK onload 후 kakao 객체 대기 실패: ${e.message}`,
                  `${at}:L2-existing→waitForKakaoGlobal`,
                  { code: e.code || "KAKAO_WAIT_FAILED", cause: e, sdkUrl: existing.src }
                )
              );
            });
        };

        const onError = (event) => {
          handleKakaoScriptLoadError(reject, `${at}:L2-existing.onerror`, existing.src, event, existing);
        };

        existing.addEventListener("load", onLoad, { once: true });
        existing.addEventListener("error", onError, { once: true });

        if (existing.readyState === "complete" || existing.readyState === "loaded") {
          if (isKakaoSdkReady()) {
            resolve();
          } else if (window.kakao) {
            onLoad();
          } else {
            handleKakaoScriptLoadError(
              reject,
              `${at}:L2-existing-already-failed`,
              existing.src,
              null,
              existing
            );
          }
        }
        return;
      }

      logKakao("SDK script 태그 동적 추가", { at: `${at}:L3-create`, src: KAKAO_SDK_URL });

      const script = document.createElement("script");
      script.src = KAKAO_SDK_URL;
      script.async = true;
      script.dataset.transitonKakaoSdk = "true";

      script.onload = (event) => {
        logKakao("SDK script onload", { at: `${at}:L3-onload`, src: script.src });
        waitForKakaoGlobal()
          .then(resolve)
          .catch((e) => {
            reject(
              makeKakaoError(
                `SDK onload 후 kakao 객체 대기 실패: ${e.message}`,
                `${at}:L3-onload→waitForKakaoGlobal`,
                { code: e.code || "KAKAO_WAIT_FAILED", cause: e, sdkUrl: script.src, eventType: event?.type }
              )
            );
          });
      };

      script.onerror = (event) => {
        handleKakaoScriptLoadError(reject, `${at}:L3-script.onerror`, KAKAO_SDK_URL, event, script);
      };

      document.head.appendChild(script);
    });
  }

  function initKakaoServicesInsideLoad() {
    const at = "script.js:initKakaoServicesInsideLoad";

    return new Promise((resolve, reject) => {
      if (!isKakaoSdkReady()) {
        reject(makeKakaoError("kakao.maps.load 호출 불가", `${at}:precheck`, { code: "KAKAO_NOT_READY" }));
        return;
      }

      logKakao("kakao.maps.load() 호출", { at: `${at}:L1-call` });

      const loadTimeout = setTimeout(() => {
        reject(
          makeKakaoError(
            "kakao.maps.load 콜백 타임아웃 (10s) — 도메인/키 미등록 가능",
            `${at}:L2-load-timeout`,
            { code: "KAKAO_LOAD_TIMEOUT", hostname: location.hostname }
          )
        );
      }, 10000);

      try {
        kakao.maps.load(function () {
          clearTimeout(loadTimeout);
          const cbAt = `${at}:L3-callback`;

          try {
            logKakao("kakao.maps.load 콜백 진입", {
              at: cbAt,
              hostname: location.hostname,
              hasServices: !!kakao.maps.services,
              hasPlaces: typeof kakao.maps.services?.Places,
              hasGeocoder: typeof kakao.maps.services?.Geocoder,
            });

            if (typeof kakao.maps.services?.Places !== "function") {
              throw makeKakaoError(
                "Places 생성자 없음 — libraries=services 확인",
                `${cbAt}:Places-check`
              );
            }
            if (typeof kakao.maps.services?.Geocoder !== "function") {
              throw makeKakaoError(
                "Geocoder 생성자 없음 — libraries=services 확인",
                `${cbAt}:Geocoder-check`
              );
            }

            geocoder = new kakao.maps.services.Geocoder();
            places = new kakao.maps.services.Places();

            if (!geocoder || !places) {
              throw makeKakaoError("Places/Geocoder 인스턴스 생성 실패", `${cbAt}:instance-check`);
            }

            if (kakao.maps.services.Directions) {
              directions = new kakao.maps.services.Directions();
            }

            kakaoServicesReady = true;
            logKakao("서비스 준비 완료", {
              at: `${cbAt}:success`,
              places: !!places,
              geocoder: !!geocoder,
              directions: !!directions,
            });
            resolve();
          } catch (err) {
            kakaoServicesReady = false;
            const wrapped =
              err instanceof Error
                ? err
                : makeKakaoError(String(err), `${cbAt}:catch`);
            if (!wrapped.location) wrapped.location = `${cbAt}:catch`;
            logKakaoError("kakao.maps.load 콜백 내부 예외", wrapped);
            reject(wrapped);
          }
        });
      } catch (err) {
        clearTimeout(loadTimeout);
        const wrapped = makeKakaoError(
          `kakao.maps.load 동기 예외: ${err?.message || err}`,
          `${at}:L1-sync-throw`,
          { cause: err }
        );
        logKakaoError("kakao.maps.load 동기 예외", wrapped);
        reject(wrapped);
      }
    });
  }

  async function bootstrapKakao() {
    let bootstrapStep = "start";

    try {
      logKakaoSdkConfig("bootstrapKakao:start");
      logKakao("부트스트랩 시작", { hostname: location.hostname, protocol: location.protocol });

      bootstrapStep = "injectKakaoSdkScript";
      await injectKakaoSdkScript();

      bootstrapStep = "initKakaoServicesInsideLoad";
      await initKakaoServicesInsideLoad();

      bootstrapStep = "createMap";
      kakaoMap = createMap("map", locationState.current);
      if (!kakaoMap) {
        throw makeKakaoError("지도 컨테이너(#map) 초기화 실패", "script.js:bootstrapKakao:createMap");
      }
      kakaoMap.relayout();

      bootstrapStep = "done";
      logKakao("부트스트랩 성공", { at: "script.js:bootstrapKakao:done" });

      const banner = document.getElementById("kakao-error-banner");
      if (banner) banner.hidden = true;

      kakaoReadyResolve(true);
      requestCurrentLocation(false);
      setDestination(state.destination, { silent: true });
    } catch (err) {
      kakaoBootstrapError = err instanceof Error ? err : makeKakaoError(String(err), "script.js:bootstrapKakao");
      kakaoBootstrapError.bootstrapStep = bootstrapStep;
      kakaoServicesReady = false;

      showKakaoBootstrapError(kakaoBootstrapError);
      kakaoReadyReject(kakaoBootstrapError);
      updateOriginField();
      requestCurrentLocation(false);
    }
  }

  function initKakaoMap() {
    bootstrapKakao();
  }

  function initRouteMap() {
    if (routeMap || !window.kakao?.maps) return;
    if (!document.getElementById("route-map")) return;
    routeMap = createMap("route-map", locationState.current);
    updateMapRoute();
  }

  function relayoutMap() {
    if (!kakaoMap) return;
    kakaoMap.relayout();
    updateMapRoute();
  }

  function relayoutRouteMap() {
    if (!routeMap) return;
    routeMap.relayout();
    updateMapRoute();
  }

  /* ---- Init ---- */

  updateOriginField();
  updateRouteSummary();
  renderUnavailableRealtime();
  initKakaoMap();
  showView("home");
})();
