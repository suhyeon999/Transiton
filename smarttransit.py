"""
TransitON — 로컬 개발용 Flask 서버 (정적 파일 + /api/*)
Vercel 배포 시에는 api/ serverless 함수가 동일 API를 제공합니다.
"""

import os
import sys
from datetime import datetime

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

from transit_service import (
    DEFAULT_LOCATION,
    HOME_DEFAULT,
    TransitService,
    get_service,
)

app = Flask(__name__, static_folder=".", static_url_path="")
CORS(app)
service = get_service()


@app.route("/")
def index():
    return send_from_directory(".", "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    allowed = {"style.css", "script.js", "homesafe.js", "index.html"}
    if filename in allowed:
        return send_from_directory(".", filename)
    return jsonify({"error": "Not found"}), 404


@app.route("/api/health")
def health():
    return jsonify({"status": "ok", "service": "TransitON", "time": datetime.now().isoformat()})


@app.route("/api/realtime")
def api_realtime():
    return jsonify(service.get_realtime())


@app.route("/api/analysis")
def api_analysis():
    destination = request.args.get("destination", HOME_DEFAULT)
    origin_lat = request.args.get("origin_lat", type=float)
    origin_lng = request.args.get("origin_lng", type=float)
    dest_lat = request.args.get("dest_lat", type=float)
    dest_lng = request.args.get("dest_lng", type=float)
    return jsonify(service.analyze(destination, origin_lat, origin_lng, dest_lat, dest_lng))


@app.route("/api/route")
def api_route():
    dest_name = request.args.get("dest_name", HOME_DEFAULT)
    origin_lat = request.args.get("origin_lat", type=float) or DEFAULT_LOCATION["lat"]
    origin_lng = request.args.get("origin_lng", type=float) or DEFAULT_LOCATION["lon"]
    dest_lat = request.args.get("dest_lat", type=float)
    dest_lng = request.args.get("dest_lng", type=float)
    origin_label = request.args.get("origin_label", DEFAULT_LOCATION["label"])

    if dest_lat is None or dest_lng is None:
        return jsonify({"error": "dest_lat and dest_lng required"}), 400

    return jsonify(
        service.plan_transit_route(
            origin_lat, origin_lng, dest_lat, dest_lng, dest_name, origin_label
        )
    )


@app.route("/api/config")
def api_config():
    return jsonify(
        {
            "supabaseUrl": os.environ.get("SUPABASE_URL", ""),
            "supabaseAnonKey": os.environ.get("SUPABASE_ANON_KEY", ""),
        }
    )


class LastPassFinal(TransitService):
    def run(self):
        print("\n" + "🚀 " + "=" * 54 + " 🚀")
        print(" [막차패스] 부산 대중교통 API 통합 연동 시스템 (Ver 1.0)")
        print(" " + "=" * 58)
        print(f" 👤 사용자: {self.user_name} | 📍 기준위치: {DEFAULT_LOCATION['label']}")

        home_addr = input("🏠 집 주소(목적지)를 입력하세요: ")
        result = self.analyze(home_addr or "집")
        best = result["best"]
        analysis = result["analysis"]

        print("\n" + "🏆 [실시간 데이터 기반 분석 결과]")
        print("-" * 60)
        print(f" 🏁 추천 수단 : {best['type']} ({best['name']})")
        print(f" 📍 탑승 장소 : {best['stop_name']}")
        print(f" ⏰ 열차/버스 정보 : {best['eta']}분 후 도착 예정")
        print("-" * 60)
        print(f" 🚶 도보 정보 : 약 {analysis['walk_minutes']}분 소요 ({best['dist']}m)")
        print(
            f" 🏠 귀가 정보 : 약 {best['eta'] + analysis['ride_minutes']}분 소요 "
            f"(예상 귀가 완료 {analysis['arrival_time']})"
        )
        print("-" * 60)
        print(f" 🚨 [막차패스 골든타임] {analysis['departure_time']}")
        if result["using_fallback"]:
            print(" ⚠️  API 연결 실패 — 시연용 데이터로 표시 중")
        print("=" * 60)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "cli":
        LastPassFinal().run()
    else:
        port = int(os.environ.get("PORT", 5001))
        print(f"TransitON 서버 시작 → http://127.0.0.1:{port}")
        app.run(host="0.0.0.0", port=port, debug=True)
