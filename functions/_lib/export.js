import { buildXlsx } from './xlsx.js';
import { todayIsoKst, roundHalf } from './leave.js';

function yn(value) { return value ? '예' : '아니오'; }

function statusLabel(row) {
  if (row.status1 === 'CANCELLED' || row.status_final === 'CANCELLED') return '취소';
  if (row.status1 === 'REJECTED' || row.status_final === 'REJECTED') return '반려';
  if (row.status1 === 'APPROVED' && row.status_final === 'APPROVED') return '최종승인';
  if (row.status1 === 'APPROVED') return '최종승인 대기';
  return '1차승인 대기';
}

function leaveTypeLabel(type) {
  return ({
    FULL: '연차/기간', AM_HALF: '오전 반차', PM_HALF: '오후 반차',
    IMPORTED: '기존 연차', IMPORTED_HALF: '기존 반차', HALF_IMPORTED: '기존 반차', IMPORTED_SUMMARY: '기존 연도합계'
  })[type] || type;
}

function renewalSheet(rows, companyName, month, asOf) {
  const subtitle = `${asOf} 기준 · 조회월 ${month} · 범위: ${companyName} · 미사용 잔여는 입사기념일에 소멸되고 새 연차가 생성됩니다.`;
  return {
    name: '입사월 갱신대상', title: `${companyName} ${month} 연차 갱신 대상자`, subtitle,
    headers: ['회사', '부서', '사원코드', '직원명', '로그인 ID', '직급', '입사일', '갱신일(입사기념일)', '근속연수', '이전 주기 시작', '이전 주기 종료', '이전 주기 발생', '이전 주기 사용', '이전 주기 조정', '이전 주기 최종잔여', '소멸 예정/소멸 잔여', '초과사용', '새 연차 생성', '새 주기 시작', '새 주기 종료', '상태'],
    widths: [16, 13, 11, 11, 14, 11, 12, 15, 10, 12, 12, 12, 12, 12, 14, 16, 11, 13, 12, 12, 11],
    rows: rows.map((r) => [r.company_name, r.department, r.employee_code, r.employee_name, r.login_id, r.position, r.join_date, r.anniversary_date, `${r.completed_years}년`, r.prior_cycle_start, r.prior_cycle_end, Number(r.prior_granted), Number(r.prior_used), Number(r.prior_adjustments), Number(r.prior_balance), Number(r.unused_expiring), Number(r.overused), Number(r.new_entitlement), r.new_cycle_start, r.new_cycle_end, r.status])
  };
}

