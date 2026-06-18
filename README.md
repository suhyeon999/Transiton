# TransitON

부산 대중교통 안내 (Kakao Maps + BIMS/Humetro 실시간 API)

## 아키텍처

```
Cursor 수정 → git push → GitHub → Vercel 자동 배포
                              ├── index.html / script.js / style.css (정적)
                              └── api/*.py (Vercel Serverless — BIMS/Humetro)
```

로컬 개발 시 Flask로 정적+API 동시 서빙:

```bash
python3 smarttransit.py   # http://127.0.0.1:5001
```

## Git 동기화 (중요)

**`Transiton` 폴더 안에서만 Git을 사용하세요.**

현재 홈 디렉터리(`~/.git`)에 Git이 잘못 초기화되어 있으면 Cursor ↔ GitHub 동기화가 깨집니다.

### 1회 정리 (홈 디렉터리 Git 제거)

```bash
# ⚠️ 홈 전체 Git이 의도치 않게 생성된 경우만 실행
rm -rf ~/.git
```

### 프로젝트 Git 초기화

```bash
cd ~/Desktop/Transiton
git init
git remote add origin https://github.com/suhyeon999/Transiton.git
git add .
git commit -m "TransitON: Vercel API + Kakao Maps 통합"
git branch -M main
git pull origin main --allow-unrelated-histories   # GitHub에 기존 파일이 있을 때
git push -u origin main
```

### 이후 작업 흐름 (Cursor)

1. Cursor에서 코드 수정
2. Source Control → Commit
3. Push (또는 `git push`)
4. Vercel이 자동 재배포 (1~2분)

## Vercel 설정

1. [Vercel Dashboard](https://vercel.com) → 프로젝트 → Settings → Environment Variables
2. **`AUTH_KEY`** 추가 (공공데이터포털 serviceKey)
3. Production / Preview 모두 적용
4. Redeploy

### Kakao Maps (Vercel)

JavaScript 키 → Web 도메인에 **접속 URL 그대로** 등록:

- `https://your-project.vercel.app`
- Preview URL 사용 시 해당 URL도 별도 등록

## API 엔드포인트

| 경로 | 설명 |
|------|------|
| `GET /api/health` | 서버 상태 |
| `GET /api/realtime` | 버스·지하철 실시간 도착 |
| `GET /api/analysis?destination=부산역` | 막차/귀가 분석 |
| `GET /api/route?dest_lat=&dest_lng=&dest_name=` | 대중교통 경로 |

실패 시 응답 JSON의 `api_diagnostics`에서 HTTP status / error / body_preview 확인.

## 로컬 실행

```bash
pip install -r requirements.txt
python3 smarttransit.py
# 브라우저: http://127.0.0.1:5001
```

## 발표용 체크리스트

- [ ] `~/.git` 제거 후 `Transiton/.git`만 사용
- [ ] GitHub push → Vercel Deploy Success
- [ ] Vercel `AUTH_KEY` 환경변수 설정
- [ ] Kakao Web 도메인 등록 (production URL)
- [ ] `/api/health` → `{"status":"ok"}`
- [ ] 실시간 메뉴 → 버스/지하철 카드 표시
- [ ] 경로 검색 → 타임라인(도보·환승·ETA) 표시
