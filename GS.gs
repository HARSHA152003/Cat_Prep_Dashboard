/* =====================================================================
   CAT Prep Tracker — Google Apps Script backend

   DEPLOY:
   1. Open script.google.com, create a new project, paste this file in
      as Code.gs (delete the default myFunction stub).
   2. Run `setupSheets` once from the editor (Run ▸ setupSheets) to
      create the four tabs with headers in the BOUND spreadsheet.
      → If this script isn't bound to a Sheet yet, create/open a Google
        Sheet first, then Extensions ▸ Apps Script, and paste this in
        there instead — that binds it automatically.
   3. Deploy ▸ New deployment ▸ type "Web app".
        - Execute as: Me
        - Who has access: Anyone (or "Anyone with Google account", but
          plain "Anyone" is simplest for a personal tracker)
   4. Copy the /exec URL into CONFIG.API_URL in the frontend's script.js.
   5. Every time you change this file, you must create a NEW deployment
      (or "Manage deployments ▸ Edit ▸ New version") for changes to
      take effect at the same /exec URL.

   SHEETS / TABS this expects (setupSheets creates these for you):
     - Test_And_Targets_Log
     - Concept_Study_Log
     - Reading_Log
     - Vocabulary_Bank
===================================================================== */

const SHEET_TESTS   = 'Test_And_Targets_Log';
const SHEET_STUDY   = 'Concept_Study_Log';
const SHEET_READING = 'Reading_Log';
const SHEET_VOCAB   = 'Vocabulary_Bank';

const HEADERS = {
  [SHEET_TESTS]:   ['Date','SourceType','SourceLabel','TestName','Area','Topic','Duration','TotalQuestions','Answered','Unanswered','Correct','Incorrect','MarksPerCorrect','PenaltyPerIncorrect','NetScore'],
  [SHEET_STUDY]:   ['Date','Area','Module','Hours','Notes'],
  [SHEET_READING]: ['Date','MaterialType','MaterialName','Pages','Minutes'],
  [SHEET_VOCAB]:   ['Date','Word','Meaning'],
};

/* ---------------------------------------------------------------------
   One-time setup — run manually from the Apps Script editor.
--------------------------------------------------------------------- */
function setupSheets(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(HEADERS).forEach(name=>{
    let sh = ss.getSheetByName(name);
    if(!sh){ sh = ss.insertSheet(name); }
    if(sh.getLastRow() === 0){
      sh.getRange(1,1,1,HEADERS[name].length).setValues([HEADERS[name]]);
      sh.setFrozenRows(1);
    }
  });
  // Remove the default "Sheet1" if it's still empty and unused.
  const def = ss.getSheetByName('Sheet1');
  if(def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);
}

function getSheet(name){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if(!sh){
    sh = ss.insertSheet(name);
    sh.getRange(1,1,1,HEADERS[name].length).setValues([HEADERS[name]]);
    sh.setFrozenRows(1);
  }
  return sh;
}

