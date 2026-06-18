"""
TransitON — 부산 버스·지하철 공통 서비스 로직
Flask(smarttransit.py) · Vercel Serverless(api/) 공용
"""

import math
import os
import traceback
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import requests

KST = ZoneInfo("Asia/Seoul")

# 부산 지하철 주요 역 (목적지와 가장 가까운 역을 하차역으로 사용)
BUSAN_SUBWAY_STATIONS = [
    {"name": "다대포해수욕장역", "lat": 35.051, "lng": 128.967},
    {"name": "남포역", "lat": 35.097, "lng": 129.032},
    {"name": "부산역", "lat": 35.1156, "lng": 129.0419},
    {"name": "중앙역", "lat": 35.110, "lng": 129.037},
    {"name": "초량역", "lat": 35.120, "lng": 129.043},
    {"name": "부원역", "lat": 35.129, "lng": 129.045},
    {"name": "동래역", "lat": 35.206, "lng": 129.078},
    {"name": "교대역", "lat": 35.196, "lng": 129.080},
    {"name": "연산역", "lat": 35.180, "lng": 129.089},
    {"name": "수영역", "lat": 35.145, "lng": 129.113},
    {"name": "민락역", "lat": 35.156, "lng": 129.128},
    {"name": "센텀시티역", "lat": 35.169, "lng": 129.131},
    {"name": "벡스코역", "lat": 35.168, "lng": 129.137},
    {"name": "해운대역", "lat": 35.163, "lng": 129.158},
    {"name": "중동역", "lat": 35.158, "lng": 129.166},
    {"name": "장산역", "lat": 35.168, "lng": 129.175},
    {"name": "금정역", "lat": 35.243, "lng": 129.092},
    {"name": "서면역", "lat": 35.1579, "lng": 129.0594},
    {"name": "연지공원역", "lat": 35.136, "lng": 129.088},
    {"name": "경성대·부경대역", "lat": 35.134, "lng": 129.096},
    {"name": "대연역", "lat": 35.128, "lng": 129.091},
    {"name": "못골역", "lat": 35.148, "lng": 129.065},
    {"name": "지게골역", "lat": 35.152, "lng": 129.055},
    {"name": "부암역", "lat": 35.128, "lng": 129.047},
    {"name": "가야역", "lat": 35.114, "lng": 129.044},
    {"name": "양산역", "lat": 35.338, "lng": 129.033},
    {"name": "온천장역", "lat": 35.222, "lng": 129.085},
    {"name": "사직역", "lat": 35.195, "lng": 129.065},
    {"name": "미남역", "lat": 35.205, "lng": 129.064},
]


def now_kst():
    return datetime.now(KST)

# 공공데이터 API 인증키 (Vercel Environment Variables)
# 버스·지하철 키가 따로면 AUTH_KEY_BUS / AUTH_KEY_SUBWAY 각각 설정
# 하나만 있으면 AUTH_KEY 로 둘 다 시도 (하위 호환)
_DEFAULT_KEY = "f3fd387d5b830d1ebf5151bc407dc82e333d0ae9be04423290f6ff2db0def29d"
AUTH_KEY = os.environ.get("AUTH_KEY", _DEFAULT_KEY)
AUTH_KEY_BUS = os.environ.get("AUTH_KEY_BUS") or AUTH_KEY
AUTH_KEY_SUBWAY = os.environ.get("AUTH_KEY_SUBWAY") or AUTH_KEY


def _decode_key(raw):
    return requests.utils.unquote(raw) if raw else ""

BUS_STOP_ID = "505530000"  # 경성대부경대역 정류장
SUBWAY_STATION_ID = "212"  # 경성대부경대역 (2호선)
DEFAULT_LOCATION = {
    "lat": 35.1341,
    "lon": 129.0963,
    "label": "부산 남구 대연동",
    "area": "경성대부경대역",
}
HOME_DEFAULT = "부산역"


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


