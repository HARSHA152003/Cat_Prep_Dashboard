/* =====================================================================
   CONFIG — Supabase project URL + anon (public) key.
   Dashboard -> Project Settings -> API. Everything below reads/writes live
   against Supabase — nothing is cached to localStorage/sessionStorage.
===================================================================== */
const CONFIG = {
  SUPABASE_URL: 'https://cgnjtugdyddnqnmvxqqf.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_DaEjcPQbX-7M-Bu7vGB0zg_l5lkI43R'
};
const isConfigured = CONFIG.SUPABASE_URL.indexOf('PASTE_YOUR') === -1 && CONFIG.SUPABASE_ANON_KEY.indexOf('PASTE_YOUR') === -1;
/* =====================================================================
   MOCK RESULTS (Supabase table `mock_results`, same project as above)
   Rows come back with exactly the column names used below: mockNo,
   mockName, mockDate, overall_score, overall_accuracy, plus per-section
   fields prefixed varc_/dilr_/qa_ (varc_score, varc_correct,
   varc_incorrect, varc_skipped, ...). Used for mock-day lookups and for
   folding mock scores into section-wise performance.
===================================================================== */

function formatMockDate(dateInput){
  if(!dateInput) return '-';
  const d = new Date(dateInput);
  if(!isNaN(d.getTime())){
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}-${month}-${year}`;
  }
  const cleanStr = String(dateInput).split('T')[0];
  const parts = cleanStr.split(/[-/]/);
  if(parts.length === 3){
    const [year, month, day] = parts;
    return `${String(day).padStart(2, '0')}-${String(month).padStart(2, '0')}-${year}`;
  }
  return cleanStr;
}
// Same idea as formatMockDate but keyed as yyyy-mm-dd, to match this app's own date strings.
function mockDateToISO(dateInput){
  if(!dateInput) return null;
  if(/^\d{4}-\d{2}-\d{2}$/.test(String(dateInput))) return String(dateInput);
  const d = new Date(dateInput);
  if(!isNaN(d.getTime())) return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  return null;
}

let mockRecordsCache = null; // fetched once per page load, reused everywhere on that page
async function loadMockRecords(){
  if(mockRecordsCache) return mockRecordsCache;
  try{
    mockRecordsCache = await sbSelectAll('mock_results', 'mockNo.asc');
  }catch(err){ console.warn('Mock results load failed:', err.message); mockRecordsCache = []; }
  return mockRecordsCache;
}
function findMockForDate(dateStr){
  return (mockRecordsCache||[]).find(rec => mockDateToISO(rec.mockDate) === dateStr) || null;
}
function mockDatesSet(){
  const set = new Set();
  (mockRecordsCache||[]).forEach(rec=>{ const iso = mockDateToISO(rec.mockDate); if(iso) set.add(iso); });
  return set;
}

// Standard CAT-format max marks per section: questions × marks-per-correct
// (VARC 24×3=72, DILR 22×3=66, QA/Quant 22×3=66). Marking scheme assumed
// standard: +3 correct, -1 incorrect (MCQ), 0 for skipped/non-MCQ TITA.
// This fixed scale is what makes it safe to compare netScore across
// different sources (Cracku/2IIM daily practice AND full-length mocks,
// including a shorter/timed DILR "games" format) — as long as that format
// still scores out of the same 22×3 = 66, a raw score of, say, 30 means
// the same thing regardless of which format produced it.
const AREA_MAX_SCORE = { VARC: 72, DILR: 66, Quant: 66 };
function maxScoreForArea(area){ return AREA_MAX_SCORE[area] || null; }
// This app uses 'Quant'; the separate Mock Analytics tracker uses 'qa'.
function mockAreaPrefix(area){
  return area === 'Quant' ? 'qa' : area.toLowerCase();
}

// Adapts raw mock records (a different shape, from a different page/sheet)
// into the same {date, netScore, answered, accuracy} shape used by
// DATA.tests rows, so they can be merged into section-wise performance.
// A mock section with no correct+incorrect recorded (i.e. not attempted
// that day) is skipped, same rule as everywhere else in this app.
function mockRowsForArea(area){
  const prefix = mockAreaPrefix(area);
  return (mockRecordsCache||[]).map(rec=>{
    const correct = Number(rec[prefix+'_correct']||0);
    const incorrect = Number(rec[prefix+'_incorrect']||0);
    const answered = correct + incorrect;
    if(answered <= 0) return null;
    const netScore = Number(rec[prefix+'_score']||0);
    const accuracy = round1((correct/answered)*100);
    return { date: mockDateToISO(rec.mockDate), netScore, answered, accuracy, isMock:true };
  }).filter(Boolean);
}

/* =====================================================================
   IN-MEMORY RUNTIME STATE ONLY — cleared on every page load/reload.
   Supabase is the single source of truth; this is just the
   last server response held in memory to paint the current page.
   Each HTML page fetches this independently on load (there is no
   client-side router keeping state across page navigations).
===================================================================== */
let DATA = { tests: [], study: [], reading: [], vocab: [], discipline: [] };
let lastSynced = null;
let syncError = null;
let isSyncing = false;

function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }
function todayISO(){ return new Date().toISOString().slice(0,10); }
function fmtDate(d){ if(!d) return '—'; const dt=new Date(d+'T00:00:00'); return dt.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'2-digit'}); }
function round1(n){ return Math.round(n*10)/10; }
function round2(n){ return Math.round(n*100)/100; }
function escapeHtml(s){ return (s||'').toString().replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmtMinsHrs(mins){ return `${Math.round(mins)}m <span style="color:var(--faint);font-size:11px;">(${round1(mins/60)}h)</span>`; }

/* =====================================================================
   API LAYER — live reads/writes against Supabase (PostgREST over fetch).

   Tables:
     cracku_daily_targets, iim_sectionals, iim_advanced  -> DATA.tests
       (merged in memory; sourceLabel is set from the table, so every
        existing page that filters on sourceLabel keeps working)
     concept_study_log -> DATA.study
     reading_log       -> DATA.reading
     vocabulary_bank   -> DATA.vocab  ({word, meaning, example}, no date)

   Row ids: every DATA row carries `_row` (the table's id) so the existing
   duplicate/overwrite flow works unchanged. Save payloads keep the same
   shape as before (targetSheet, action:'update', rowId).
===================================================================== */
const TEST_TABLES = {
  'Cracku':         'cracku_daily_targets',
  '2IIM Sectional': 'iim_sectionals',
  '2IIM Advanced':  'iim_advanced',
};
const num = v => (isNaN(Number(v)) ? 0 : Number(v));

function sbHeaders(extra){
  return Object.assign({
    apikey: CONFIG.SUPABASE_ANON_KEY,
    Authorization: 'Bearer ' + CONFIG.SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
  }, extra || {});
}
function sbUrl(table){ return CONFIG.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/' + table; }

// Fetch every row of a table, paging past PostgREST's 1000-row default cap.
async function sbSelectAll(table, order = 'id.asc'){
  const PAGE = 1000;
  let out = [], offset = 0;
  for(;;){
    const res = await fetch(`${sbUrl(table)}?select=*&order=${order}&limit=${PAGE}&offset=${offset}`, { headers: sbHeaders() });
    if(!res.ok) throw new Error(`${table} fetch failed (${res.status})`);
    const rows = await res.json();
    out = out.concat(rows);
    if(rows.length < PAGE) break;
    offset += PAGE;
  }
  return out;
}

function testFromDb(r, sourceLabel){
  const answered = num(r.answered), correct = num(r.correct);
  return {
    _row: r.id,
    date: r.date || '',
    sourceType: r.source_type || '',
    sourceLabel,
    testName: r.test_name || '',
    area: r.area || '',
    topic: r.topic || '',
    duration: num(r.duration),
    totalQuestions: num(r.total_questions),
    answered,
    unanswered: num(r.unanswered),
    correct,
    incorrect: num(r.incorrect),
    marksPerCorrect: num(r.marks_per_correct),
    penaltyPerIncorrect: num(r.penalty_per_incorrect),
    netScore: num(r.net_score),
    accuracy: answered > 0 ? round1((correct / answered) * 100) : 0,
  };
}
const studyFromDb = r => ({ _row: r.id, date: r.date || '', area: r.area || '', module: r.module || '', hours: num(r.hours), notes: r.notes || '' });
const readingFromDb = r => ({ _row: r.id, date: r.date || '', materialType: r.material_type || '', materialName: r.material_name || '', pages: num(r.pages), minutes: num(r.minutes) });
const vocabFromDb = r => ({ _row: r.id, word: r.word || '', meaning: r.meaning || '', example: r.example || '' });

async function apiGetAll(){
  const labels = Object.keys(TEST_TABLES);
  const [testSets, study, reading, vocab] = await Promise.all([
    Promise.all(labels.map(l => sbSelectAll(TEST_TABLES[l]))),
    sbSelectAll('concept_study_log'),
    sbSelectAll('reading_log'),
    sbSelectAll('vocabulary_bank'),
  ]);
  const tests = [];
  testSets.forEach((rows, i) => rows.forEach(r => tests.push(testFromDb(r, labels[i]))));
  tests.sort((a,b) => (a.date||'').localeCompare(b.date||''));
  return {
    tests,
    study: study.map(studyFromDb),
    reading: reading.map(readingFromDb),
    vocab: vocab.map(vocabFromDb),
    discipline: [],
  };
}

// Translate a page's save payload into {table, row}.
function payloadToTableRow(p){
  if(p.targetSheet === 'Test_And_Targets_Log'){
    const table = TEST_TABLES[p.sourceLabel];
    if(!table) throw new Error('Unknown test source: ' + p.sourceLabel);
    if(!p.date || !p.area) throw new Error('Missing date or area.');
    return { table, row: {
      date: p.date, source_type: p.sourceType || '', test_name: p.testName || '', area: p.area, topic: p.topic || '',
      duration: num(p.duration), total_questions: num(p.totalQuestions), answered: num(p.answered), unanswered: num(p.unanswered),
      correct: num(p.correct), incorrect: num(p.incorrect), marks_per_correct: num(p.marksPerCorrect),
      penalty_per_incorrect: num(p.penaltyPerIncorrect), net_score: num(p.netScore),
    }};
  }
  if(p.targetSheet === 'Concept_Study_Log'){
    if(!p.date || !p.area || !p.module) throw new Error('Missing date, area, or module.');
    return { table:'concept_study_log', row:{ date: p.date, area: p.area, module: p.module, hours: num(p.hours), notes: p.notes || '' } };
  }
  if(p.targetSheet === 'Reading_And_Vocab'){
    if(Object.prototype.hasOwnProperty.call(p, 'word')){
      if(!p.word) throw new Error('Missing word.');
      return { table:'vocabulary_bank', row:{ word: p.word, meaning: p.meaning || '', example: p.example || '' } };
    }
    if(!p.date || !p.materialName) throw new Error('Missing date or material name.');
    return { table:'reading_log', row:{ date: p.date, material_type: p.materialType || '', material_name: p.materialName, pages: num(p.pages), minutes: num(p.minutes) } };
  }
  throw new Error('Unknown targetSheet: ' + p.targetSheet);
}

async function apiPost(payload){
  const { table, row } = payloadToTableRow(payload);
  const isUpdate = payload.action === 'update' && payload.rowId;
  const url = isUpdate ? `${sbUrl(table)}?id=eq.${encodeURIComponent(payload.rowId)}` : sbUrl(table);
  const res = await fetch(url, {
    method: isUpdate ? 'PATCH' : 'POST',
    headers: sbHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify(row),
  });
  if(!res.ok){
    let msg = 'Save failed (' + res.status + ')';
    try{ const j = await res.json(); if(j && j.message) msg += ': ' + j.message; }catch(_){}
    throw new Error(msg);
  }
  const saved = await res.json();
  if(isUpdate && (!saved || !saved.length)) throw new Error('That entry no longer exists — try refreshing and saving again.');
  return { status:'ok', action: isUpdate ? 'updated' : 'inserted', row: saved && saved[0] ? saved[0].id : null };
}

// Called on every page load, and again after every save. Re-renders whatever
// the current page has registered as window.renderPage, and the sync status
// pill in the sidebar (if that page includes one — every page does).
async function refreshAll(showToastOnSuccess){
  isSyncing = true; syncError = null; renderSyncStatus();
  try{
    const [data] = await Promise.all([apiGetAll(), loadMockRecords()]);
    DATA = data;
    lastSynced = new Date();
    if(showToastOnSuccess) toast('Synced with Supabase');
  }catch(err){
    syncError = err.message;
    toast('Sync failed: ' + err.message, true);
  }finally{
    isSyncing = false;
    renderSyncStatus();
    if(typeof window.renderPage === 'function') window.renderPage();
  }
}

async function submitAndRefresh(payload, successMsg, btn){
  if(btn){ btn.disabled = true; btn.dataset.origLabel = btn.textContent; btn.innerHTML = '<span class="spinner"></span> Saving…'; }
  try{
    await apiPost(payload);
    await refreshAll(false);
    toast(successMsg);
  }catch(err){
    toast('Could not save: ' + err.message, true);
  }finally{
    if(btn){ btn.disabled = false; btn.textContent = btn.dataset.origLabel; }
  }
}

function renderSyncStatus(){
  const el = document.getElementById('syncStatus');
  const dot = document.getElementById('liveDot');
  if(!el || !dot) return;
  if(isSyncing){ el.textContent = 'Syncing…'; dot.className = 'dot'; return; }
  if(syncError){ el.textContent = 'Sync error — see toast'; dot.className = 'dot err'; return; }
  el.textContent = lastSynced ? ('Live · synced ' + lastSynced.toLocaleTimeString()) : 'Not synced yet';
  dot.className = 'dot live';
}

/* =====================================================================
   TOAST
===================================================================== */
let toastTimer;
function toast(msg, isErr){
  const el = document.getElementById('toast');
  if(!el) return;
  document.getElementById('toastMsg').textContent = msg;
  el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>el.classList.remove('show'), 2600);
}

/* =====================================================================
   DUPLICATE-ENTRY CONFIRMATION MODAL
   Returns a Promise resolving to 'overwrite' | 'new' | 'cancel'.
===================================================================== */
function askDuplicateChoice(message){
  return new Promise(resolve=>{
    const overlay = document.createElement('div');
    overlay.className = 'modal-backdrop';
    overlay.innerHTML = `
      <div class="modal-card">
        <div class="modal-title">Possible duplicate entry</div>
        <div class="modal-msg">${escapeHtml(message)}</div>
        <div class="modal-actions">
          <button class="btn btn-ghost btn-sm" data-c="cancel">Cancel</button>
          <button class="btn btn-ghost btn-sm" data-c="new">Add as new</button>
          <button class="btn btn-gold btn-sm" data-c="overwrite">Overwrite existing</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    function cleanup(choice){ document.body.removeChild(overlay); resolve(choice); }
    overlay.querySelectorAll('[data-c]').forEach(btn=>{
      btn.addEventListener('click', ()=>cleanup(btn.dataset.c));
    });
    overlay.addEventListener('click', (e)=>{ if(e.target === overlay) cleanup('cancel'); });
  });
}

