# Search Aggregator

Naver 검색 결과를 서버에서 수집하고, 관련 링크와 요약을 시간순으로 보여주는 간단한 웹 서비스입니다.

## 구조

- `client`: Vite 기반 프론트엔드
- `server`: Express 기반 검색 집계 API

## 실행 방법

1. `server/.env.example`을 참고해서 `server/.env`를 생성합니다.
2. 서버 실행: `npm run dev`
3. 클라이언트 실행: `npm run dev`

## 환경 변수

### server/.env

```
PORT=4000
NAVER_CLIENT_ID=your-naver-client-id
NAVER_CLIENT_SECRET=your-naver-client-secret
GOOGLE_API_KEY=your-google-api-key
GOOGLE_SEARCH_ENGINE_ID=your-google-search-engine-id
```

## 비고

- Naver는 `search/news` API를 사용합니다.
- Google 검색은 기존처럼 선택적으로 남겨두었고, 키가 없으면 건너뜁니다.
- 결과는 최신순으로 정렬하고, 동일 URL은 중복 제거합니다.
