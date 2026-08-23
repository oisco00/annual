import { INITIAL_STATE } from '../_lib/initial-state.js';
import {
  parseIso, todayIsoKst, addDays, cumulativeGranted, currentEntitlement, serviceCycle,
  anniversaryInYear, priorCycleForAnniversary, tenureLabel, isWeekday,
  countBusinessDays, normalizeLoginBase, roundHalf
} from '../_lib/leave.js';

const SESSION_SECONDS = 10 * 60 * 60;
const DEFAULT_HASH = 'pbkdf2$100000$7a8e927109f2b5d4c8a18fd3418f9352$fcfbf0d30d90aefca3e450e6bee44a9e50b9e5f364e105d80db5b69b98d3a5ac';

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const cleanText = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);
const boolValue = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
const numberId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const nowIso = () => new Date().toISOString();
const matchPath = (pathname, pattern) => { const m = pattern.exec(pathname); return m ? m.slice(1).map(decodeURIComponent) : null; };
const enc = new TextEncoder();

function hex(bytes) { return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join(''); }
function fromHex(s) { const out = new Uint8Array(s.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i*2,i*2+2),16); return out; }
function randomHex(bytes = 32) { const b = new Uint8Array(bytes); crypto.getRandomValues(b); return hex(b); }
async function passwordHash(password, saltHex = null, iterations = 100000) {
  if (String(password) === '1111' && !saltHex) return DEFAULT_HASH;
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name:'PBKDF2', salt, iterations, hash:'SHA-256' }, key, 256);
  return `pbkdf2$${iterations}$${hex(salt)}$${hex(bits)}`;
}
async function verifyPassword(password, encoded) {
  try {
    const [scheme,it,saltHex,hashHex] = String(encoded||'').split('$');
    if (scheme !== 'pbkdf2') return false;
    const actual = await passwordHash(password, saltHex, Number(it));
    const a = fromHex(actual.split('$')[3]); const b = fromHex(hashHex);
    if (a.length !== b.length) return false;
    let diff = 0; for (let i=0;i<a.length;i++) diff |= a[i]^b[i]; return diff === 0;
  } catch { return false; }
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...extra } });
}
function fileResponse(bytes, type, filename) {
  return new Response(bytes, { status:200, headers:{ 'Content-Type':type, 'Cache-Control':'no-store', 'Content-Disposition':`attachment; filename="leave-manager${filename.endsWith('.xlsx')?'.xlsx':filename.endsWith('.json')?'.json':''}"; filename*=UTF-8''${encodeURIComponent(filename)}` } });
}
function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) { const i=part.indexOf('='); if(i>0 && part.slice(0,i).trim()===name) return decodeURIComponent(part.slice(i+1).trim()); }
  return '';
}

