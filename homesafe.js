/**
 * TransitON — 귀가안심 (Home Safe)
 * Supabase Realtime + Kakao Map
 */
(function () {
  "use strict";

  const STORAGE_USER = "transiton-homesafe-user";
  const STORAGE_ACTIVE_GROUP = "transiton-homesafe-active-group";

  const STATUS_LABELS = {
    walking: "걷는 중",
    bus: "버스",
    subway: "지하철",
    waiting: "대기",
    home: "도착 완료",
    idle: "대기 중",
  };

  let deps = null;
  let supabase = null;
  let configLoaded = false;
  let user = null;
  let soloMap = null;
  let groupMap = null;
  let soloMarker = null;
  let destMarker = null;
  let routeLine = null;
  let memberMarkers = {};
  let memberLines = {};
  let geoWatchId = null;
  let trackingTimer = null;
  let realtimeChannel = null;
  let activeGroup = null;
  let isTracking = false;
  let trackingDestination = null;
  let friends = [];
  let groups = [];
  let groupTrackings = [];

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function saveJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function toast(msg) {
    deps?.showToast?.(msg);
  }

  function generateCode(prefix) {
    const n = Math.floor(1000 + Math.random() * 9000);
    return `${prefix}-${n}`;
  }

  function statusLabel(status) {
    return STATUS_LABELS[status] || status || "—";
  }

  function formatEta(minutes) {
    if (minutes == null || Number.isNaN(minutes)) return "—";
    if (minutes <= 0) return "곧 도착";
    return `${minutes}분 후 도착`;
  }

  async function loadRemoteConfig() {
    if (configLoaded) return;
    configLoaded = true;
    const local = window.TRANSITON_CONFIG || {};
    if (local.supabaseUrl && local.supabaseAnonKey) return;
    try {
      const res = await fetch("/api/config");
      if (!res.ok) return;
      const data = await res.json();
      if (data.supabaseUrl) local.supabaseUrl = data.supabaseUrl;
      if (data.supabaseAnonKey) local.supabaseAnonKey = data.supabaseAnonKey;
      window.TRANSITON_CONFIG = local;
    } catch {
      /* offline / local dev */
    }
  }

  function initSupabaseClient() {
    const cfg = window.TRANSITON_CONFIG || {};
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || !window.supabase?.createClient) {
      supabase = null;
      return;
    }
    supabase = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  }

  function showConfigBanner(show) {
    const banner = document.getElementById("homesafe-config-banner");
    if (banner) banner.hidden = !show;
  }

  async function ensureUser() {
    let local = loadJson(STORAGE_USER, null);
    if (local?.id && !supabase) {
      user = local;
      return user;
    }

    if (local?.id && supabase) {
      const { data } = await supabase.from("users").select("*").eq("id", local.id).maybeSingle();
      if (data) {
        user = data;
        saveJson(STORAGE_USER, user);
        return user;
      }
    }

    const name = local?.name || "나";
    const inviteCode = local?.invite_code || generateCode("SAFE");

    if (supabase) {
      const { data, error } = await supabase
        .from("users")
        .insert({ name, invite_code: inviteCode, share_consent: false })
        .select("*")
        .single();
      if (error) {
        console.error("[HomeSafe] user create failed", error);
        user = { id: crypto.randomUUID(), name, invite_code: inviteCode, share_consent: false, offline: true };
      } else {
        user = data;
      }
    } else {
      user = {
        id: crypto.randomUUID(),
        name,
        invite_code: inviteCode,
        share_consent: false,
        offline: true,
      };
    }

    saveJson(STORAGE_USER, user);
    return user;
  }

  async function saveUserProfile() {
    if (!user) return;
    saveJson(STORAGE_USER, user);
    if (!supabase || user.offline) return;
    await supabase
      .from("users")
      .update({ name: user.name, share_consent: user.share_consent })
      .eq("id", user.id);
  }

  function renderProfile() {
    const nameInput = document.getElementById("homesafe-user-name");
    const codeEl = document.getElementById("homesafe-my-code");
    const consent = document.getElementById("homesafe-share-consent");
    if (nameInput) nameInput.value = user?.name || "";
    if (codeEl) codeEl.textContent = user?.invite_code || "—";
    if (consent) consent.checked = !!user?.share_consent;
  }

  function switchTab(tabKey) {
    document.querySelectorAll("[data-homesafe-tab]").forEach((tab) => {
      tab.classList.toggle("tab--active", tab.dataset.homesafeTab === tabKey);
    });
    ["solo", "friends", "groups"].forEach((key) => {
      const panel = document.getElementById(`homesafe-panel-${key}`);
      if (panel) panel.hidden = key !== tabKey;
    });
    const dashboard = document.getElementById("homesafe-group-dashboard");
    if (dashboard && tabKey !== "dashboard") dashboard.hidden = true;
  }

  async function geocodeDestination(query) {
    if (deps?.geocodeDestination) {
      return deps.geocodeDestination(query);
    }
    throw new Error("GEOCODE_UNAVAILABLE");
  }

  async function resolveDestination(query) {
    const trimmed = (query || "").trim();
    if (!trimmed) throw new Error("목적지를 입력해 주세요");
    if (deps?.locationState?.destination?.name === trimmed) {
      return deps.locationState.destination;
    }
    return geocodeDestination(trimmed);
  }

  function inferStatus(speedMps, distM) {
    if (distM <= 80) return "home";
    if (speedMps > 2.5) return "bus";
    if (speedMps > 1.8) return "subway";
    if (speedMps > 0.4) return "walking";
    return "waiting";
  }

  async function computeEtaMinutes(from, to) {
    if (deps?.fetchTransitRoute) {
      try {
        const route = await deps.fetchTransitRoute(from, to);
        if (route?.duration_min) return route.duration_min;
      } catch {
        /* fallback below */
      }
    }
    const dist = deps.haversineM(from, to);
    return Math.max(1, Math.ceil(dist / (deps.WALK_SPEED || 1.2) / 60));
  }

  async function upsertTracking(payload) {
    if (!user) return;
    const row = {
      user_id: user.id,
      group_id: activeGroup?.id || null,
      lat: payload.lat,
      lng: payload.lng,
      eta: payload.eta,
      eta_minutes: payload.etaMinutes,
      status: payload.status,
      destination: payload.destination,
      dest_lat: payload.destLat,
      dest_lng: payload.destLng,
      is_active: true,
      updated_at: new Date().toISOString(),
    };

    if (!supabase || user.offline) {
      saveJson("transiton-homesafe-local-tracking", row);
      return;
    }

    const { error } = await supabase.from("safe_tracking").upsert(row);
    if (error) console.error("[HomeSafe] tracking upsert", error);
  }

  async function deactivateTracking() {
    if (!user) return;
    if (supabase && !user.offline) {
      await supabase
        .from("safe_tracking")
        .update({ is_active: false, status: "idle", updated_at: new Date().toISOString() })
        .eq("user_id", user.id);
    }
    localStorage.removeItem("transiton-homesafe-local-tracking");
  }

  function updateSoloUI(tracking) {
    const statusEl = document.getElementById("homesafe-status-label");
    const etaEl = document.getElementById("homesafe-eta-label");
    const destEl = document.getElementById("homesafe-dest-label");
    const metaEl = document.getElementById("homesafe-meta-label");
    if (statusEl) statusEl.textContent = statusLabel(tracking?.status || "idle");
    if (etaEl) etaEl.textContent = tracking?.eta || formatEta(tracking?.eta_minutes);
    if (destEl) {
      destEl.textContent = tracking?.destination
        ? `목적지 · ${tracking.destination}`
        : "목적지를 입력하고 귀가를 시작하세요";
    }
    if (metaEl && tracking?.lat != null && trackingDestination) {
      const dist = deps.haversineM(
        { lat: tracking.lat, lng: tracking.lng },
        { lat: trackingDestination.lat, lng: trackingDestination.lng }
      );
      metaEl.textContent = `남은 ${deps.formatDistance(dist)} · ${formatEta(tracking.eta_minutes)}`;
    } else if (metaEl) {
      metaEl.textContent = "남은 거리 · 시간";
    }
  }

  async function refreshSoloMap(lat, lng) {
    if (!soloMap) return;
    await deps.whenKakaoReady();
    const point = { lat, lng };
    if (!soloMarker) {
      soloMarker = new kakao.maps.Marker({ map: soloMap, position: deps.toLatLng(point), title: "내 위치" });
    } else {
      soloMarker.setPosition(deps.toLatLng(point));
    }
    if (trackingDestination && !destMarker) {
      destMarker = new kakao.maps.Marker({
        map: soloMap,
        position: deps.toLatLng(trackingDestination),
        title: trackingDestination.name,
      });
    }
    if (routeLine) routeLine.setMap(null);
    if (trackingDestination) {
      routeLine = new kakao.maps.Polyline({
        map: soloMap,
        path: [deps.toLatLng(point), deps.toLatLng(trackingDestination)],
        strokeWeight: 5,
        strokeColor: "#6366f1",
        strokeOpacity: 0.85,
      });
      const bounds = new kakao.maps.LatLngBounds();
      bounds.extend(deps.toLatLng(point));
      bounds.extend(deps.toLatLng(trackingDestination));
      soloMap.setBounds(bounds, 48, 48, 48, 48);
    } else {
      soloMap.setCenter(deps.toLatLng(point));
    }
  }

  async function publishLocation(pos) {
    if (!isTracking || !trackingDestination) return;
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const speed = pos.coords.speed != null && pos.coords.speed >= 0 ? pos.coords.speed : 0;
    const distM = deps.haversineM({ lat, lng }, trackingDestination);
    const etaMinutes =
      distM <= 80 ? 0 : await computeEtaMinutes({ lat, lng, label: "현재" }, trackingDestination);
    const status = inferStatus(speed, distM);
    const tracking = {
      lat,
      lng,
      eta: formatEta(etaMinutes),
      eta_minutes: etaMinutes,
      status,
      destination: trackingDestination.name,
      destLat: trackingDestination.lat,
      destLng: trackingDestination.lng,
    };
    await upsertTracking(tracking);
    updateSoloUI(tracking);
    await refreshSoloMap(lat, lng);
    if (status === "home") {
      toast("목적지에 도착했습니다");
      stopTracking(false);
    }
  }

  function startGeoWatch() {
    if (!navigator.geolocation) {
      toast("위치 정보를 사용할 수 없습니다");
      return;
    }
    if (geoWatchId != null) navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = navigator.geolocation.watchPosition(
      (pos) => publishLocation(pos),
      () => toast("위치 권한이 필요합니다"),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
  }

  async function startTracking(options = {}) {
    if (!user?.share_consent && (options.requireConsent !== false)) {
      toast("위치 공유 동의 후 이용할 수 있습니다");
      return;
    }
    const query =
      options.destinationQuery ||
      document.getElementById("homesafe-dest-input")?.value?.trim();
    try {
      trackingDestination = await resolveDestination(query);
    } catch (err) {
      toast(err.message || "목적지를 찾지 못했습니다");
      return;
    }

    if (options.group) {
      activeGroup = options.group;
      saveJson(STORAGE_ACTIVE_GROUP, activeGroup);
    } else if (!options.keepGroup) {
      activeGroup = null;
      localStorage.removeItem(STORAGE_ACTIVE_GROUP);
    }

    isTracking = true;
    document.getElementById("homesafe-start-btn")?.toggleAttribute("hidden", true);
    document.getElementById("homesafe-stop-btn")?.toggleAttribute("hidden", false);
    document.getElementById("homesafe-dest-input")?.setAttribute("readonly", "readonly");

    await initSoloMap();
    startGeoWatch();
    toast(activeGroup ? `"${activeGroup.group_name}" 그룹 귀가 시작` : "귀가안심 모드를 시작했습니다");
  }

  async function stopTracking(manual = true) {
    isTracking = false;
    if (geoWatchId != null) {
      navigator.geolocation.clearWatch(geoWatchId);
      geoWatchId = null;
    }
    await deactivateTracking();
    document.getElementById("homesafe-start-btn")?.toggleAttribute("hidden", false);
    document.getElementById("homesafe-stop-btn")?.toggleAttribute("hidden", true);
    document.getElementById("homesafe-dest-input")?.removeAttribute("readonly");
    updateSoloUI(null);
    if (manual) toast("귀가안심 모드를 종료했습니다");
  }

  async function initSoloMap() {
    await deps.whenKakaoReady();
    if (soloMap) {
      soloMap.relayout();
      return;
    }
    const center = deps.locationState?.current || deps.MAP_CENTER;
    soloMap = deps.createMap("homesafe-map", center);
  }

  async function initGroupMap() {
    await deps.whenKakaoReady();
    if (groupMap) {
      groupMap.relayout();
      return;
    }
    const center = deps.locationState?.current || deps.MAP_CENTER;
    groupMap = deps.createMap("homesafe-group-map", center);
  }

  async function loadFriends() {
    if (!supabase || user?.offline) {
      friends = [];
      renderFriends();
      return;
    }
    const { data: links } = await supabase.from("friends").select("friend_id").eq("user_id", user.id);
    const ids = (links || []).map((l) => l.friend_id);
    if (!ids.length) {
      friends = [];
      renderFriends();
      return;
    }
    const { data } = await supabase.from("users").select("id, name, invite_code").in("id", ids);
    const { data: trackings } = await supabase
      .from("safe_tracking")
      .select("*")
      .in("user_id", ids)
      .eq("is_active", true);
    const trackMap = Object.fromEntries((trackings || []).map((t) => [t.user_id, t]));
    friends = (data || []).map((f) => ({ ...f, tracking: trackMap[f.id] || null }));
    renderFriends();
  }

  function renderFriends() {
    const list = document.getElementById("homesafe-friends-list");
    const empty = document.getElementById("homesafe-friends-empty");
    if (!list) return;
    if (!friends.length) {
      list.innerHTML = "";
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    list.innerHTML = friends
      .map((f) => {
        const t = f.tracking;
        const meta = t?.is_active
          ? `${statusLabel(t.status)} · ${t.eta || formatEta(t.eta_minutes)}`
          : "귀가 중 아님";
        return `
      <li class="homesafe-member-card">
        <div class="homesafe-member-card__avatar">${(f.name || "?").slice(0, 1)}</div>
        <div class="homesafe-member-card__body">
          <strong>${f.name || "친구"}</strong>
          <p>${meta}</p>
        </div>
      </li>`;
      })
      .join("");
  }

  async function addFriendByCode() {
    if (!supabase || user?.offline) {
      toast("Supabase 연동 후 친구 추가가 가능합니다");
      return;
    }
    const input = document.getElementById("homesafe-friend-code");
    const code = input?.value?.trim().toUpperCase();
    if (!code) {
      toast("초대 코드를 입력해 주세요");
      return;
    }
    const { data: friendUser, error } = await supabase
      .from("users")
      .select("*")
      .eq("invite_code", code)
      .maybeSingle();
    if (error || !friendUser) {
      toast("코드를 찾을 수 없습니다");
      return;
    }
    if (friendUser.id === user.id) {
      toast("내 코드는 추가할 수 없습니다");
      return;
    }
    await supabase.from("friends").upsert([
      { user_id: user.id, friend_id: friendUser.id },
      { user_id: friendUser.id, friend_id: user.id },
    ]);
    if (input) input.value = "";
    toast(`${friendUser.name}님을 친구로 추가했습니다`);
    await loadFriends();
  }

  async function loadGroups() {
    if (!supabase || user?.offline) {
      groups = [];
      renderGroups();
      return;
    }
    const { data: memberships } = await supabase
      .from("group_members")
      .select("group_id")
      .eq("user_id", user.id);
    const ids = (memberships || []).map((m) => m.group_id);
    if (!ids.length) {
      groups = [];
      renderGroups();
      return;
    }
    const { data } = await supabase.from("groups").select("*").in("id", ids);
    groups = data || [];
    renderGroups();
  }

  function renderGroups() {
    const list = document.getElementById("homesafe-groups-list");
    const empty = document.getElementById("homesafe-groups-empty");
    if (!list) return;
    if (!groups.length) {
      list.innerHTML = "";
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    list.innerHTML = groups
      .map(
        (g) => `
      <li>
        <button class="homesafe-group-card" type="button" data-group-id="${g.id}">
          <div>
            <strong>${g.group_name}</strong>
            <p>${g.invite_code}</p>
          </div>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
        </button>
      </li>`
      )
      .join("");
    list.querySelectorAll("[data-group-id]").forEach((btn) => {
      btn.addEventListener("click", () => openGroupDashboard(btn.dataset.groupId));
    });
  }

  async function createGroup() {
    if (!supabase || user?.offline) {
      toast("Supabase 연동 후 그룹을 만들 수 있습니다");
      return;
    }
    const nameInput = document.getElementById("homesafe-group-name");
    const name = nameInput?.value?.trim();
    if (!name) {
      toast("그룹 이름을 입력해 주세요");
      return;
    }
    const code = generateCode("GROUP");
    const { data, error } = await supabase
      .from("groups")
      .insert({ group_name: name, invite_code: code, owner_id: user.id })
      .select("*")
      .single();
    if (error) {
      toast("그룹 생성에 실패했습니다");
      return;
    }
    await supabase.from("group_members").insert({ group_id: data.id, user_id: user.id });
    if (nameInput) nameInput.value = "";
    toast(`"${name}" 그룹을 만들었습니다`);
    await loadGroups();
  }

  async function joinGroupByCode() {
    if (!supabase || user?.offline) {
      toast("Supabase 연동 후 그룹 참여가 가능합니다");
      return;
    }
    const input = document.getElementById("homesafe-group-code");
    const code = input?.value?.trim().toUpperCase();
    if (!code) {
      toast("그룹 코드를 입력해 주세요");
      return;
    }
    const { data: group, error } = await supabase
      .from("groups")
      .select("*")
      .eq("invite_code", code)
      .maybeSingle();
    if (error || !group) {
      toast("그룹을 찾을 수 없습니다");
      return;
    }
    await supabase.from("group_members").upsert({ group_id: group.id, user_id: user.id });
    if (input) input.value = "";
    toast(`"${group.group_name}" 그룹에 참여했습니다`);
    await loadGroups();
  }

  function clearGroupMapLayers() {
    Object.values(memberMarkers).forEach((m) => m.setMap(null));
    Object.values(memberLines).forEach((l) => l.setMap(null));
    memberMarkers = {};
    memberLines = {};
  }

  async function renderGroupMap(trackings) {
    await initGroupMap();
    if (!groupMap) return;
    clearGroupMapLayers();
    const bounds = new kakao.maps.LatLngBounds();
    let hasPoint = false;
    (trackings || []).forEach((t, i) => {
      if (t.lat == null || t.lng == null) return;
      const point = deps.toLatLng({ lat: t.lat, lng: t.lng });
      const colors = ["#6366f1", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6"];
      const color = colors[i % colors.length];
      memberMarkers[t.user_id] = new kakao.maps.Marker({
        map: groupMap,
        position: point,
        title: t.user_name || "멤버",
      });
      bounds.extend(point);
      hasPoint = true;
      if (t.dest_lat != null && t.dest_lng != null && t.is_active) {
        const dest = deps.toLatLng({ lat: t.dest_lat, lng: t.dest_lng });
        memberLines[t.user_id] = new kakao.maps.Polyline({
          map: groupMap,
          path: [point, dest],
          strokeWeight: 4,
          strokeColor: color,
          strokeOpacity: 0.7,
        });
        bounds.extend(dest);
      }
    });
    if (hasPoint) groupMap.setBounds(bounds, 56, 56, 56, 56);
  }

  function renderStatusBoard(trackings) {
    const board = document.getElementById("homesafe-status-board");
    if (!board) return;
    if (!trackings?.length) {
      board.innerHTML = `<li class="empty-hint">아직 귀가 중인 멤버가 없습니다.</li>`;
      return;
    }
    board.innerHTML = trackings
      .map((t) => {
        const active = t.is_active;
        const line = active
          ? `${statusLabel(t.status)} · ${t.eta || formatEta(t.eta_minutes)}`
          : "귀가 중 아님";
        const dest = t.destination ? ` → ${t.destination}` : "";
        return `
      <li class="homesafe-status-item ${t.status === "home" ? "homesafe-status-item--done" : ""}">
        <strong>${t.user_name || "멤버"}</strong>
        <span>${line}${dest}</span>
      </li>`;
      })
      .join("");
  }

  async function loadGroupTrackings(groupId) {
    if (!supabase || user?.offline) return [];
    const { data: members } = await supabase
      .from("group_members")
      .select("user_id, users(name)")
      .eq("group_id", groupId);
    const ids = (members || []).map((m) => m.user_id);
    if (!ids.length) return [];
    const { data: trackings } = await supabase.from("safe_tracking").select("*").in("user_id", ids);
    const nameMap = Object.fromEntries(
      (members || []).map((m) => [m.user_id, m.users?.name || "멤버"])
    );
    return (trackings || []).map((t) => ({ ...t, user_name: nameMap[t.user_id] }));
  }

  async function openGroupDashboard(groupId) {
    const group = groups.find((g) => g.id === groupId);
    if (!group) return;
    activeGroup = group;
    document.getElementById("homesafe-panel-solo").hidden = true;
    document.getElementById("homesafe-panel-friends").hidden = true;
    document.getElementById("homesafe-panel-groups").hidden = true;
    const dashboard = document.getElementById("homesafe-group-dashboard");
    if (dashboard) dashboard.hidden = false;
    document.getElementById("homesafe-dashboard-title").textContent = group.group_name;
    document.getElementById("homesafe-dashboard-code").textContent = group.invite_code;
    groupTrackings = await loadGroupTrackings(group.id);
    renderStatusBoard(groupTrackings);
    await renderGroupMap(groupTrackings.filter((t) => t.is_active));
    subscribeGroupRealtime(group.id);
  }

  function closeGroupDashboard() {
    unsubscribeGroupRealtime();
    const dashboard = document.getElementById("homesafe-group-dashboard");
    if (dashboard) dashboard.hidden = true;
    switchTab("groups");
  }

  function subscribeGroupRealtime(groupId) {
    unsubscribeGroupRealtime();
    if (!supabase || user?.offline) return;
    realtimeChannel = supabase
      .channel(`homesafe-group-${groupId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "safe_tracking" },
        async () => {
          groupTrackings = await loadGroupTrackings(groupId);
          renderStatusBoard(groupTrackings);
          await renderGroupMap(groupTrackings.filter((t) => t.is_active));
        }
      )
      .subscribe();
  }

  function unsubscribeGroupRealtime() {
    if (realtimeChannel) {
      supabase?.removeChannel(realtimeChannel);
      realtimeChannel = null;
    }
  }

  async function refreshAll() {
    renderProfile();
    await loadFriends();
    await loadGroups();
    if (!document.getElementById("homesafe-group-dashboard")?.hidden && activeGroup?.id) {
      groupTrackings = await loadGroupTrackings(activeGroup.id);
      renderStatusBoard(groupTrackings);
      await renderGroupMap(groupTrackings.filter((t) => t.is_active));
    }
  }

  function bindEvents() {
    document.querySelectorAll("[data-homesafe-tab]").forEach((tab) => {
      tab.addEventListener("click", () => {
        closeGroupDashboard();
        switchTab(tab.dataset.homesafeTab);
      });
    });

    document.getElementById("homesafe-user-name")?.addEventListener("change", (e) => {
      if (!user) return;
      user.name = e.target.value.trim() || "나";
      saveUserProfile();
    });

    document.getElementById("homesafe-share-consent")?.addEventListener("change", (e) => {
      if (!user) return;
      user.share_consent = e.target.checked;
      saveUserProfile();
    });

    document.getElementById("homesafe-copy-code")?.addEventListener("click", async () => {
      if (!user?.invite_code) return;
      try {
        await navigator.clipboard.writeText(user.invite_code);
        toast("초대 코드를 복사했습니다");
      } catch {
        toast(user.invite_code);
      }
    });

    document.getElementById("homesafe-start-btn")?.addEventListener("click", () => startTracking());
    document.getElementById("homesafe-stop-btn")?.addEventListener("click", () => stopTracking(true));
    document.getElementById("homesafe-add-friend-btn")?.addEventListener("click", addFriendByCode);
    document.getElementById("homesafe-create-group-btn")?.addEventListener("click", createGroup);
    document.getElementById("homesafe-join-group-btn")?.addEventListener("click", joinGroupByCode);
    document.getElementById("homesafe-refresh")?.addEventListener("click", refreshAll);
    document.getElementById("homesafe-dashboard-back")?.addEventListener("click", closeGroupDashboard);

    document.getElementById("homesafe-copy-group-code")?.addEventListener("click", async () => {
      if (!activeGroup?.invite_code) return;
      try {
        await navigator.clipboard.writeText(activeGroup.invite_code);
        toast("그룹 코드를 복사했습니다");
      } catch {
        toast(activeGroup.invite_code);
      }
    });

    document.getElementById("homesafe-group-start-btn")?.addEventListener("click", async () => {
      if (!activeGroup) return;
      switchTab("solo");
      closeGroupDashboard();
      const destInput = document.getElementById("homesafe-dest-input");
      if (!destInput?.value?.trim() && trackingDestination) {
        destInput.value = trackingDestination.name;
      }
      await startTracking({ group: activeGroup, keepGroup: true });
    });

    document.getElementById("homesafe-dest-input")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        startTracking();
      }
    });
  }

  async function init(integration) {
    deps = integration;
    bindEvents();
    await loadRemoteConfig();
    initSupabaseClient();
    showConfigBanner(!supabase);
    await ensureUser();
    renderProfile();
    activeGroup = loadJson(STORAGE_ACTIVE_GROUP, null);
  }

  async function onShowView() {
    if (!deps) return;
    switchTab("solo");
    await initSoloMap();
    await refreshAll();
    setTimeout(() => {
      soloMap?.relayout();
      groupMap?.relayout();
    }, 120);
  }

  function onHideView() {
    unsubscribeGroupRealtime();
  }

  window.TransitONHomeSafe = { init, onShowView, onHideView };
})();
