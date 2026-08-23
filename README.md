# 통합 연차관리 v7.2 — Netlify 단일 운영판

v7.2는 **페이지/메뉴 전환 중 간헐적으로 발생하던 `Cannot set properties of undefined (setting 'innerHTML')` 오류를 수정한 안정화 버전**입니다.

## 이번 수정의 핵심

- 메뉴를 빠르게 이동해도 이전 화면의 늦게 도착한 API 응답이 새 화면을 덮어쓰지 않도록 페이지 요청 번호를 적용했습니다.
- 관리자 탭(사용자 관리/승인·신청내역/회사별 사용현황/미사용 정산/Excel·백업/기준정보·휴일/회사 설정)에도 탭별 요청 번호를 적용했습니다.
- `admin-stats`가 이미 사라진 뒤 `statEls[0].innerHTML`을 실행하던 오류를 차단했습니다.
- 비동기 조회가 끝난 시점에 대상 화면이 존재하는지 다시 확인한 뒤에만 화면을 갱신합니다.
- v7.1의 직원·퇴사일·삭제·비밀번호 초기화·다단계 전자결재·기존 Excel 이관자료 기능은 그대로 유지합니다.
- Netlify Blobs 운영자료는 초기화하지 않습니다.

## 기존 데이터

- 회사: 해올 + ㈜더사가
- 실제 직원 초기자료: 40명
- 기존 연차 사용기록: 761건
- 기존 사용일수: 808.5일
- 운영 중 추가/수정된 자료: Netlify Blobs에 그대로 유지

## 업데이트 방법

1. 현재 사이트에서 `관리자 → Excel·백업 → JSON 백업 다운로드`
2. `leave_manager_netlify_v7_2.zip`을 별도 폴더에 압축 해제
3. GitHub Desktop에서 `Thesaga_Annual` 선택
4. `Repository → Show in Explorer`
5. 압축을 푼 v7.2 폴더 **안의 내용 전체**를 기존 GitHub 폴더에 덮어쓰기
6. `.git` 폴더는 절대로 삭제하지 않기
7. GitHub Desktop Summary: `v7.2 메뉴전환 오류 수정`
8. `Commit to main`
9. `Push origin`
10. Netlify `Deploys`에서 새 배포가 `Published`가 될 때까지 대기
11. `https://thesaga-annual.netlify.app`에서 `Ctrl+F5`

## 확인 순서

- 통합관리자 대시보드 → 관리자 메뉴 → 대시보드 → 관리자 메뉴를 여러 번 연속 선택
- 관리자 메뉴에서 `사용자 관리 → 승인·신청내역 → 회사별 사용현황 → 기준정보·휴일 → 사용자 관리`를 빠르게 이동
- 빨간 오류 박스가 나타나지 않는지 확인

## 운영 구조

`GitHub Desktop → GitHub(Thesaga_Annual) → Netlify 자동 배포 → Netlify Blobs 데이터 저장`

새 Netlify 프로젝트를 만들 필요가 없습니다.