async function initDb(DB) {
  if (!DB) throw new HttpError(500, 'Cloudflare D1 데이터베이스(DB)가 연결되지 않았습니다. 설정에서 DB 바인딩을 추가해 주세요.');
  await DB.prepare(`CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, json TEXT NOT NULL, updated_at TEXT NOT NULL)`).run();
  await DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL)`).run();
  const row = await DB.prepare('SELECT id FROM app_state WHERE id=1').first();
  if (!row) await DB.prepare('INSERT INTO app_state(id,version,json,updated_at) VALUES(1,1,?,?)').bind(JSON.stringify(INITIAL_STATE), nowIso()).run();
}
async function loadState(DB) { const row = await DB.prepare('SELECT version,json FROM app_state WHERE id=1').first(); return { version:Number(row.version), state:JSON.parse(row.json) }; }
async function saveState(DB, version, state) {
  state.updated_at = nowIso();
  const r = await DB.prepare('UPDATE app_state SET version=version+1,json=?,updated_at=? WHERE id=1 AND version=?').bind(JSON.stringify(state), state.updated_at, version).run();
  if (!r?.meta?.changes) throw new HttpError(409, '다른 사용자가 동시에 자료를 처리했습니다. 화면을 새로고침한 뒤 다시 시도해 주세요.');
}

function companyById(s,id){ return s.companies.find(c=>c.id===Number(id))||null; }
function activeCompany(s,id){ const c=companyById(s,id); return c&&c.active?c:null; }
function userById(s,id){ return s.users.find(u=>u.id===Number(id))||null; }
function userByLogin(s,login){ return s.users.find(u=>u.login_id===login)||null; }
function companyName(s,id){ return companyById(s,id)?.name || '전체 회사'; }
function requestDaysInRange(request, a, b) {
  if(!a||!b) return Number(request.days||0);
  if(!request.start_date||!request.end_date||request.end_date<a||request.start_date>b) return 0;
  if(request.leave_type==='IMPORTED_SUMMARY') return request.start_date>=a&&request.start_date<=b?Number(request.days||0):0;
  if(['AM_HALF','PM_HALF','IMPORTED_HALF','HALF_IMPORTED'].includes(request.leave_type)) return request.start_date>=a&&request.start_date<=b?Number(request.days||0.5):0;
  const start=request.start_date>a?request.start_date:a; const end=request.end_date<b?request.end_date:b;
  if(request.start_date===request.end_date) return Number(request.days||0);
  return countBusinessDays(start,end);
}
function approvedUsedDays(s,userId,a=null,b=null){ return roundHalf(s.requests.filter(r=>r.user_id===Number(userId)&&r.status1==='APPROVED'&&r.status_final==='APPROVED').reduce((sum,r)=>sum+requestDaysInRange(r,a,b),0)); }
function pendingDays(s,userId,exclude=null,a=null,b=null){ return roundHalf(s.requests.filter(r=>r.user_id===Number(userId)&&r.id!==Number(exclude)&&r.source==='APPLICATION'&&(r.status1==='PENDING'||(r.status1==='APPROVED'&&r.status_final==='WAITING'))).reduce((sum,r)=>sum+requestDaysInRange(r,a,b),0)); }
function adjustmentEffectiveDate(a){ return cleanText(a.effective_date||String(a.created_at||'').slice(0,10),10); }
function adjustmentTotal(s,userId,a=null,b=null){ return roundHalf(s.adjustments.filter(x=>x.user_id===Number(userId)&&(!a||!b||(adjustmentEffectiveDate(x)>=a&&adjustmentEffectiveDate(x)<=b))).reduce((sum,x)=>sum+Number(x.amount||0),0)); }
function currentCycleBalance(s,user,asOf=todayIsoKst()){
  const cycle=serviceCycle(user.join_date,asOf); if(!cycle) return null;
  const used=approvedUsedDays(s,user.id,cycle.cycle_start,cycle.cycle_end), pending=pendingDays(s,user.id,null,cycle.cycle_start,cycle.cycle_end), adjustments=adjustmentTotal(s,user.id,cycle.cycle_start,cycle.cycle_end);
  const remaining=roundHalf(Number(cycle.granted||0)+adjustments-used); return {...cycle,used,pending,adjustments,remaining,projected_remaining:roundHalf(remaining-pending)};
}
function roleLabel(u){ const r=[]; if(u.is_admin)r.push('관리자'); if(u.can_approve_first)r.push('1차 승인자'); if(u.can_approve_final)r.push('최종 승인자'); if(!r.length)r.push('사용자'); return r.join(' · '); }
function userSummary(s,u,asOf=todayIsoKst()){
  if(!u) return null; const system=Boolean(u.is_system_account), cycle=system?null:currentCycleBalance(s,u,asOf);
  const granted=system?0:Number(cycle?.granted||0), current=system?0:currentEntitlement(u.join_date,asOf), used=system?0:Number(cycle?.used||0), pending=system?0:Number(cycle?.pending||0), adjustments=system?0:Number(cycle?.adjustments||0), remaining=system?0:Number(cycle?.remaining||0), projected=system?0:Number(cycle?.projected_remaining||0);
  return { id:u.id,company_id:u.company_id,company_name:companyName(s,u.company_id),employee_code:u.employee_code||'',employee_name:u.employee_name,login_id:u.login_id,department:u.department||'',position:u.position||'',join_date:u.join_date,is_admin:Boolean(u.is_admin),can_approve_first:Boolean(u.can_approve_first),can_approve_final:Boolean(u.can_approve_final),is_system_account:system,active:Boolean(u.active),must_change_password:Boolean(u.must_change_password),source_accrued:u.source_accrued,source_used:u.source_used,source_remaining:u.source_remaining,role_label:roleLabel(u),tenure:system?'-':tenureLabel(u.join_date,asOf),current_entitlement:current,cumulative_granted:system?0:cumulativeGranted(u.join_date,asOf),total_used:system?0:approvedUsedDays(s,u.id),total_adjustments:system?0:adjustmentTotal(s,u.id),service_year:system?null:cycle?.service_year,cycle_start:system?'':cycle?.cycle_start,cycle_end:system?'':cycle?.cycle_end,next_anniversary:system?'':cycle?.next_anniversary,next_entitlement:system?0:cycle?.next_entitlement,granted,used,pending,adjustments,remaining,available:projected,projected_remaining:projected,over_request_allowed:true,as_of:asOf };
}
function requestRow(s,r){ const a=userById(s,r.user_id),f=userById(s,r.approver1_id),z=userById(s,r.final_approver_id); return {...r,company_id:a?.company_id??null,company_name:companyName(s,a?.company_id),department:a?.department||'',employee_code:a?.employee_code||'',applicant_name:a?.employee_name||'',applicant_login:a?.login_id||'',approver1_name:f?.employee_name||'',approver1_login:f?.login_id||'',final_approver_name:z?.employee_name||'',final_approver_login:z?.login_id||''}; }
function allRequestRows(s){ return s.requests.map(r=>requestRow(s,r)).sort((a,b)=>String(b.start_date).localeCompare(String(a.start_date))||b.id-a.id); }
function sortUsers(s,users){ return [...users].sort((a,b)=>companyName(s,a.company_id).localeCompare(companyName(s,b.company_id),'ko')||(Number(a.is_system_account)-Number(b.is_system_account))||String(a.department||'').localeCompare(String(b.department||''),'ko')||String(a.employee_name||'').localeCompare(String(b.employee_name||''),'ko')||String(a.login_id).localeCompare(String(b.login_id),'ko')); }
function generateLoginId(s,name,excluded=null){ const base=normalizeLoginBase(name), exists=(x)=>s.users.some(u=>u.login_id===x&&u.id!==Number(excluded)); if(!exists(base))return base; let n=2; while(exists(`${base}${n}`))n++; return `${base}${n}`; }
function hasLeaveConflict(s,userId,type,start,end){ const c=s.requests.filter(r=>r.user_id===Number(userId)&&!['REJECTED','CANCELLED'].includes(r.status1)&&!['REJECTED','CANCELLED'].includes(r.status_final)&&r.leave_type!=='IMPORTED_SUMMARY'&&r.start_date<=end&&r.end_date>=start); if(!c.length)return null; if(type==='FULL')return c[0]; return c.find(r=>['FULL','IMPORTED','IMPORTED_HALF',type].includes(r.leave_type))||null; }
function renewalRows(s,ym,companyId=null,asOf=todayIsoKst()){
  const m=/^(\d{4})-(\d{2})$/.exec(String(ym||'')); if(!m)throw new HttpError(400,'조회 월을 YYYY-MM 형식으로 선택해 주세요.'); const year=Number(m[1]),month=Number(m[2]); if(month<1||month>12)throw new HttpError(400,'조회 월을 확인해 주세요.');
  return sortUsers(s,s.users.filter(u=>!u.is_system_account&&u.active&&(!companyId||u.company_id===companyId))).map(u=>{ const ad=anniversaryInYear(u.join_date,year); if(!ad||ad.slice(5,7)!==String(month).padStart(2,'0'))return null; const p=priorCycleForAnniversary(u.join_date,ad); if(!p)return null; const used=approvedUsedDays(s,u.id,p.prior_cycle_start,p.prior_cycle_end),adj=adjustmentTotal(s,u.id,p.prior_cycle_start,p.prior_cycle_end),bal=roundHalf(p.prior_granted+adj-used),nc=serviceCycle(u.join_date,ad),status=ad<asOf?'갱신완료':ad===asOf?'오늘 갱신':'갱신예정'; return {user_id:u.id,company_id:u.company_id,company_name:companyName(s,u.company_id),department:u.department||'',employee_code:u.employee_code||'',employee_name:u.employee_name,login_id:u.login_id,position:u.position||'',join_date:u.join_date,anniversary_date:ad,completed_years:p.completed_years,prior_cycle_start:p.prior_cycle_start,prior_cycle_end:p.prior_cycle_end,prior_granted:p.prior_granted,prior_used:used,prior_adjustments:adj,prior_balance:bal,unused_expiring:Math.max(0,bal),overused:Math.max(0,-bal),new_entitlement:p.new_entitlement,new_cycle_start:nc?.cycle_start||ad,new_cycle_end:nc?.cycle_end||'',status}; }).filter(Boolean).sort((a,b)=>a.anniversary_date.localeCompare(b.anniversary_date)||a.company_name.localeCompare(b.company_name,'ko')||a.employee_name.localeCompare(b.employee_name,'ko'));
}

async function sessionUser(request,env,s){
  const token=getCookie(request,'leave.sid'); if(!token)return null;
  const row=await env.DB.prepare('SELECT user_id,expires_at FROM sessions WHERE token=?').bind(token).first(); if(!row||Number(row.expires_at)<Date.now()){ if(row)await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(token).run(); return null; }
  const u=userById(s,row.user_id); if(!u||!u.active||(u.company_id!=null&&!activeCompany(s,u.company_id))){ await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(token).run(); return null; } return u;
}
async function requireAuth(request,env,s){ const u=await sessionUser(request,env,s); if(!u)throw new HttpError(401,'로그인이 필요합니다.'); return u; }
async function requireAdmin(request,env,s){ const u=await requireAuth(request,env,s); if(!u.is_admin)throw new HttpError(403,'관리자 권한이 필요합니다.'); return u; }

async function parseBody(request){ if(!['POST','PUT','PATCH'].includes(request.method))return {}; try{return await request.json();}catch{return {};}}

async function handle(context){
  const { request, env } = context; await initDb(env.DB); const {version,state:s}=await loadState(env.DB); const url=new URL(request.url), pathname=url.pathname, method=request.method, body=await parseBody(request);

  if(method==='GET'&&pathname==='/api/health') return json({ok:true,service:'two-company-leave-manager-cloudflare',date:todayIsoKst(),storage:'Cloudflare D1'});
  if(method==='GET'&&pathname==='/api/initial-info') return json({company_count:s.companies.filter(c=>c.active).length,employee_count:s.users.filter(u=>!u.is_system_account&&u.active).length,source:s.source_verification||null});
  if(method==='POST'&&pathname==='/api/login'){
    const loginId=cleanText(body.login_id,80), password=String(body.password||''), u=userByLogin(s,loginId); const ok=Boolean(u&&u.active&&await verifyPassword(password,u.password_hash)); if(!ok)throw new HttpError(401,'로그인 ID 또는 비밀번호가 올바르지 않습니다.');
    const token=randomHex(32), exp=Date.now()+SESSION_SECONDS*1000; await env.DB.prepare('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)').bind(token,u.id,exp).run();
    return json(userSummary(s,u),200,{'Set-Cookie':`leave.sid=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_SECONDS}`});
  }
  if(method==='POST'&&pathname==='/api/logout'){ await requireAuth(request,env,s); const token=getCookie(request,'leave.sid'); if(token)await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(token).run(); return json({ok:true},200,{'Set-Cookie':'leave.sid=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'}); }
  if(method==='GET'&&pathname==='/api/me') return json(userSummary(s,await requireAuth(request,env,s)));
  if(method==='POST'&&pathname==='/api/change-password'){
    const u=await requireAuth(request,env,s), cur=String(body.current_password||''), np=String(body.new_password||''), cp=String(body.confirm_password||''); if(!await verifyPassword(cur,u.password_hash))throw new HttpError(400,'현재 비밀번호가 일치하지 않습니다.'); if(np.length<4||np.length>100)throw new HttpError(400,'새 비밀번호는 4자 이상 100자 이하로 입력해 주세요.'); if(np!==cp)throw new HttpError(400,'새 비밀번호 확인이 일치하지 않습니다.'); if(np==='1111')throw new HttpError(400,'초기 비밀번호 1111과 다른 비밀번호를 사용해 주세요.'); u.password_hash=await passwordHash(np); u.must_change_password=false; u.updated_at=nowIso(); await saveState(env.DB,version,s); return json({ok:true});
  }
  if(method==='GET'&&pathname==='/api/companies'){ await requireAuth(request,env,s); return json([...s.companies].sort((a,b)=>a.name.localeCompare(b.name,'ko'))); }
  if(method==='POST'&&pathname==='/api/companies'){ await requireAdmin(request,env,s); const name=cleanText(body.name,100); if(!name)throw new HttpError(400,'회사명을 입력해 주세요.'); if(s.companies.some(c=>c.name===name))throw new HttpError(400,'동일한 회사명이 이미 등록되어 있습니다.'); const t=nowIso(), rec={id:s.counters.company++,name,active:true,created_at:t,updated_at:t}; s.companies.push(rec); await saveState(env.DB,version,s); return json(rec); }
  let p=matchPath(pathname,/^\/api\/companies\/(\d+)$/);
  if(method==='PUT'&&p){ await requireAdmin(request,env,s); const c=companyById(s,p[0]); if(!c)throw new HttpError(404,'회사를 찾을 수 없습니다.'); const name=cleanText(body.name,100); if(!name)throw new HttpError(400,'회사명을 입력해 주세요.'); if(s.companies.some(x=>x.name===name&&x.id!==c.id))throw new HttpError(400,'동일한 회사명이 이미 등록되어 있습니다.'); c.name=name;c.active=boolValue(body.active);c.updated_at=nowIso();await saveState(env.DB,version,s);return json({ok:true}); }
  if(method==='GET'&&pathname==='/api/approvers'){ const u=await requireAuth(request,env,s); if(u.company_id==null)return json({first:[],final:[]}); const same=s.users.filter(x=>x.company_id===u.company_id&&x.active&&x.id!==u.id), simp=x=>({id:x.id,employee_name:x.employee_name,login_id:x.login_id,department:x.department,position:x.position}); return json({first:same.filter(x=>x.can_approve_first).sort((a,b)=>a.employee_name.localeCompare(b.employee_name,'ko')).map(simp),final:same.filter(x=>x.can_approve_final).sort((a,b)=>a.employee_name.localeCompare(b.employee_name,'ko')).map(simp)}); }
  if(method==='POST'&&pathname==='/api/leave-requests'){
    const u=await requireAuth(request,env,s); if(u.is_system_account||u.company_id==null)throw new HttpError(400,'직원 본인 계정만 연차를 신청할 수 있습니다.'); const type=cleanText(body.leave_type,30); let start=cleanText(body.start_date,10),end=cleanText(body.end_date,10); const a1=numberId(body.approver1_id),af=numberId(body.final_approver_id),reason=cleanText(body.reason,500); if(!['FULL','AM_HALF','PM_HALF'].includes(type))throw new HttpError(400,'연차 신청 구분을 확인해 주세요.'); if(!parseIso(start)||!parseIso(end)||end<start)throw new HttpError(400,'신청 날짜를 정확히 입력해 주세요.'); if(start<todayIsoKst())throw new HttpError(400,'지난 날짜는 새로 신청할 수 없습니다.'); let days; if(type==='FULL'){days=countBusinessDays(start,end);if(days<1)throw new HttpError(400,'선택한 기간에 평일이 없습니다.');}else{end=start;if(!isWeekday(start))throw new HttpError(400,'반차는 평일에만 신청할 수 있습니다.');days=.5;} const first=userById(s,a1),final=userById(s,af); if(!first||!first.active||first.company_id!==u.company_id||!first.can_approve_first)throw new HttpError(400,'1차 승인자를 확인해 주세요.'); if(!final||!final.active||final.company_id!==u.company_id||!final.can_approve_final)throw new HttpError(400,'최종 승인자를 확인해 주세요.'); if(first.id===final.id)throw new HttpError(400,'1차 승인자와 최종 승인자는 서로 다르게 선택해 주세요.'); if(first.id===u.id||final.id===u.id)throw new HttpError(400,'신청자 본인을 승인자로 선택할 수 없습니다.'); if(hasLeaveConflict(s,u.id,type,start,end))throw new HttpError(400,'같은 날짜에 이미 등록되거나 신청 중인 연차가 있습니다.'); const t=nowIso(),rec={id:s.counters.request++,user_id:u.id,approver1_id:first.id,final_approver_id:final.id,leave_type:type,start_date:start,end_date:end,days,reason,status1:'PENDING',status_final:'WAITING',reject_reason:'',source:'APPLICATION',source_note:'',created_at:t,updated_at:t,approved1_at:null,final_approved_at:null,cancelled_at:null};s.requests.push(rec);await saveState(env.DB,version,s);return json({ok:true,id:rec.id,days});
  }
  if(method==='GET'&&pathname==='/api/my-requests'){ const u=await requireAuth(request,env,s); return json(allRequestRows(s).filter(r=>r.user_id===u.id)); }
  p=matchPath(pathname,/^\/api\/requests\/(\d+)\/cancel$/);
  if(method==='POST'&&p){ const u=await requireAuth(request,env,s),r=s.requests.find(x=>x.id===Number(p[0])); if(!r||r.user_id!==u.id)throw new HttpError(404,'신청내역을 찾을 수 없습니다.'); if(r.source!=='APPLICATION')throw new HttpError(400,'기존 엑셀 이관자료는 취소할 수 없습니다.'); if(r.status1==='APPROVED'&&r.status_final==='APPROVED')throw new HttpError(400,'최종 승인된 신청은 사용자가 취소할 수 없습니다. 관리자에게 문의해 주세요.'); if(['REJECTED','CANCELLED'].includes(r.status1)||['REJECTED','CANCELLED'].includes(r.status_final))throw new HttpError(400,'이미 처리된 신청입니다.');r.status1='CANCELLED';r.status_final='CANCELLED';r.cancelled_at=nowIso();r.updated_at=r.cancelled_at;await saveState(env.DB,version,s);return json({ok:true}); }
  if(method==='GET'&&pathname==='/api/inbox'){ const u=await requireAuth(request,env,s); return json(allRequestRows(s).filter(r=>(r.approver1_id===u.id&&r.status1==='PENDING')||(r.final_approver_id===u.id&&r.status1==='APPROVED'&&r.status_final==='WAITING')).map(r=>({...r,stage:r.approver1_id===u.id&&r.status1==='PENDING'?'FIRST':'FINAL'}))); }
  p=matchPath(pathname,/^\/api\/requests\/(\d+)\/action$/);
  if(method==='POST'&&p){ const u=await requireAuth(request,env,s),r=s.requests.find(x=>x.id===Number(p[0])); if(!r||r.source!=='APPLICATION')throw new HttpError(404,'처리할 신청을 찾을 수 없습니다.'); const action=cleanText(body.action,20),reason=cleanText(body.reason,500),t=nowIso(); if(!['approve','reject'].includes(action))throw new HttpError(400,'처리 구분을 확인해 주세요.'); if(r.status1==='PENDING'){if(r.approver1_id!==u.id||!u.can_approve_first)throw new HttpError(403,'이 신청의 1차 승인자가 아닙니다.');if(action==='reject'&&!reason)throw new HttpError(400,'반려 사유를 입력해 주세요.');r.status1=action==='approve'?'APPROVED':'REJECTED';r.reject_reason=action==='reject'?reason:'';r.approved1_at=t;r.updated_at=t;}else if(r.status1==='APPROVED'&&r.status_final==='WAITING'){if(r.final_approver_id!==u.id||!u.can_approve_final)throw new HttpError(403,'이 신청의 최종 승인자가 아닙니다.');if(action==='reject'&&!reason)throw new HttpError(400,'반려 사유를 입력해 주세요.');r.status_final=action==='approve'?'APPROVED':'REJECTED';r.reject_reason=action==='reject'?reason:r.reject_reason;r.final_approved_at=t;r.updated_at=t;}else throw new HttpError(400,'현재 처리할 수 없는 상태입니다.');await saveState(env.DB,version,s);return json({ok:true}); }
  if(method==='GET'&&pathname==='/api/admin/stats'){ await requireAdmin(request,env,s); const cid=numberId(url.searchParams.get('company_id')), ids=new Set(s.users.filter(u=>!u.is_system_account&&(!cid||u.company_id===cid)).map(u=>u.id)),rs=s.requests.filter(r=>ids.has(r.user_id)),cy=todayIsoKst().slice(0,4);return json({employee_count:ids.size,pending_count:rs.filter(r=>r.source==='APPLICATION'&&(r.status1==='PENDING'||(r.status1==='APPROVED'&&r.status_final==='WAITING'))).length,approved_this_year:roundHalf(rs.filter(r=>r.start_date.startsWith(cy)&&r.status1==='APPROVED'&&r.status_final==='APPROVED').reduce((sum,r)=>sum+Number(r.days),0))}); }
  if(method==='GET'&&pathname==='/api/users'){ await requireAdmin(request,env,s); const cid=numberId(url.searchParams.get('company_id')),inc=boolValue(url.searchParams.get('include_system')),search=cleanText(url.searchParams.get('search'),80).toLowerCase(); const rows=sortUsers(s,s.users.filter(u=>(!cid||u.company_id===cid)&&(inc||!u.is_system_account)&&(!search||[u.employee_name,u.login_id,u.employee_code,u.department].some(v=>String(v||'').toLowerCase().includes(search)))));return json(rows.map(u=>userSummary(s,u))); }
  if(method==='POST'&&pathname==='/api/users'){ await requireAdmin(request,env,s); const cid=numberId(body.company_id),company=activeCompany(s,cid),name=cleanText(body.employee_name,100),join=cleanText(body.join_date,10);if(!company||!name||!parseIso(join))throw new HttpError(400,'회사, 직원명, 입사일을 정확히 입력해 주세요.');const requested=cleanText(body.login_id,80),login=requested||generateLoginId(s,name);if(userByLogin(s,login))throw new HttpError(400,'이미 사용 중인 로그인 ID입니다.');const t=nowIso(),u={id:s.counters.user++,company_id:cid,employee_code:cleanText(body.employee_code,40),employee_name:name,login_id:login,password_hash:DEFAULT_HASH,department:cleanText(body.department,100),position:cleanText(body.position,100),join_date:join,is_admin:boolValue(body.is_admin),can_approve_first:boolValue(body.can_approve_first),can_approve_final:boolValue(body.can_approve_final),is_system_account:boolValue(body.is_system_account),active:body.active==null?true:boolValue(body.active),must_change_password:true,source_accrued:null,source_used:null,source_remaining:null,created_at:t,updated_at:t};s.users.push(u);await saveState(env.DB,version,s);return json({id:u.id,login_id:u.login_id,default_password:'1111'}); }
  p=matchPath(pathname,/^\/api\/users\/(\d+)$/);
  if(method==='PUT'&&p){ const admin=await requireAdmin(request,env,s),u=userById(s,p[0]);if(!u)throw new HttpError(404,'사용자를 찾을 수 없습니다.');const cid=u.company_id==null?null:numberId(body.company_id||u.company_id);if(u.company_id!=null&&!activeCompany(s,cid))throw new HttpError(400,'회사를 확인해 주세요.');const name=cleanText(body.employee_name,100),login=cleanText(body.login_id,80),join=cleanText(body.join_date,10);if(!name||!login||!parseIso(join))throw new HttpError(400,'직원명, 로그인 ID, 입사일은 필수입니다.');if(s.users.some(x=>x.login_id===login&&x.id!==u.id))throw new HttpError(400,'이미 사용 중인 로그인 ID입니다.');if(u.id===admin.id&&!boolValue(body.is_admin))throw new HttpError(400,'현재 로그인한 관리자 본인의 관리자 권한은 해제할 수 없습니다.');if(u.id===admin.id&&!boolValue(body.active))throw new HttpError(400,'현재 로그인한 관리자 본인의 계정은 중지할 수 없습니다.');Object.assign(u,{company_id:u.company_id==null?null:cid,employee_code:cleanText(body.employee_code,40),employee_name:name,login_id:login,department:cleanText(body.department,100),position:cleanText(body.position,100),join_date:join,is_admin:boolValue(body.is_admin),can_approve_first:boolValue(body.can_approve_first),can_approve_final:boolValue(body.can_approve_final),is_system_account:boolValue(body.is_system_account),active:boolValue(body.active),updated_at:nowIso()});await saveState(env.DB,version,s);return json({ok:true}); }
  p=matchPath(pathname,/^\/api\/users\/(\d+)\/reset-password$/);
  if(method==='POST'&&p){ await requireAdmin(request,env,s);const u=userById(s,p[0]);if(!u)throw new HttpError(404,'사용자를 찾을 수 없습니다.');u.password_hash=DEFAULT_HASH;u.must_change_password=true;u.updated_at=nowIso();await saveState(env.DB,version,s);return json({ok:true,password:'1111'}); }
  p=matchPath(pathname,/^\/api\/users\/(\d+)\/adjustments$/);
  if(method==='POST'&&p){ const admin=await requireAdmin(request,env,s),u=userById(s,p[0]),amount=Number(body.amount),reason=cleanText(body.reason,500);if(!u||u.is_system_account)throw new HttpError(400,'연차 조정 대상 사용자를 확인해 주세요.');if(!Number.isFinite(amount)||amount===0||Math.abs(amount*2-Math.round(amount*2))>1e-9)throw new HttpError(400,'조정 일수는 0.5일 단위의 0이 아닌 값으로 입력해 주세요.');if(!reason)throw new HttpError(400,'조정 사유를 입력해 주세요.');const rec={id:s.counters.adjustment++,user_id:u.id,amount,reason,effective_date:todayIsoKst(),created_by:admin.id,created_at:nowIso()};s.adjustments.push(rec);await saveState(env.DB,version,s);return json({ok:true,id:rec.id,summary:userSummary(s,u)}); }
  if(method==='GET'&&p){ await requireAdmin(request,env,s);const uid=Number(p[0]);return json(s.adjustments.filter(x=>x.user_id===uid).sort((a,b)=>b.id-a.id).map(x=>{const u=userById(s,x.user_id),m=userById(s,x.created_by);return {...x,employee_name:u?.employee_name||'',login_id:u?.login_id||'',company_name:companyName(s,u?.company_id),created_by_name:m?.employee_name||''};})); }
  if(method==='GET'&&pathname==='/api/admin/renewals'){ await requireAdmin(request,env,s);const cid=numberId(url.searchParams.get('company_id')),company=cid?activeCompany(s,cid):null;if(cid&&!company)throw new HttpError(400,'회사를 확인해 주세요.');const month=cleanText(url.searchParams.get('month')||todayIsoKst().slice(0,7),7),only=boolValue(url.searchParams.get('only_unused'));let rows=renewalRows(s,month,cid,todayIsoKst());if(only)rows=rows.filter(r=>r.unused_expiring>0);return json({month,company_name:company?.name||'전체회사',count:rows.length,rows}); }
  if(method==='GET'&&pathname==='/api/admin/requests'){ await requireAdmin(request,env,s);const cid=numberId(url.searchParams.get('company_id')),from=cleanText(url.searchParams.get('from'),10),to=cleanText(url.searchParams.get('to'),10),status=cleanText(url.searchParams.get('status'),20),source=cleanText(url.searchParams.get('source'),30);return json(allRequestRows(s).filter(r=>{if(cid&&r.company_id!==cid)return false;if(from&&r.start_date<from)return false;if(to&&r.start_date>to)return false;if(status==='PENDING'&&!(r.status1==='PENDING'||(r.status1==='APPROVED'&&r.status_final==='WAITING')))return false;if(status==='APPROVED'&&!(r.status1==='APPROVED'&&r.status_final==='APPROVED'))return false;if(status==='REJECTED'&&!(r.status1==='REJECTED'||r.status_final==='REJECTED'))return false;if(source&&r.source!==source)return false;return true;})); }
  if(method==='GET'&&pathname==='/api/admin/export-data'){ await requireAdmin(request,env,s);const cid=numberId(url.searchParams.get('company_id')),company=cid?activeCompany(s,cid):null;if(cid&&!company)throw new HttpError(400,'회사를 확인해 주세요.');const selected=sortUsers(s,s.users.filter(u=>!u.is_system_account&&(!cid||u.company_id===cid))),accounts=sortUsers(s,s.users.filter(u=>cid?u.company_id===cid:true)),userSummaries=selected.map(u=>userSummary(s,u)),accountSummaries=accounts.map(u=>userSummary(s,u)),ids=new Set(selected.map(u=>u.id)),requestRows=allRequestRows(s).filter(r=>ids.has(r.user_id)),adjustmentRows=s.adjustments.filter(r=>ids.has(r.user_id)).sort((a,b)=>b.id-a.id).map(r=>{const u=userById(s,r.user_id),m=userById(s,r.created_by);return {...r,employee_name:u?.employee_name||'',login_id:u?.login_id||'',company_name:companyName(s,u?.company_id),created_by_name:m?.employee_name||''};}),companyNameValue=company?.name||'전체회사',asOf=todayIsoKst(),currentMonth=asOf.slice(0,7),renewalRowsValue=renewalRows(s,currentMonth,cid,asOf);return json({userSummaries,accountSummaries,requestRows,adjustmentRows,renewalRows:renewalRowsValue,companyName:companyNameValue,asOf}); }
  if(method==='GET'&&(pathname==='/api/admin/backup.json'||pathname==='/api/admin/backup.db')){ await requireAdmin(request,env,s);return fileResponse(enc.encode(JSON.stringify(s,null,2)),'application/json; charset=utf-8',`연차관리_자료백업_${todayIsoKst()}.json`); }
  throw new HttpError(404,'API 주소를 찾을 수 없습니다.');
}

export async function onRequest(context) {
  try { return await handle(context); }
  catch (error) { const status=error instanceof HttpError?error.status:500; if(status>=500)console.error(error); return json({error:error?.message||'서버 처리 중 오류가 발생했습니다.'},status); }
}