function buildExportXlsx({ userSummaries, accountSummaries = userSummaries, requestRows, adjustmentRows, renewalRows = [], companyName, asOf = todayIsoKst() }) {
  const currentYear = asOf.slice(0, 4);
  const approvedThisYear = new Map();
  for (const row of requestRows) {
    if (row.start_date?.startsWith(currentYear) && row.status1 === 'APPROVED' && row.status_final === 'APPROVED') {
      approvedThisYear.set(row.user_id, roundHalf((approvedThisYear.get(row.user_id) || 0) + Number(row.days || 0)));
    }
  }
  const subtitle = `${asOf} 기준 · 범위: ${companyName} · 현재 잔여는 입사일 기준 현재 1년 주기로 계산`;
  const currentMonth = asOf.slice(0, 7);
  return buildXlsx([
    {
      name: '연차현황', title: `${companyName} 연차 현황`, subtitle,
      headers: ['회사', '부서', '사원코드', '직원명', '로그인 ID', '직급', '입사일', '근속기간', '현재 주기 시작', '현재 주기 종료', '현재 주기 발생', '현재 주기 사용', '현재 주기 조정', '현재 잔여', '승인대기', '신청후 예상잔여', '다음 갱신일', '다음 생성일수', `${currentYear}년 사용(참고)`, '누적 발생(참고)', '누적 사용(참고)', '계정상태'],
      widths: [16, 13, 11, 11, 13, 11, 12, 12, 12, 12, 13, 13, 13, 11, 11, 15, 12, 13, 15, 14, 14, 11],
      rows: userSummaries.map((u) => [u.company_name, u.department, u.employee_code, u.employee_name, u.login_id, u.position, u.join_date, u.tenure, u.cycle_start, u.cycle_end, u.granted, u.used, u.adjustments, u.remaining, u.pending, u.projected_remaining, u.next_anniversary, u.next_entitlement, approvedThisYear.get(u.id) || 0, u.cumulative_granted, u.total_used, u.active ? '사용' : '중지'])
    },
    {
      name: '사용·신청내역', title: `${companyName} 연차 사용 및 신청 내역`, subtitle,
      headers: ['회사', '부서', '사원코드', '직원명', '로그인 ID', '구분', '시작일', '종료일', '일수', '1차 승인자', '최종 승인자', '상태', '신청사유', '반려사유', '자료구분', '자료설명', '신청일시', '1차승인일시', '최종승인일시'],
      widths: [16, 13, 11, 11, 13, 15, 12, 12, 8, 13, 13, 15, 25, 25, 13, 35, 21, 21, 21],
      rows: requestRows.map((r) => [r.company_name, r.department, r.employee_code, r.applicant_name, r.applicant_login, leaveTypeLabel(r.leave_type), r.start_date, r.end_date, Number(r.days), r.approver1_name || '', r.final_approver_name || '', statusLabel(r), r.reason || '', r.reject_reason || '', r.source === 'APPLICATION' ? '시스템 신청' : '기존 엑셀', r.source_note || '', r.created_at || '', r.approved1_at || '', r.final_approved_at || ''])
    },
    renewalSheet(renewalRows, companyName, currentMonth, asOf),
    {
      name: '연차조정내역', title: `${companyName} 관리자 연차 조정 내역`, subtitle: `${subtitle} · 조정은 적용일이 속한 1년 주기에만 반영됩니다.`,
      headers: ['회사', '직원명', '로그인 ID', '적용일', '조정일수', '조정사유', '처리자', '처리일시'],
      widths: [16, 12, 14, 12, 11, 35, 13, 21],
      rows: adjustmentRows.map((a) => [a.company_name, a.employee_name, a.login_id, a.effective_date || String(a.created_at || '').slice(0, 10), Number(a.amount), a.reason, a.created_by_name, a.created_at])
    },
    {
      name: '사용자계정', title: `${companyName} 사용자 계정 목록`, subtitle: `${subtitle} · 초기 또는 초기화 비밀번호: 1111`,
      headers: ['회사', '부서', '사원코드', '직원명', '로그인 ID', '직급', '입사일', '관리자', '1차 승인자', '최종 승인자', '승인용계정', '계정상태', '비밀번호 변경필요'],
      widths: [16, 13, 11, 11, 14, 11, 12, 10, 12, 12, 12, 11, 16],
      rows: accountSummaries.map((u) => [u.company_name, u.department, u.employee_code, u.employee_name, u.login_id, u.position, u.join_date, yn(u.is_admin), yn(u.can_approve_first), yn(u.can_approve_final), yn(u.is_system_account), u.active ? '사용' : '중지', yn(u.must_change_password)])
    }
  ], { creator: '통합 연차관리 시스템' });
}

function buildRenewalXlsx({ rows, companyName, month, asOf = todayIsoKst() }) {
  return buildXlsx([
    renewalSheet(rows, companyName, month, asOf),
    {
      name: '안내', title: '입사일 기준 연차 갱신 안내', subtitle: '회사 운영규칙에 따라 프로그램이 자동 계산합니다.',
      headers: ['항목', '내용'], widths: [24, 90],
      rows: [
        ['조회 대상', '선택한 월에 입사기념일이 있는 재직자입니다.'],
        ['소멸 잔여', '이전 1년 주기의 발생 + 조정 - 승인사용 중 0보다 큰 값입니다. 입사기념일에 새 주기가 시작되면 이 값은 현재 잔여에 이월하지 않습니다.'],
        ['새 연차 생성', '첫 1년이 지나면 15일, 이후 2년마다 1일 증가하며 최대 25일로 계산합니다.'],
        ['잔여 0 이하 신청', '현재 잔여가 0 또는 음수이더라도 연차 신청과 승인 처리가 가능합니다.'],
        ['1년 미만', '입사 후 완료한 매월 1일씩 발생하며 최대 11일입니다. 첫 입사기념일에 새 15일 주기로 전환됩니다.']
      ]
    }
  ], { creator: '통합 연차관리 시스템' });
}

