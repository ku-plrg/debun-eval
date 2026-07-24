# debun-eval

DEBUN의 라이브러리 탐지 기술로 `pnpm-sep-25-annotated.json` 데이터셋에 대한
**웹 번들 내 오픈소스 라이브러리 탐지 성능(F1-score)** 을 측정한다.
번들 소스코드에서 함수 지문(POG)을 추출해 라이브러리 DB와 대조하여 탐지한다.

## 개요

| 항목 | 내용 |
|---|---|
| 데이터셋 | `dataset/pnpm-sep-25-annotated.json` — 79개 웹사이트(상위 10만 도메인 중 정답 존재하는 웹사이트) |
| 라이브러리 DB | 206개 라이브러리, 전체 clean-release 버전(13,066개) → `db/all-hash.json`, `db/all-libs.json` |
| 합격 기준 | **F1-score 50% 이상** |

```
Precision = TP / (TP + FP)      # TP: 정답 라이브러리를 탐지
Recall    = TP / (TP + FN)      # FP: 정답에 없는 라이브러리를 탐지
F1-score  = 2 × Precision × Recall / (Precision + Recall) × 100   # FN: 정답을 탐지 못함
```

## 사전 준비 (모델·DB 구축) — 약 1.5~3시간

```bash
npm install            # 의존성 설치                                     [약 1분]
npm run collect-corpus # 라이브러리 전체 버전 소스 수집 → corpus/  [약 1~2시간, ~14GB, 재개 가능]
npm run build-db       # POG 지문 DB 구축 → db/                          [약 30분~1시간]
```

> 한 번 구축한 `db/`가 있으면 이후 채점(`npm run evaluate`)은 1~2분정도 소요.

## 시험 절차

1) 클라이언트 터미널에서 프로젝트(`debun-eval`) 디렉토리로 이동한다.
2) 라이브러리 탐지 모델 성능평가 스크립트를 실행한다.
   ```bash
   npm run evaluate
   ```
3) 79개 웹사이트에 대한 탐지 결과가 저장된 Output 파일을 확인한다.
   - `out/eval-<db>.json` — 상세 결과(웹사이트별 TP/FP/FN 집계)
   - `out/detected-<db>.csv` — 웹사이트별 탐지된 라이브러리 목록(정답 대비)
4) 터미널에 출력된 `F1` 값으로 라이브러리 탐지 모델의 F1-score가 50 이상인지 확인한다.
   ```
   Precision=67.5%  Recall=55.2%  F1=60.7%
   ```

## 결과

| Precision | Recall | F1-score | 판정 |
|---|---|---|---|
| 67.5% | 55.2% | **60.7%** | ≥ 50% |