/* ---------------------------------------------------------------------
   Helpers
--------------------------------------------------------------------- */
function jsonOut(obj){
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function toDateStr(v){
  if(v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  if(!v) return '';
  const s = String(v);
  // Already yyyy-mm-dd (from the frontend's <input type="date">) — pass through.
  if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}
function round1(n){ return Math.round(n*10)/10; }
function numOrZero(v){ return isNaN(Number(v)) ? 0 : Number(v); }

// Reads every data row of a sheet into an array of plain objects keyed by
// the header row, plus a 1-based _row (actual sheet row number) for updates.
function readSheetAsObjects(name){
  const sh = getSheet(name);
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if(lastRow < 2) return [];
  const headers = sh.getRange(1,1,1,lastCol).getValues()[0].map(h=>String(h).trim());
  const values = sh.getRange(2,1,lastRow-1,lastCol).getValues();
  const out = [];
  values.forEach((row,i)=>{
    // Skip fully-blank rows.
    if(row.every(c=>c===''||c===null)) return;
    const obj = { _row: i+2 };
    headers.forEach((h,ci)=>{ obj[h] = row[ci]; });
    out.push(obj);
  });
  return out;
}

/* ---------------------------------------------------------------------
   GET — ?action=getAll
--------------------------------------------------------------------- */
function doGet(e){
  try{
    const action = e && e.parameter && e.parameter.action;
    if(action === 'getAll'){
      return jsonOut({ status:'ok', data: buildAllData() });
    }
    return jsonOut({ status:'error', message:'Unknown or missing action.' });
  }catch(err){
    return jsonOut({ status:'error', message: err.message });
  }
}

function buildAllData(){
  const testsRaw = readSheetAsObjects(SHEET_TESTS);
  const tests = testsRaw.map(r=>{
    const answered = numOrZero(r.Answered);
    const correct = numOrZero(r.Correct);
    return {
      _row: r._row,
      date: toDateStr(r.Date),
      sourceType: r.SourceType || '',
      sourceLabel: r.SourceLabel || '',
      testName: r.TestName || '',
      area: r.Area || '',
      topic: r.Topic || '',
      duration: numOrZero(r.Duration),
      totalQuestions: numOrZero(r.TotalQuestions),
      answered,
      unanswered: numOrZero(r.Unanswered),
      correct,
      incorrect: numOrZero(r.Incorrect),
      marksPerCorrect: numOrZero(r.MarksPerCorrect),
      penaltyPerIncorrect: numOrZero(r.PenaltyPerIncorrect),
      netScore: numOrZero(r.NetScore),
      accuracy: answered>0 ? round1((correct/answered)*100) : 0,
    };
  });

  const study = readSheetAsObjects(SHEET_STUDY).map(r=>({
    _row: r._row,
    date: toDateStr(r.Date),
    area: r.Area || '',
    module: r.Module || '',
    hours: numOrZero(r.Hours),
    notes: r.Notes || '',
  }));

  const reading = readSheetAsObjects(SHEET_READING).map(r=>({
    _row: r._row,
    date: toDateStr(r.Date),
    materialType: r.MaterialType || '',
    materialName: r.MaterialName || '',
    pages: numOrZero(r.Pages),
    minutes: numOrZero(r.Minutes),
  }));

  const vocab = readSheetAsObjects(SHEET_VOCAB).map(r=>({
    _row: r._row,
    date: toDateStr(r.Date),
    word: r.Word || '',
    meaning: r.Meaning || '',
  }));

  return { tests, study, reading, vocab, discipline: [] };
}

/* ---------------------------------------------------------------------
   POST — single-entry save (insert or update). Body is JSON, sent as
   text/plain by the frontend to avoid a CORS preflight.
--------------------------------------------------------------------- */
function doPost(e){
  const lock = LockService.getScriptLock();
  try{
    lock.waitLock(20000); // up to 20s — writes are serialized so parallel
                           // saves (e.g. multi-section Cracku) never race.
  }catch(lockErr){
    return jsonOut({ status:'error', message:'Server is busy, please retry.' });
  }
  try{
    if(!e || !e.postData || !e.postData.contents){
      return jsonOut({ status:'error', message:'No request body received.' });
    }
    const payload = JSON.parse(e.postData.contents);
    const targetSheet = payload.targetSheet;

    if(targetSheet === SHEET_TESTS){
      return jsonOut(saveTest(payload));
    }
    if(targetSheet === SHEET_STUDY){
      return jsonOut(saveStudy(payload));
    }
    if(targetSheet === 'Reading_And_Vocab'){
      // Two logical entities share one logical "sheet name" from the
      // frontend's point of view; route by shape. A vocab entry always
      // carries `word`; a reading entry never does.
      if(Object.prototype.hasOwnProperty.call(payload, 'word')){
        return jsonOut(saveVocab(payload));
      }
      return jsonOut(saveReading(payload));
    }
    return jsonOut({ status:'error', message:'Unknown targetSheet: ' + targetSheet });
  }catch(err){
    return jsonOut({ status:'error', message: err.message });
  }finally{
    lock.releaseLock();
  }
}

function writeRow(sheetName, rowValues, payload){
  const sh = getSheet(sheetName);
  if(payload.action === 'update' && payload.rowId){
    const rowId = Number(payload.rowId);
    if(rowId < 2 || rowId > sh.getLastRow()){
      return { status:'error', message:'That entry no longer exists — try refreshing and saving again.' };
    }
    sh.getRange(rowId, 1, 1, rowValues.length).setValues([rowValues]);
    return { status:'ok', action:'updated', row: rowId };
  }
  sh.appendRow(rowValues);
  return { status:'ok', action:'inserted', row: sh.getLastRow() };
}

function saveTest(p){
  if(!p.date || !p.area) return { status:'error', message:'Missing date or area.' };
  const row = [
    p.date, p.sourceType||'', p.sourceLabel||'', p.testName||'', p.area||'', p.topic||'',
    numOrZero(p.duration), numOrZero(p.totalQuestions), numOrZero(p.answered), numOrZero(p.unanswered),
    numOrZero(p.correct), numOrZero(p.incorrect), numOrZero(p.marksPerCorrect), numOrZero(p.penaltyPerIncorrect),
    numOrZero(p.netScore),
  ];
  return writeRow(SHEET_TESTS, row, p);
}
function saveStudy(p){
  if(!p.date || !p.area || !p.module) return { status:'error', message:'Missing date, area, or module.' };
  const row = [p.date, p.area||'', p.module||'', numOrZero(p.hours), p.notes||''];
  return writeRow(SHEET_STUDY, row, p);
}
function saveReading(p){
  if(!p.date || !p.materialName) return { status:'error', message:'Missing date or material name.' };
  const row = [p.date, p.materialType||'', p.materialName||'', numOrZero(p.pages), numOrZero(p.minutes)];
  return writeRow(SHEET_READING, row, p);
}
function saveVocab(p){
  if(!p.date || !p.word) return { status:'error', message:'Missing date or word.' };
  const row = [p.date, p.word||'', p.meaning||''];
  return writeRow(SHEET_VOCAB, row, p);
}
