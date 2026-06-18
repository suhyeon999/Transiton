from flask import Flask, jsonify, request
from flask_cors import CORS
import requests
from datetime import datetime

app = Flask(__name__)
CORS(app)

# =========================
# 설정
# =========================
BIMS_KEY = "f3fd387d5b830d1ebf5151bc407dc82e333d0ae9be04423290f6ff2db0def29d"
HUMETRO_KEY = "f3fd387d5b830d1ebf5151bc407dc82e333d0ae9be04423290f6ff2db0def29d"

BASE_LAT, BASE_LON = 35.1341, 129.0963  # 부산 남구 기준

# =========================
# 버스 API
# =========================
def get_bus():
    try:
        url = "http://61.43.246.153/openapi-data/service/busanBIMS/stopArr"
        params = {
            "serviceKey": BIMS_KEY,
            "bstopid": "505530000",
            "_type": "json"
        }

        res = requests.get(url, params=params, timeout=5).json()
        items = res.get("response", {}).get("body", {}).get("items", {})

        if "item" in items:
            item = items["item"]
            if isinstance(item, list):
                item = item[0]

            return {
                "type": "bus",
                "name": item.get("lineNo", "unknown"),
                "eta": int(item.get("min1", 999)),
                "stop": "경성대부경대역"
            }
    except Exception as e:
        print("[BUS ERROR]", e)

    return None

# =========================
# 지하철 API
# =========================
def get_subway():
    try:
        url = "http://data.humetro.busan.kr/cyber/service/arrival/getArrivalList"
        params = {
            "serviceKey": HUMETRO_KEY,
            "stationId": "212",
            "act": "json"
        }

        res = requests.get(url, params=params, timeout=5).json()
        item = res.get("response", {}).get("body", {}).get("item", [])

        if item:
            first = item[0]
            eta = int(first.get("arrivalTime", 0)) // 60

            return {
                "type": "subway",
                "name": "Line 2",
                "eta": eta,
                "stop": "경성대부경대역"
            }

    except Exception as e:
        print("[SUBWAY ERROR]", e)

    return None

# =========================
# 실시간 API
# =========================
@app.route("/api/realtime")
def realtime():
    bus = get_bus()
    subway = get_subway()

    return jsonify({
        "bus": bus,
        "subway": subway,
        "updated_at": datetime.now().strftime("%H:%M:%S"),
        "using_fallback": bus is None and subway is None
    })

# =========================
# 경로 API (간단 버전)
# =========================
@app.route("/api/route")
def route():
    bus = get_bus()
    subway = get_subway()

    options = [x for x in [bus, subway] if x]

    if not options:
        return jsonify({"error": "no data"}), 500

    best = min(options, key=lambda x: x["eta"])

    return jsonify({
        "best": best,
        "walk_time": 5,
        "total_eta": best["eta"] + 5,
        "updated_at": datetime.now().strftime("%H:%M:%S")
    })

# =========================
# 서버 실행
# =========================
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, debug=True)