class TransitService:
    def __init__(self, user_name="정수현"):
        self.user_name = user_name
        self.walking_speed = 1.11  # m/s
        self.bus_key = _decode_key(AUTH_KEY_BUS)
        self.subway_key = _decode_key(AUTH_KEY_SUBWAY)
        self.cur_lat = DEFAULT_LOCATION["lat"]
        self.cur_lon = DEFAULT_LOCATION["lon"]
        self.last_diagnostics = {}

    def _fetch_json_with_diag(self, name, url, params, timeout=8):
        """외부 API 호출 + 실패 원인 진단 정보 반환."""
        diag = {
            "name": name,
            "url": url,
            "params_keys": list(params.keys()),
            "ok": False,
            "http_status": None,
            "error": None,
            "parse_error": None,
            "body_preview": None,
            "item_count": 0,
        }
        try:
            res = requests.get(url, params=params, timeout=timeout)
            diag["http_status"] = res.status_code
            diag["body_preview"] = res.text[:600]
            if res.status_code != 200:
                diag["error"] = f"HTTP {res.status_code}"
                return None, diag
            try:
                data = res.json()
            except ValueError as exc:
                diag["parse_error"] = str(exc)
                diag["error"] = "JSON_PARSE_ERROR"
                return None, diag
            diag["ok"] = True
            return data, diag
        except requests.Timeout:
            diag["error"] = "TIMEOUT"
            return None, diag
        except requests.RequestException as exc:
            diag["error"] = f"NETWORK_ERROR: {exc}"
            return None, diag
        except Exception as exc:
            diag["error"] = f"UNEXPECTED: {exc}"
            diag["trace"] = traceback.format_exc()[:400]
            return None, diag

    def fetch_bus_api(self, bstopid=BUS_STOP_ID):
        """부산 BIMS 실시간 버스 도착 정보"""
        url = "http://61.43.246.153/openapi-data/service/busanBIMS/stopArr"
        params = {"serviceKey": self.bus_key, "bstopid": bstopid, "_type": "json"}
        res, diag = self._fetch_json_with_diag("busBIMS", url, params, timeout=15)
        self.last_diagnostics["bus"] = diag

        if not res:
            return None

        try:
            header = res.get("response", {}).get("header", {})
            if header.get("resultCode") not in (None, "00", "0"):
                diag["ok"] = False
                diag["error"] = f"BIMS_RESULT_{header.get('resultCode')}: {header.get('resultMsg', '')}"
                return None

            items = res.get("response", {}).get("body", {}).get("items")
            if not items or "item" not in items:
                diag["ok"] = False
                diag["error"] = "BIMS_EMPTY_ITEMS"
                diag["body_preview"] = str(res)[:600]
                return None

            raw = items["item"]
            bus_list = raw if isinstance(raw, list) else [raw]
            arrivals = []
            for bus in bus_list[:8]:
                min1 = bus.get("min1")
                try:
                    eta = int(min1) if min1 not in (None, "") else 0
                except (TypeError, ValueError):
                    eta = 0
                arrivals.append(
                    {
                        "line_no": str(bus.get("lineNo", "")),
                        "eta": eta,
                        "destination": bus.get("station1") or bus.get("stationNm") or "",
                        "plate_no": bus.get("plateNo", ""),
                    }
                )

            diag["item_count"] = len(arrivals)
            return {
                "type": "버스",
                "stop_id": bstopid,
                "stop_name": "경성대부경대역(정류장)",
                "dist": 350,
                "arrivals": arrivals,
                "source": "api",
            }
        except Exception as exc:
            diag["ok"] = False
            diag["error"] = f"PARSE_ERROR: {exc}"
            return None

    def fetch_subway_api(self, station_id=SUBWAY_STATION_ID):
        """부산교통공사 Humetro 실시간 지하철 도착 정보"""
        url = "http://data.humetro.busan.kr/cyber/service/arrival/getArrivalList"
        params = {"serviceKey": self.subway_key, "stationId": station_id, "act": "json"}
        res, diag = self._fetch_json_with_diag("subwayHumetro", url, params)
        self.last_diagnostics["subway"] = diag

        if not res:
            return None

        try:
            raw_items = res.get("response", {}).get("body", {}).get("item", [])
            if not raw_items:
                diag["ok"] = False
                diag["error"] = "HUMETRO_EMPTY_ITEMS"
                diag["body_preview"] = str(res)[:600]
                return None

            items = raw_items if isinstance(raw_items, list) else [raw_items]
            arrivals = []
            for item in items[:6]:
                try:
                    eta_sec = int(item.get("arrivalTime", 0))
                except (TypeError, ValueError):
                    eta_sec = 0
                eta_min = max(0, eta_sec // 60)
                direction = (
                    item.get("trainLineNm")
                    or item.get("subwayHeading")
                    or item.get("upDown")
                    or "운행"
                )
                arrivals.append(
                    {"direction": direction, "eta": eta_min, "arrival_sec": eta_sec}
                )

            diag["item_count"] = len(arrivals)
            first_eta = arrivals[0]["eta"] if arrivals else 0
            return {
                "type": "지하철",
                "station_id": station_id,
                "stop_name": "경성대부경대역(지하철)",
                "line": "2호선",
                "dist": 500,
                "eta": first_eta,
                "arrivals": arrivals,
                "source": "api",
            }
        except Exception as exc:
            diag["ok"] = False
            diag["error"] = f"PARSE_ERROR: {exc}"
            return None

    def _fallback_bus(self):
        return {
            "type": "버스",
            "stop_id": BUS_STOP_ID,
            "stop_name": "경성대부경대역(정류장)",
            "dist": 350,
            "eta": 15,
            "name": "155",
            "arrivals": [
                {"line_no": "155", "eta": 15, "destination": "부산역"},
                {"line_no": "40", "eta": 8, "destination": "서면"},
                {"line_no": "5-1", "eta": 12, "destination": "해운대"},
            ],
            "source": "fallback",
        }

    def _fallback_subway(self):
        return {
            "type": "지하철",
            "station_id": SUBWAY_STATION_ID,
            "stop_name": "경성대부경대역(지하철)",
            "line": "2호선",
            "dist": 500,
            "eta": 10,
            "name": "2호선",
            "arrivals": [
                {"direction": "장산 방면", "eta": 3, "arrival_sec": 180},
                {"direction": "양산 방면", "eta": 7, "arrival_sec": 420},
            ],
            "source": "fallback",
        }

    def get_realtime(self):
        bus = self.fetch_bus_api()
        subway = self.fetch_subway_api()

        if not bus:
            bus = self._fallback_bus()
        else:
            first = bus["arrivals"][0] if bus["arrivals"] else {}
            bus["eta"] = first.get("eta", 15)
            bus["name"] = first.get("line_no", "버스")

        if not subway:
            subway = self._fallback_subway()

        bus_ok = bus.get("source") == "api"
        subway_ok = subway.get("source") == "api"

        return {
            "location": DEFAULT_LOCATION,
            "bus": bus,
            "subway": subway,
            "bus_ok": bus_ok,
            "subway_ok": subway_ok,
            "using_fallback": not bus_ok or not subway_ok,
            "updated_at": now_kst().strftime("%H:%M:%S"),
            "api_diagnostics": self.last_diagnostics,
        }

    def calculate_golden_time(self, eta, dist):
        walk_time = round((dist / self.walking_speed) / 60)
        buffer = 2
        golden_min = eta - walk_time - buffer
        return walk_time, golden_min

    def _walk_minutes(self, meters):
        return max(1, round((meters / self.walking_speed) / 60))

    def _nearest_subway_station(self, lat, lng):
        station = min(
            BUSAN_SUBWAY_STATIONS,
            key=lambda s: haversine_m(lat, lng, s["lat"], s["lng"]),
        )
        return station["name"]

    def _resolve_alight_stop(self, dest_lat, dest_lng, dest_name):
        name = (dest_name or "").strip()
        if name.endswith("역"):
            return name
        return self._nearest_subway_station(dest_lat, dest_lng)

    def _station_by_name(self, name):
        n = (name or "").replace("(지하철)", "").replace("(정류장)", "").strip()
        n_compact = n.replace("·", "").replace(" ", "")
        for s in BUSAN_SUBWAY_STATIONS:
            sn = s["name"]
            sn_compact = sn.replace("·", "").replace(" ", "")
            if sn == n or n in sn or sn_compact == n_compact or sn_compact in n_compact:
                return s
        return None

    def _nearest_exit(self, station_name, ref_lat, ref_lng):
        station = self._station_by_name(station_name)
        if not station:
            return "가까운 출구", ref_lat, ref_lng
        base_lat, base_lng = station["lat"], station["lng"]
        offsets = [
            ("1번 출구", 0.00035, 0.00015),
            ("2번 출구", 0.00015, 0.00035),
            ("3번 출구", -0.00035, -0.00015),
            ("4번 출구", -0.00015, -0.00035),
            ("5번 출구", 0.00025, -0.00025),
        ]
        exits = [
            {"name": label, "lat": base_lat + dlat, "lng": base_lng + dlng}
            for label, dlat, dlng in offsets
        ]
        best = min(
            exits,
            key=lambda e: haversine_m(ref_lat, ref_lng, e["lat"], e["lng"]),
        )
        return best["name"], best["lat"], best["lng"]

    def _line_direction(self, line, from_station, to_station):
        from_st = self._station_by_name(from_station)
        to_st = self._station_by_name(to_station)
        if not from_st or not to_st:
            return "운행 방면"
        if line == "1":
            return (
                "다대포해수욕장 방면"
                if to_st["lng"] < from_st["lng"]
                else "노포 방면"
            )
        if line == "2":
            return (
                "장산 방면"
                if to_st["lng"] > from_st["lng"]
                else "양산 방면"
            )
        return "운행 방면"

    def _enrich_route_legs(self, legs, origin_lat, origin_lng, dest_lat, dest_lng):
        subway_indices = [i for i, leg in enumerate(legs) if leg.get("type") == "subway"]
        if not subway_indices:
            return

        first_idx = subway_indices[0]
        last_idx = subway_indices[-1]

        for idx in subway_indices:
            leg = legs[idx]
            leg["show_board_exit"] = idx == first_idx
            leg["show_alight_exit"] = idx == last_idx

            board_stop = leg.get("board_stop")
            alight_stop = leg.get("alight_stop")

            if idx == first_idx and board_stop:
                board_st = self._station_by_name(board_stop)
                exit_name, _, _ = self._nearest_exit(board_stop, origin_lat, origin_lng)
                leg["board_exit"] = exit_name
                if board_st:
                    leg["board_stop_lat"] = board_st["lat"]
                    leg["board_stop_lng"] = board_st["lng"]
            elif board_stop:
                board_st = self._station_by_name(board_stop)
                if board_st:
                    leg["board_stop_lat"] = board_st["lat"]
                    leg["board_stop_lng"] = board_st["lng"]

            if idx == last_idx and alight_stop:
                alight_st = self._station_by_name(alight_stop)
                exit_name, exit_lat, exit_lng = self._nearest_exit(
                    alight_stop, dest_lat, dest_lng
                )
                leg["alight_exit"] = exit_name
                leg["alight_exit_lat"] = exit_lat
                leg["alight_exit_lng"] = exit_lng
                if alight_st:
                    leg["alight_stop_lat"] = alight_st["lat"]
                    leg["alight_stop_lng"] = alight_st["lng"]
            elif alight_stop:
                alight_st = self._station_by_name(alight_stop)
                if alight_st:
                    leg["alight_stop_lat"] = alight_st["lat"]
                    leg["alight_stop_lng"] = alight_st["lng"]

    def plan_transit_route(
        self,
        origin_lat,
        origin_lng,
        dest_lat,
        dest_lng,
        dest_name="목적지",
        origin_label=None,
    ):
        """실시간 도착 + 거리 기반 대중교통 경로 (BIMS/Humetro + 환승 추정)."""
        realtime = self.get_realtime()
        bus = realtime["bus"]
        subway = realtime["subway"]
        total_dist = haversine_m(origin_lat, origin_lng, dest_lat, dest_lng)

        bus_pick = bus["arrivals"][0] if bus.get("arrivals") else {"line_no": "155", "eta": 15, "destination": ""}
        subway_pick = subway["arrivals"][0] if subway.get("arrivals") else {"direction": "양산 방면", "eta": 10, "arrival_sec": 600}

        bus_wait_sec = max(0, int(bus_pick.get("eta", 0)) * 60)
        subway_wait_sec = max(0, int(subway_pick.get("arrival_sec") or subway_pick.get("eta", 0) * 60))

        alight_stop = self._resolve_alight_stop(dest_lat, dest_lng, dest_name)

        walk_bus = self._walk_minutes(bus["dist"])
        walk_sub = self._walk_minutes(subway["dist"])
        bus_total = walk_bus + bus_pick["eta"] + max(12, int(total_dist / 420))
        subway_total = walk_sub + subway_pick["eta"] + max(10, int(total_dist / 480))

        use_subway = subway_total <= bus_total or total_dist > 3500
        legs = []
        transfers = 0
        fare = 1500
        board_wait_sec = subway_wait_sec if use_subway else bus_wait_sec

        if use_subway:
            line2_alight = alight_stop
            legs.append(
                {
                    "type": "walk",
                    "minutes": walk_sub,
                    "label": f"도보 {walk_sub}분",
                    "detail": f"{origin_label or '출발지'} → {subway['stop_name']}",
                }
            )
            line2_min = max(8, int(total_dist / 900))
            legs.append(
                {
                    "type": "subway",
                    "line": "2",
                    "minutes": line2_min,
                    "wait_min": subway_pick["eta"],
                    "wait_sec": subway_wait_sec,
                    "label": f"2호선 · {line2_min}분",
                    "detail": f"{subway['stop_name']} · {subway_pick['direction']}",
                    "board_stop": subway["stop_name"],
                    "alight_stop": line2_alight,
                }
            )
            fare += 300
            if total_dist > 4500 and alight_stop not in ("서면역", "연산역", "교대역"):
                transfers += 1
                line1_alight = alight_stop
                line1_direction = self._line_direction("1", "서면역", line1_alight)
                transfer_arrivals = subway.get("arrivals") or []
                transfer_pick = (
                    transfer_arrivals[1]
                    if len(transfer_arrivals) > 1
                    else transfer_arrivals[0]
                    if transfer_arrivals
                    else {"eta": 5, "arrival_sec": 300}
                )
                transfer_wait_sec = max(
                    0,
                    int(
                        transfer_pick.get("arrival_sec")
                        or transfer_pick.get("eta", 5) * 60
                    ),
                )
                transfer_wait_min = max(0, transfer_wait_sec // 60)
                legs.append(
                    {
                        "type": "transfer",
                        "minutes": 4,
                        "label": "환승 · 서면역",
                        "detail": "2호선 → 1호선",
                        "station": "서면역",
                        "from_line": "2",
                        "to_line": "1",
                        "direction": line1_direction,
                        "wait_min": transfer_wait_min,
                        "wait_sec": transfer_wait_sec,
                    }
                )
                line1_min = max(6, int(total_dist / 1200))
                legs.append(
                    {
                        "type": "subway",
                        "line": "1",
                        "minutes": line1_min,
                        "wait_min": 0,
                        "wait_sec": 0,
                        "label": f"1호선 · {line1_min}분",
                        "detail": f"서면역 → {line1_alight} · {line1_direction}",
                        "board_stop": "서면역",
                        "alight_stop": line1_alight,
                        "board_direction": line1_direction,
                    }
                )
                fare += 300
        else:
            bus_alight = alight_stop
            legs.append(
                {
                    "type": "walk",
                    "minutes": walk_bus,
                    "label": f"도보 {walk_bus}분",
                    "detail": f"{origin_label or '출발지'} → {bus['stop_name']}",
                }
            )
            ride_min = max(10, int(total_dist / 400))
            legs.append(
                {
                    "type": "bus",
                    "line": bus_pick["line_no"],
                    "minutes": ride_min,
                    "wait_min": bus_pick["eta"],
                    "wait_sec": bus_wait_sec,
                    "label": f"{bus_pick['line_no']}번 · {ride_min}분",
                    "detail": f"{bus['stop_name']} → {bus_alight}",
                    "board_stop": bus["stop_name"],
                    "alight_stop": bus_alight,
                }
            )

        walk_end = self._walk_minutes(min(450, max(120, total_dist * 0.08)))
        legs.append(
            {
                "type": "walk",
                "minutes": walk_end,
                "label": f"도보 {walk_end}분",
                "detail": f"하차 → {dest_name}",
            }
        )

        wait_min = legs[1].get("wait_min", 0) if len(legs) > 1 else 0
        move_min = sum(l["minutes"] for l in legs) + wait_min
        now = now_kst()
        arrival = now + timedelta(minutes=move_min)

        self._enrich_route_legs(legs, origin_lat, origin_lng, dest_lat, dest_lng)

        return {
            "origin": {"lat": origin_lat, "lng": origin_lng, "label": origin_label or DEFAULT_LOCATION["label"]},
            "destination": {"lat": dest_lat, "lng": dest_lng, "name": dest_name},
            "distance_m": int(total_dist),
            "duration_min": move_min,
            "fare": min(2500, fare + transfers * 200),
            "transfers": transfers,
            "arrival_time": arrival.strftime("%H:%M"),
            "arrival_at": arrival.isoformat(),
            "computed_at": now.isoformat(),
            "departure_time": now.strftime("%H:%M"),
            "board_wait_sec": board_wait_sec,
            "board_mode": "subway" if use_subway else "bus",
            "mode": "subway" if use_subway else "bus",
            "mode_label": "지하철" if use_subway else "버스",
            "legs": legs,
            "realtime": realtime,
            "using_fallback": realtime["using_fallback"],
            "api_diagnostics": realtime["api_diagnostics"],
        }

    def analyze(self, destination="집", origin_lat=None, origin_lng=None, dest_lat=None, dest_lng=None):
        origin_lat = origin_lat or DEFAULT_LOCATION["lat"]
        origin_lng = origin_lng or DEFAULT_LOCATION["lon"]
        dest_lat = dest_lat or 35.1156
        dest_lng = dest_lng or 129.0419

        route = self.plan_transit_route(
            origin_lat, origin_lng, dest_lat, dest_lng, destination, DEFAULT_LOCATION["label"]
        )
        realtime = route["realtime"]
        bus = realtime["bus"]
        subway = realtime["subway"]

        bus_pick = {
            "type": "버스",
            "name": bus.get("name", "155"),
            "eta": bus.get("eta", 15),
            "stop_name": bus["stop_name"],
            "dist": bus["dist"],
            "stop_lat": DEFAULT_LOCATION["lat"],
            "stop_lng": DEFAULT_LOCATION["lon"],
        }
        subway_pick = {
            "type": "지하철",
            "name": subway.get("line", "2호선"),
            "eta": subway.get("eta", 10),
            "stop_name": subway["stop_name"],
            "dist": subway["dist"],
            "stop_lat": DEFAULT_LOCATION["lat"],
            "stop_lng": DEFAULT_LOCATION["lon"],
        }

        best = min([bus_pick, subway_pick], key=lambda x: x["eta"])
        walk_t, golden_t = self.calculate_golden_time(best["eta"], best["dist"])

        now = now_kst()
        ride_minutes = route["duration_min"] - walk_t - best["eta"]
        ride_minutes = max(5, ride_minutes)
        departure_time = now + timedelta(minutes=max(0, golden_t))
        arrival_time = now + timedelta(minutes=route["duration_min"])

        return {
            **realtime,
            "destination": destination,
            "best": best,
            "route": route,
            "analysis": {
                "walk_minutes": walk_t,
                "golden_minutes": max(0, golden_t),
                "buffer_minutes": 2,
                "ride_minutes": ride_minutes,
                "departure_time": departure_time.strftime("%H:%M"),
                "arrival_time": arrival_time.strftime("%H:%M"),
                "current_time": now.strftime("%H:%M:%S"),
                "recommended_departure": departure_time.strftime("%H:%M"),
            },
        }


_service = None


def get_service():
    global _service
    if _service is None:
        _service = TransitService()
    return _service