// Duplicate finders — one per log type. Each returns the matching DATA row (with its
// _row sheet-row id) or undefined. Matching rules are intentionally narrow so we only
// flag genuine repeats, not every entry that shares a date.
function findDuplicateTest(entry){
  return DATA.tests.find(t=>{
    if(t.sourceLabel !== entry.sourceLabel || t.area !== entry.area || t.date !== entry.date) return false;
    if(entry.testName) return (t.testName||'').trim().toLowerCase() === entry.testName.trim().toLowerCase();
    return (t.topic||'').trim().toLowerCase() === (entry.topic||'').trim().toLowerCase();
  });
}
function describeTest(t){
  return `${t.sourceLabel} · ${t.area} on ${fmtDate(t.date)}${t.testName ? (' — "'+t.testName+'"') : (' — '+t.topic)}`;
}
function findDuplicateStudy(entry){
  return DATA.study.find(s=> s.date===entry.date && s.area===entry.area && s.module===entry.module);
}
function describeStudy(s){ return `${s.area} / ${s.module} on ${fmtDate(s.date)}`; }
function findDuplicateReading(entry){
  return DATA.reading.find(r=> r.date===entry.date && r.materialType===entry.materialType && (r.materialName||'').trim().toLowerCase()===(entry.materialName||'').trim().toLowerCase());
}
function describeReading(r){
  const label = r.materialName ? `${r.materialType} "${r.materialName}"` : (r.materialType || 'a reading session');
  return `${label} on ${fmtDate(r.date)}`;
}
function findDuplicateVocab(entry){
  return DATA.vocab.find(v=> v.word.trim().toLowerCase() === entry.word.trim().toLowerCase());
}
function describeVocab(v){ return `the word "${v.word}"`; }

