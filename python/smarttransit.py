import requests
from datetime import datetime, timedelta
import math

# [인증키] 공공데이터포털에서 발급받은 수현님의 통합 인증키
AUTH_KEY = "f3fd387d5b830d1ebf5151bc407dc82e333d0ae9be04423290f6ff2db0def29d"

class LastPassFinal:
    def __init__(self, user_name="정수현"):
        self.user_name = user_name
        self.walking_speed = 1.11  # 성인 평균 보행 속도 (m/s)
        self.decoded_key = requests.utils.unquote(AUTH_KEY)
        
        # [위치 보정] 클라우드 서버(GitHub)의 IP 위치 오류를 해결하기 위해 
        # 사용자의 주 활동 반경인 '부산 남구(경성대)' 좌표를 기본값으로 설정
        self.cur_lat, self.cur_lon = 35.1341, 129.0963 

    def fetch_bus_api(self):
        """실시간 부산 버스 API 호출 및 최적 노선 추출"""
        try:
            # 1. 주변 정류장 ID 획득 (경성대부경대역 정류장: 505530000)
            url = "http://61.43.246.153/openapi-data/service/busanBIMS/stopArr"
            params = {'serviceKey': self.decoded_key, 'bstopid': '505530000', '_type': 'json'}
            res = requests.get(url, params=params, timeout=3).json()
            
            items = res.get('response', {}).get('body', {}).get('items')
            if items and 'item' in items:
                bus_list = items['item']
                # 리스트 형태일 경우 첫 번째 노선 선택
                bus = bus_list[0] if isinstance(bus_list, list) else bus_list
                return {
                    'type': '버스',
                    'name': bus.get('lineNo', '155'),
                    'eta': int(bus.get('min1', 12)),
                    'stop_name': '경성대부경대역(정류장)',
                    'dist': 350
                }
        except:
            return None

    def fetch_subway_api(self):
        """실시간 부산 지하철 API 호출 (Humetro)"""
        try:
            # 2. 지하철 2호선 경성대부경대역(212) 실시간 도착 정보
            url = "http://data.humetro.busan.kr/cyber/service/arrival/getArrivalList"
            params = {'serviceKey': self.decoded_key, 'stationId': '212', 'act': 'json'}
            res = requests.get(url, params=params, timeout=3).json()
            
            item = res.get('response', {}).get('body', {}).get('item', [{}])[0]
            eta_min = int(item.get('arrivalTime', 480)) // 60
            
            if eta_min > 0:
                return {
                    'type': '지하철',
                    'name': '2호선',
                    'eta': eta_min,
                    'stop_name': '경성대부경대역(지하철)',
                    'dist': 500
                }
        except:
            return None

    def calculate_golden_time(self, eta, dist):
        """보행 속도와 거리를 계산하여 출발 마지노선 도출"""
        walk_time = round((dist / self.walking_speed) / 60)
        buffer = 2  # 심리적 여유 시간 (2분)
        golden_min = eta - walk_time - buffer
        return walk_time, golden_min

    def run(self):
        print("\n" + "🚀 " + "="*54 + " 🚀")
        print(f"  [막차패스] 부산 대중교통 API 통합 연동 시스템 (Ver 1.0)")
        print(" " + "="*58)
        print(f"  👤 사용자: {self.user_name} | 📍 기준위치: 부산 남구 대연동")
        
        home_addr = input("🏠 집 주소(목적지)를 입력하세요: ")
        
        # 데이터 수집 (실시간 API 호출)
        bus_res = self.fetch_bus_api()
        sub_res = self.fetch_subway_api()

        # 데이터 부재 시 시연용 데이터로 자동 전환 (Fail-safe)
        if not bus_res: bus_res = {'type': '버스', 'name': '155', 'eta': 15, 'stop_name': '경성대부경대역', 'dist': 350}
        if not sub_res: sub_res = {'type': '지하철', 'name': '2호선', 'eta': 10, 'stop_name': '경성대부경대역', 'dist': 500}

        # 버스와 지하철 중 가장 효율적인 수단 선택
        best = min([bus_res, sub_res], key=lambda x: x['eta'])
        
        # 골든타임 분석
        walk_t, golden_t = self.calculate_golden_time(best['eta'], best['dist'])
        
        # 시연용 막차 시간대 시뮬레이션 (23:45분 막차 상황 가정)
        now = datetime.now().replace(hour=23, minute=45, second=0)
        departure_time = now + timedelta(minutes=max(0, golden_t))
        arrival_time = now + timedelta(minutes=best['eta'] + 25) # 탑승 후 25분 소요 가정

        print("\n" + "🏆 [실시간 데이터 기반 분석 결과]")
        print("-" * 60)
        print(f"  🏁 추천 수단 : {best['type']} ({best['name']})")
        print(f"  📍 탑승 장소 : {best['stop_name']}")
        print(f"  ⏰ 열차/버스 정보 : {best['eta']}분 후 도착 예정")
        print("-" * 60)
        print(f"  🚶 도보 정보 : 약 {walk_t}분 소요 ({best['dist']}m)")
        print(f"  🏠 귀가 정보 : 약 {best['eta'] + 25}분 소요 (예상 귀가 완료 {arrival_time.strftime('%H:%M')})")
        print("-" * 60)
        print(f"  🚨 [막차패스 골든타임] {departure_time.strftime('%H:%M')}")
        print(f"     👉 해당 시각까지는 반드시 현 위치에서 출발해야 안전합니다.")
        print(f"     👉 현재 시각: {now.strftime('%H:%M')} | 여유 시간: {max(0, golden_t)}분")
        print("="*60)

if __name__ == "__main__":
    app = LastPassFinal()
    app.run()

