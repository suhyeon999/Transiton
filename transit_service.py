"""
TransitON — 부산 버스·지하철 공통 서비스 로직
Flask(smarttransit.py) · Vercel Serverless(api/) 공용
"""

import math
import os
import traceback
from datetime import datetime, timedelta

import requests

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
        res, diag = self._fetch_json_with_diag("busBIMS", url, params)
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
        using_fallback = False

        if not bus:
            bus = self._fallback_bus()
            using_fallback = True
        else:
            first = bus["arrivals"][0] if bus["arrivals"] else {}
            bus["eta"] = first.get("eta", 15)
            bus["name"] = first.get("line_no", "버스")

        if not subway:
            subway = self._fallback_subway()
            using_fallback = True

        return {
            "location": DEFAULT_LOCATION,
            "bus": bus,
            "subway": subway,
            "using_fallback": using_fallback,
            "updated_at": datetime.now().strftime("%H:%M:%S"),
            "api_diagnostics": self.last_diagnostics,
        }

    def calculate_golden_time(self, eta, dist):
        walk_time = round((dist / self.walking_speed) / 60)
        buffer = 2
        golden_min = eta - walk_time - buffer
        return walk_time, golden_min

    def _walk_minutes(self, meters):
        return max(1, round((meters / self.walking_speed) / 60))

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

        def alight_name(default):
            if dest_name.endswith("역"):
                return dest_name
            if "부산역" in dest_name or dest_name == "부산역":
                return "부산역"
            if "서면" in dest_name:
                return "서면역"
            return default

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
            line2_alight = "서면역" if total_dist > 4500 else alight_name("부산역")
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
            if total_dist > 4500:
                transfers += 1
                line1_alight = alight_name("부산역")
                legs.append(
                    {
                        "type": "transfer",
                        "minutes": 4,
                        "label": "환승 · 서면역",
                        "detail": "2호선 → 1호선",
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
                        "detail": f"서면역 → {line1_alight} 방면",
                        "board_stop": "서면역",
                        "alight_stop": line1_alight,
                    }
                )
                fare += 300
        else:
            bus_alight = bus_pick.get("destination") or alight_name("부산역")
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
        now = datetime.now()
        arrival = now + timedelta(minutes=move_min)

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
        }
        subway_pick = {
            "type": "지하철",
            "name": subway.get("line", "2호선"),
            "eta": subway.get("eta", 10),
            "stop_name": subway["stop_name"],
            "dist": subway["dist"],
        }

        best = min([bus_pick, subway_pick], key=lambda x: x["eta"])
        walk_t, golden_t = self.calculate_golden_time(best["eta"], best["dist"])

        now = datetime.now()
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