// Generic single-entry save flow: check for a duplicate, ask if found, then save.
// Returns false if the user cancelled, true otherwise (including a plain save).
async function saveWithDuplicateCheck(entry, findDupFn, describeFn, successMsg, btn){
  const dup = findDupFn(entry);
  if(dup){
    const choice = await askDuplicateChoice(`An entry already exists for ${describeFn(dup)}. Overwrite it, or add this as a separate new entry?`);
    if(choice === 'cancel') return false;
    if(choice === 'overwrite'){ entry.action = 'update'; entry.rowId = dup._row; }
  }
  await submitAndRefresh(entry, successMsg, btn);
  return true;
}

/* =====================================================================
   SHARED NAV
===================================================================== */
const NAV_LINKS = [
  {href:'index.html', label:'Dashboard', sub:'MISSION CONTROL', icon:'grid'},
  {href:'test-log.html', label:'Test & Target Tracker', sub:'CORE DATA ENTRY ENGINE', icon:'target'},
  {href:'concept-log.html', label:'Concept Study Log', sub:'DEEP-WORK HOURS', icon:'clock'},
  {href:'reading-log.html', label:'Reading Log', sub:'STAMINA', icon:'book'},
  {href:'vocab-reading.html', label:'Vocabulary & Reading', sub:'WORD BANK · LATEST SESSIONS', icon:'bookmark'},
  {href:'calendar.html', label:'Daily Discipline', sub:'HABIT CALENDAR', icon:'check'},
  {href:'analytics.html', label:'Analytics & Deep-Dive', sub:'PROGRESS TRAJECTORIES', icon:'chart'},
];
const ICONS = {
  grid:'<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="7" height="7" rx="1.2"/><rect x="14" y="3" width="7" height="7" rx="1.2"/><rect x="3" y="14" width="7" height="7" rx="1.2"/><rect x="14" y="14" width="7" height="7" rx="1.2"/></svg>',
  target:'<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="0.6" fill="currentColor"/></svg>',
  clock:'<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  book:'<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 5.5C4 4.7 4.7 4 5.5 4H12v16H5.5A1.5 1.5 0 014 18.5v-13z"/><path d="M20 5.5c0-.8-.7-1.5-1.5-1.5H12v16h6.5a1.5 1.5 0 001.5-1.5v-13z"/></svg>',
  bookmark:'<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 4h12v16l-6-4-6 4V4z"/></svg>',
  check:'<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>',
  chart:'<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 20V10M12 20V4M20 20v-7"/></svg>',
};
function currentPageFile(){
  const p = location.pathname.split('/').pop();
  return p === '' ? 'index.html' : p;
}
function initNav(){
  const nav = document.getElementById('navlist');
  if(!nav) return;
  const current = currentPageFile();
  nav.innerHTML = NAV_LINKS.map((t,i)=>`
    <a class="navitem ${current===t.href?'active':''}" href="${t.href}">
      <span class="idx">0${i+1}</span>${ICONS[t.icon]}<span>${t.label}</span>
    </a>`).join('');
  const activeLink = NAV_LINKS.find(t=>t.href===current) || NAV_LINKS[0];
  const titleEl = document.getElementById('pageTitle');
  const subEl = document.getElementById('pageSub');
  if(titleEl) titleEl.textContent = activeLink.label;
  if(subEl) subEl.textContent = activeLink.sub;
}
function closeSidebarMobile(){
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('backdrop')?.classList.remove('show');
}
function wireChrome(){
  document.getElementById('menuBtn')?.addEventListener('click',()=>{
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('backdrop').classList.toggle('show');
  });
  document.getElementById('backdrop')?.addEventListener('click', closeSidebarMobile);
  document.getElementById('refreshBtn')?.addEventListener('click',()=>refreshAll(true));
  nav_closeOnLinkClick();
}
function nav_closeOnLinkClick(){
  document.getElementById('navlist')?.addEventListener('click', (e)=>{
    if(e.target.closest('.navitem')) closeSidebarMobile();
  });
}