function buildInitialAccountXlsx({ users, companies, sourceAsOf }) {
  const companyMap = new Map(companies.map((c) => [c.id, c.name]));
  const normalUsers = users.filter((u) => !u.is_system_account);
  const systemUsers = users.filter((u) => u.is_system_account);
  return buildXlsx([
    {
      name: '직원 로그인 계정', title: '해올·㈜더사가 직원 로그인 계정', subtitle: `${sourceAsOf} 기준 원본 엑셀 명단 40명 · 모든 최초 비밀번호 1111`,
      headers: ['회사', '부서', '사원코드', '직원명', '로그인 ID', '최초 비밀번호', '직급', '입사일', '원본 누적발생', '원본 사용', '원본 잔여', '안내'],
      widths: [16, 13, 11, 11, 14, 13, 11, 12, 13, 11, 11, 30],
      rows: normalUsers.map((u) => [companyMap.get(u.company_id) || '', u.department, u.employee_code, u.employee_name, u.login_id, '1111', u.position, u.join_date, Number(u.source_accrued || 0), Number(u.source_used || 0), Number(u.source_remaining || 0), u.login_id === u.employee_name ? '한글 이름으로 로그인' : '동명이인 구분을 위해 숫자 포함'])
    },
    {
      name: '관리·승인 계정', title: '최초 관리 및 승인용 계정', subtitle: '실제 운영 전에 관리자가 승인자를 지정하거나 계정명을 수정하세요.',
      headers: ['회사', '표시명', '로그인 ID', '최초 비밀번호', '관리자', '1차 승인자', '최종 승인자', '용도'],
      widths: [16, 15, 18, 13, 10, 12, 12, 35],
      rows: systemUsers.map((u) => [companyMap.get(u.company_id) || '전체 회사', u.employee_name, u.login_id, '1111', yn(u.is_admin), yn(u.can_approve_first), yn(u.can_approve_final), u.is_admin ? '전체 회사 통합관리' : '승인 흐름 점검용 임시 계정'])
    },
    {
      name: '로그인 안내', title: '비전문가용 첫 로그인 안내', subtitle: '압축을 푼 뒤 START_WINDOWS.bat를 더블클릭합니다.',
      headers: ['순서', '할 일', '설명'],
      widths: [9, 24, 70],
      rows: [
        [1, '프로그램 실행', 'Windows에서 START_WINDOWS.bat를 더블클릭하고 자동으로 열린 브라우저를 사용합니다.'],
        [2, '관리자 로그인', '로그인 ID 관리자 / 비밀번호 1111'],
        [3, '비밀번호 변경', '비밀번호 변경 메뉴에서 관리자 비밀번호부터 변경합니다.'],
        [4, '승인자 지정', '관리자 → 사용자관리에서 실제 1차 승인자와 최종 승인자(대표이사)에 권한을 체크합니다.'],
        [5, '직원 안내', '직원에게 이 파일의 로그인 ID와 최초 비밀번호 1111을 안내합니다.'],
        [6, '갱신대상 확인', '관리자 → 연차 갱신대상에서 해당 월 입사기념일 대상자의 소멸잔여와 새 생성연차를 조회·Excel 다운로드합니다.'],
        [7, '자료 백업', '관리자 화면의 자료 백업 버튼을 정기적으로 눌러 JSON 백업파일을 보관합니다.']
      ]
    }
  ], { creator: '통합 연차관리 시스템' });
}

export { buildExportXlsx, buildRenewalXlsx, buildInitialAccountXlsx, statusLabel, leaveTypeLabel };