/* =====================================================================
   SECTION AREA HELPERS (VARC/DILR/Quant weighting) — used on Dashboard
   and Analytics.

   IMPORTANT: these now fold in full-length mock scores from the SEPARATE
   Mock Analytics page/sheet (the `mock_results` table, see above), on top of this
   app's own Cracku/2IIM entries in DATA.tests. Mock rows are adapted via
   mockRowsForArea() into the same {date, netScore, answered, accuracy}
   shape before being merged in — the two datasets are pulled from two
   entirely different Apps Script deployments and only combined here, in
   memory, at calculation time.
===================================================================== */
function weightedAvgForArea(area){
  const testRows = DATA.tests
    .filter(t=> t.area===area && t.answered>0)
    .map(t=>({ date: t.date, netScore: Number(t.netScore||0), answered: Number(t.answered||0), accuracy: Number(t.accuracy||0) }));
  const mockRows = mockRowsForArea(area); // from the separate Mock Analytics sheet
  const allRows = [...testRows, ...mockRows];
  if(!allRows.length) return null;

  // avgNetPct — netScore expressed as % of the fixed max for this area (see
  // AREA_MAX_SCORE above): (marks scored / max possible for the section) × 100.
  // Because this is normalized to a common 0–100 scale, it's safe to merge
  // Cracku/2IIM AND mocks here, including a shorter/timed DILR games mock, AS
  // LONG AS that format is still marked out of the same 22×3=66 total.
  // Unweighted average across sessions — every session counts equally.
  const maxScore = maxScoreForArea(area);
  const netPctRows = maxScore ? allRows.map(r=> round1((r.netScore/maxScore)*100)) : [];
  const avgNetPct = netPctRows.length ? round1(netPctRows.reduce((s,v)=>s+v,0)/netPctRows.length) : null;

  // avgAccuracy (answered-weighted correct%) — scale-independent regardless of
  // question count, so mocks are included here too.
  const totalAns = allRows.reduce((s,t)=>s+t.answered,0);
  const weightedAcc = allRows.reduce((s,t)=>s + (t.accuracy * t.answered), 0);

  return {
    avgNetPct,
    avgAccuracy: totalAns>0 ? round1(weightedAcc/totalAns) : 0,
    count: allRows.length,
    testCount: testRows.length,   // from this app's own Test & Target Tracker
    mockCount: mockRows.length,   // from the separate Mock Analytics page
  };
}
function trendForArea(area, n=5){
  const testRows = DATA.tests
    .filter(t=>t.area===area)
    .map(t=>({ date: t.date, accuracy: Number(t.accuracy||0) }));
  const mockRows = mockRowsForArea(area).map(r=>({ date: r.date, accuracy: r.accuracy })); // separate Mock Analytics sheet
  const rows = [...testRows, ...mockRows]
    .filter(r=>r.date)
    .sort((a,b)=> a.date.localeCompare(b.date));
  if(rows.length<2) return {delta:0, dir:'flat'};
  const last = n===Infinity ? rows : rows.slice(-n);
  if(last.length<2) return {delta:0, dir:'flat'};
  const mid = Math.ceil(last.length/2);
  const avg = arr => arr.reduce((s,t)=>s+Number(t.accuracy||0),0)/arr.length;
  const delta = round1(avg(last.slice(mid)) - avg(last.slice(0,mid)));
  return {delta, dir: delta>0.3?'up':(delta<-0.3?'down':'flat')};
}
function crackuTimeByArea(){
  const byArea = { VARC:0, DILR:0, Quant:0 };
  DATA.tests.filter(t=>t.sourceLabel==='Cracku').forEach(t=>{ if(byArea[t.area]!=null) byArea[t.area] += Number(t.duration||0); });
  return byArea;
}
function iimTimeByArea(){
  const byArea = { VARC:0, DILR:0, Quant:0 };
  DATA.tests.filter(t=>t.sourceLabel==='2IIM Sectional' || t.sourceLabel==='2IIM Advanced').forEach(t=>{ if(byArea[t.area]!=null) byArea[t.area] += Number(t.duration||0); });
  return byArea;
}
function studyHoursByArea(){
  const byArea = { VARC:0, DILR:0, Quant:0 };
  DATA.study.forEach(s=>{ if(byArea[s.area]!=null) byArea[s.area] += Number(s.hours||0); });
  return byArea;
}
function tickRow(value,max){
  const on = Math.min(10, Math.round((value/max)*10));
  let out=''; for(let i=0;i<10;i++) out += `<span class="tick ${i<on?'on':''}"></span>`;
  return out;
}

/* =====================================================================
   PAGE BOOT — every page calls this once on DOMContentLoaded.
   It wires the shared chrome (nav/sidebar/refresh), then does the first
   sync. window.renderPage (set by the page BEFORE calling bootPage) is
   invoked automatically at the end of refreshAll — including after every
   future save/refresh on that page.
===================================================================== */
async function bootPage(){
  const gate = document.getElementById('gate');
  const shell = document.getElementById('appShell');
  if(!isConfigured){
    if(gate) gate.style.display = 'flex';
    if(shell) shell.style.display = 'none';
    return false;
  }
  if(gate) gate.style.display = 'none';
  if(shell) shell.style.display = 'flex';
  wireChrome();
  initNav();
  await refreshAll(false);
  return true;
}