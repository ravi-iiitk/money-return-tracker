/* ============================================================================
   Screenshot Money Tracker – FULL app.js (with image upload)
   - Workspace-based Firestore persistence (workspaces/{code})
   - OCR ingestion + manual edit
   - CSV import/export (employees, outgoing, incoming)
   - Statement matcher (CSV/XLSX/PDF/TXT) for Incoming (returns)
   - Mobile-safe behaviors
============================================================================ */

/* --------------------------- Firebase bootstrap --------------------------- */
/* Put your real config here (same as you already have in your working app) */
const firebaseConfig = {
  apiKey: "AIzaSyDuMw1wk70w38NQf_1pQZbN-Y1z7x4qTaM",
  authDomain: "money-tracker-41c53.firebaseapp.com",
  projectId: "money-tracker-41c53",
  storageBucket: "money-tracker-41c53.firebasestorage.app",
  messagingSenderId: "974884316198",
  appId: "1:974884316198:web:af8107569eea553679f2e7",
  measurementId: "G-6REWB0V3LC"
};
firebase.initializeApp(firebaseConfig);
const db   = firebase.firestore();
const auth = firebase.auth();
const supabaseUrl = "https://shopetkuocppkrkgoqxd.supabase.co";   // from dashboard
const supabaseKey ="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNob3BldGt1b2NwcGtya2dvcXhkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTgzNTI4MzMsImV4cCI6MjA3MzkyODgzM30.hTGOBPmAk1MjkKR5nVJ264MhCtmMukUop_zfylvHnUE";                      // from dashboard
const supabase = window.supabase.createClient(supabaseUrl, supabaseKey);

/* ------------------------------- App state -------------------------------- */
let state = { employees: [], transactions: [] };
let workspaceId = null;
let wsLoadToken = 0;
let readyPromise = Promise.resolve();
let controlsDisabled = true;

const WS_KEY = "moneytracker_workspace";

/* ----------------------------- Small helpers ------------------------------ */
function showWarn(msg){
  console.warn(msg);
  // Soft ephemeral toast
  if (!document.getElementById("__app_warn")) {
    const d = document.createElement("div");
    d.id="__app_warn";
    d.style.cssText="position:fixed;left:8px;bottom:8px;right:8px;z-index:9999;padding:8px 12px;border-radius:10px;background:#fff7ed;border:1px solid #fed7aa;color:#7c2d12;font-size:12px;display:none";
    document.body.appendChild(d);
  }
  const el = document.getElementById("__app_warn");
  el.textContent = msg;
  el.style.display = "block";
  setTimeout(()=>{ el.style.display="none"; }, 5000);
}

function uid(){ return Math.random().toString(36).slice(2); }
function el(tag, cls="", html=""){ const e=document.createElement(tag); if(cls) e.className=cls; if(html) e.innerHTML=html; return e; }
function fmtMoney(n){ if(n==null || isNaN(n)) return "₹ 0"; return "₹ " + Number(n).toLocaleString(undefined,{maximumFractionDigits:2}); }
function parseNumber(s){ if(!s) return NaN; return parseFloat(String(s).replace(/[^\d.]/g,"")); }

// Upload the transaction image to Firebase Storage and return a download URL
async function uploadTxnImage(file, txnId){
  const ws = workspaceId || "default";
  const ext = (file.name?.split('.').pop() || "jpg").toLowerCase();
  const path = `${ws}/${txnId}.${ext}`;

  // Upload
  const { error } = await supabase
    .storage
    .from("screens")
    .upload(path, file, { contentType: file.type || "image/jpeg", upsert: false });

  if (error) throw error;

  // Get public URL
  const { data } = supabase.storage.from("screens").getPublicUrl(path);
  return data.publicUrl;
}


/* -------------------------- Firestore workspace --------------------------- */
function workspaceDoc(){
  // DO NOT CHANGE: we persist under "workspaces/{workspaceId}" per your setup
  if(!db || !workspaceId) throw new Error("Firestore not ready or workspace missing");
  return db.collection("workspaces").doc(workspaceId);
}

function setControlsEnabled(enabled){
  controlsDisabled = !enabled;
  const ids = [
    "addEmployeeBtn","importEmpBtn","importOutBtn","importRetBtn",
    "importJsonBtn","exportJsonBtn","exportEmpBtn","exportOutBtn","exportRetBtn",
    "clearOutgoingBtn","clearIncomingBtn","clearAllBtn",
    "processBtn","dropZone","fileInput","importStmtBtn"
  ];
  ids.forEach(id=>{
    const el = document.getElementById(id);
    if(!el) return;
    if(el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "BUTTON") {
      el.disabled = !enabled;
      if(!enabled) el.classList.add("opacity-50","pointer-events-none");
      else el.classList.remove("opacity-50","pointer-events-none");
    } else {
      if(!enabled) el.classList.add("opacity-50","pointer-events-none");
      else el.classList.remove("opacity-50","pointer-events-none");
    }
  });
  const badge = document.getElementById("wsBadge");
  if (badge) {
    badge.classList.remove("hidden");
    badge.textContent = workspaceId ? `workspace: ${workspaceId}` : `workspace: (not set)`;
  }
}

async function save(){
  if(!workspaceId){
    showWarn("Pick a workspace (top right → Change Workspace).");
    renderAll();
    return;
  }
  try{
    await workspaceDoc().set(state, { merge: true });
    renderAll();
  }catch(err){
    showWarn("Save failed (kept in memory). Check network/Firestore rules.");
    console.error(err);
    renderAll();
  }
}

async function load(currentToken){
  if(!workspaceId) return;
  try{
    const snap = await workspaceDoc().get();
    if(currentToken !== wsLoadToken) return; // drop stale load
    if(snap.exists){
      const data = snap.data() || {};
      state = {
        employees: Array.isArray(data.employees) ? data.employees : [],
        transactions: Array.isArray(data.transactions) ? data.transactions : []
      };
    }else{
      await workspaceDoc().set(state);
    }
  }catch(err){
    showWarn("Load failed. Using local in-memory state.");
    console.error(err);
  }
}

async function initAuth(){
  try { await auth.signInAnonymously(); }
  catch (err) { showWarn("Anonymous auth failed. Add your host to Firebase → Auth → Authorized domains."); console.error(err); }
}

/* --------------------------- Workspace selection -------------------------- */
function randomCode(){
  const words = ["mint","opal","nova","resy","tiger","lotus","pearl","alpha","delta","echo","zen","omega"];
  const w = words[Math.floor(Math.random()*words.length)];
  return `${w}-${Math.random().toString(36).slice(2,6)}`;
}
function openWorkspaceModal(){
  const modal = document.getElementById("wsModal");
  const inp   = document.getElementById("wsInput");
  const errEl = document.getElementById("wsError");
  if(!modal) return;
  inp.value = workspaceId || "";
  errEl.classList.add("hidden");
  modal.classList.remove("hidden");
  modal.classList.add("flex");
}
function closeWorkspaceModal(){
  const modal = document.getElementById("wsModal");
  if(!modal) return;
  modal.classList.add("hidden");
  modal.classList.remove("flex");
}
function getWorkspaceFromHash(){
  const m = location.hash.match(/ws=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
function setWorkspaceHash(code){
  const params = new URLSearchParams(location.hash.slice(1));
  params.set("ws", code);
  location.hash = params.toString();
}

async function setWorkspace(id){
  const code = (id||"").trim();
  if(!code){ showWarn("Workspace code is required."); return; }

  try{ localStorage.setItem(WS_KEY, code); }catch(_){}
  setWorkspaceHash(code);

  workspaceId = code;
  setControlsEnabled(false); // disable during load

  const myToken = ++wsLoadToken;
  readyPromise = (async ()=>{
    await load(myToken);
    if(myToken === wsLoadToken) setControlsEnabled(true);
    renderAll();
  })();
  await readyPromise;
}

/* ---------------------------- CSV / JSON helpers -------------------------- */
const CSV_SEP = ",";
function stripBOM(t){ return t && t.charCodeAt(0)===0xFEFF ? t.slice(1) : t; }
function parseCsv(text){
  text = stripBOM(String(text||"")).replace(/\r\n/g,"\n").replace(/\r/g,"\n");
  if(!text.trim()) return [];
  const rows = [];
  let i=0, cur="", q=false; const push=()=>{ row.push(cur); cur=""; };
  let row=[];
  while(i<text.length){
    const c=text[i];
    if(c==='\"'){ if(q && text[i+1]==='\"'){ cur+='\"'; i++; } else q=!q; }
    else if(c===',' && !q){ push(); }
    else if(c==='\n' && !q){ push(); rows.push(row); row=[]; }
    else { cur+=c; }
    i++;
  }
  if(cur.length || row.length){ push(); rows.push(row); }
  while(rows.length && rows[rows.length-1].every(cell=>!String(cell||"").trim())) rows.pop();
  const header = rows[0].map(h=>String(h||"").trim().toLowerCase());
  return rows.slice(1).filter(r=>r.some(x=>String(x||"").trim().length)).map(r=>{
    const obj={}; for(let k=0;k<header.length;k++){ obj[header[k]] = String(r[k]??"").trim(); } return obj;
  });
}
function toCsv(rows){
  if(!rows.length) return "";
  const esc = s => `"${String(s??"").replace(/"/g,'""')}"`;
  const header = Object.keys(rows[0]).map(esc).join(CSV_SEP);
  const body = rows.map(r => Object.values(r).map(esc).join(CSV_SEP)).join("\n");
  return header + "\n" + body;
}
function downloadCsv(content, name){
  const blob=new Blob([content],{type:"text/csv;charset=utf-8;"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a"); a.href=url; a.download=name; a.click(); URL.revokeObjectURL(url);
}
function exportJSON(){
  if(controlsDisabled) return showWarn("Pick a workspace first.");
  const a=document.createElement("a");
  a.href="data:application/json;charset=utf-8,"+encodeURIComponent(JSON.stringify(state,null,2));
  a.download=`${workspaceId||"workspace"}.json`; a.click();
}
function importJSONFile(file, inputEl){
  if(controlsDisabled) return showWarn("Pick a workspace first.");
  const reader = new FileReader();
  reader.onload = async (e)=>{
    try{
      const obj = JSON.parse(e.target.result);
      if(obj && obj.employees && obj.transactions){ 
        await readyPromise; 
        state=obj; 
        await save(); 
      } else alert("Invalid JSON structure.");
    }catch(err){ alert("Failed to parse JSON."); }
    if(inputEl) try{ inputEl.value=""; }catch(_){}
  };
  reader.readAsText(file);
}

/* ------------------------------- OCR helpers ------------------------------ */
function detectDirection(text){
  const t = text.toLowerCase();
  const isReturn   = /(credited|received|payment received|incoming)/i.test(t);
  const isOutgoing = /(debited|paid to|payment to|sent to|transfer to|outgoing)/i.test(t);
  if(isReturn && !isOutgoing) return "return";
  if(isOutgoing && !isReturn) return "outgoing";
  return "unknown";
}
function wordsToNumber(raw){
  if(!raw) return null;
  const text = raw.toLowerCase().replace(/[^a-z\s\-]/g,' ').replace(/\s+/g,' ').trim();
  const units = {zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16, seventeen:17, eighteen:18, nineteen:19};
  const tens  = {twenty:20, thirty:30, forty:40, fifty:50, sixty:60, seventy:70, eighty:80, ninety:90};
  const scales = {hundred:100, thousand:1000, lakh:100000, lacs:100000, lakhs:100000, crore:10000000, crores:10000000};
  const ignore = new Set(["and","rupees","rs","only"]);
  let total=0, current=0, seen=false;
  for(const token of text.split(' ')){
    if(ignore.has(token)) continue;
    if(token in units){ current+=units[token]; seen=true; continue; }
    if(token in tens){ current+=tens[token]; seen=true; continue; }
    if(token in scales){
      if(current===0) current=1; current*=scales[token]; total+=current; current=0; seen=true;
    }
  }
  total+=current; return seen ? (total||null) : null;
}
function lineLooksLikeTime(line){ return /\d{1,2}:\d{2}/.test(line) && /(am|pm)\b/i.test(line); }
function cleanNumericToken(s){ return s.replace(/[Oo]/g,"0").replace(/[Il]/g,"1").replace(/[,\s]/g,""); }
function extractAmount(text){
  const add = (val, weight) => { if (val == null || isNaN(val)) return; cands.push({ val: Number(val), weight }); };
  const lines = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const cands = [];
  for (const line of lines) {
    if (/(₹|rs\.?|inr)/i.test(line)) {
      const m = line.match(/(?:₹|rs\.?|inr)\s*([0-9][0-9\s,]*(?:\.\d{1,2})?)/i);
      if (m) add(parseFloat(cleanNumericToken(m[1])), 5);
    }
  }
  for (const line of lines) {
    if (/(total amount|amount|debited|credited|paid|transfer)/i.test(line)) {
      const m = line.match(/([0-9][0-9\s,]*(?:\.\d{1,2})?)/);
      if (m) add(parseFloat(cleanNumericToken(m[1])), 4);
    }
  }
  const wm = text.match(/([A-Za-z\s\-]+)\s+(?:rupees|rs\.?|only)\b/i);
  if (wm) { const w = wordsToNumber(wm[1]); if (w != null) add(w, 3); }
  for (const line of lines) {
    if (lineLooksLikeTime(line)) continue;
    const ms = Array.from(line.matchAll(/([0-9][0-9\s,]*(?:\.\d{1,2})?)/g));
    for (const mm of ms) {
      const raw = mm[1];
      const n = parseFloat(cleanNumericToken(raw));
      if (n < 50) continue;
      const digitsOnly = raw.replace(/[^\d]/g, "");
      if (!/[,\s]/.test(raw) && digitsOnly.length >= 9) continue;
      add(n, /[,\s]/.test(raw) ? 2 : 1.2);
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.weight - a.weight || b.val - a.val);
  return cands[0].val;
}
function extractDateTime(text){
  const datePatterns=[/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/g,/(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4})/g];
  const timePattern=/(\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM|am|pm)?)/;
  let date=null,time=null; for(const p of datePatterns){ const m=p.exec(text); if(m){date=m[1];break;} }
  const tm=timePattern.exec(text); if(tm) time=tm[1]; return {date,time};
}
function extractRef(text){
  const ref=text.match(/(?:UTR|UPI Ref(?:erence)?|Ref(?:erence)? No\.?|Txn(?:\.|) ?ID|Transaction ID|Transaction\s*ID)\s*[:\-]?\s*([A-Z0-9\-]+)/i);
  return ref?ref[1]:null;
}
function extractMode(text){
  const t=text.toLowerCase();
  if(t.includes("upi")) return "UPI";
  if(t.includes("imps")) return "IMPS";
  if(t.includes("neft")) return "NEFT";
  if(t.includes("rtgs")) return "RTGS";
  if(t.includes("gpay")||t.includes("google pay")) return "GPay";
  if(t.includes("phonepe")) return "PhonePe";
  if(t.includes("paytm")) return "Paytm";
  return null;
}
function extractCounterparty(text){
  const lines=text.split(/\n+/).map(s=>s.trim()).filter(Boolean);
  for(const line of lines){
    let m=line.match(/paid to\s*[:\-]?\s*(.+)/i); if(m) return m[1].trim();
    m=line.match(/payment to\s*[:\-]?\s*(.+)/i); if(m) return m[1].trim();
    m=line.match(/payee name\s*[:\-]?\s*(.+)/i); if(m) return m[1].trim();
    m=line.match(/beneficiary(?: name)?\s*[:\-]?\s*(.+)/i); if(m) return m[1].trim();
    m=line.match(/^to\s+(.+)/i); if(m) return m[1].trim();
    m=line.match(/^from\s+(.+)/i); if(m) return m[1].trim();
    m=line.match(/received from\s+(.+)/i); if(m) return m[1].trim();
  } return null;
}
function mapToEmployeeId(counterparty){
  if(!counterparty) return "";
  const l=counterparty.toLowerCase();
  const found=state.employees.find(e=> l.includes(e.name.toLowerCase()));
  return found?found.id:"";
}
function parseTransactionText(text){
  const amount=extractAmount(text);
  const {date,time}=extractDateTime(text);
  const ref=extractRef(text);
  const mode=extractMode(text);
  const counterparty=extractCounterparty(text);
  const direction=detectDirection(text);
  const employeeId=mapToEmployeeId(counterparty);
  return {amount,date,time,ref,mode,counterparty,direction,employeeId};
}

/* -------------------------- Summary & rendering --------------------------- */
function computeSummary(){
  const per = {};
  state.employees.forEach(e => per[e.id] = {
    name:e.name, cutType:e.cutType, cutValue:e.cutValue,
    outgoings:[], totalSent:0, totalCut:0, totalExpected:0
  });
  state.transactions.filter(t=>t.type==="outgoing").forEach(t=>{
    const e=per[t.employeeId]; if(!e) return;
    const cut = (t.cutOverride!=null) ? t.cutOverride :
      (e.cutType==="percent" ? (t.amount*(e.cutValue/100)) : e.cutValue);
    const expected = Math.max(0, t.amount - cut);
    e.outgoings.push({...t, computedCut:cut, expectedReturn:expected});
    e.totalSent += t.amount; e.totalCut += cut; e.totalExpected += expected;
  });
  return per;
}
function computeOverallTotals(){
  const per = computeSummary();
  const totalSent = Object.values(per).reduce((s,e)=> s+e.totalSent, 0);
  const totalExpected = Object.values(per).reduce((s,e)=> s+e.totalExpected, 0);
  const totalReturned = state.transactions.filter(t=>t.type==="return").reduce((s,t)=> s+(t.amount||0), 0);
  const overallBalance = totalExpected - totalReturned;
  return { totalSent, totalExpected, totalReturned, overallBalance };
}

function renderEmployees(){
  const tbody = document.getElementById("employeeTbody");
  if(!tbody) return;
  tbody.innerHTML = "";
  state.employees.forEach(emp=>{
    const tr = el("tr");
    tr.innerHTML = `
      <td class="p-2 min-w-[160px]"><input class="w-full border rounded px-2 py-1" value="${emp.name}" data-id="${emp.id}" data-f="name" ${controlsDisabled?'disabled':''}></td>
      <td class="p-2 min-w-[120px]">
        <select class="border rounded px-2 py-1" data-id="${emp.id}" data-f="cutType" ${controlsDisabled?'disabled':''}>
          <option value="percent" ${emp.cutType==='percent'?'selected':''}>Percent (%)</option>
          <option value="flat" ${emp.cutType==='flat'?'selected':''}>Flat (₹)</option>
        </select>
      </td>
      <td class="p-2 min-w-[120px]"><input type="number" step="0.01" class="w-32 border rounded px-2 py-1" value="${emp.cutValue}" data-id="${emp.id}" data-f="cutValue" ${controlsDisabled?'disabled':''}></td>
      <td class="p-2 min-w-[100px]">
        <button class="px-2 py-1 rounded bg-red-50 text-red-700 border border-red-200 hover:bg-red-100" data-id="${emp.id}" data-action="del" ${controlsDisabled?'disabled':''}>Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll("input,select,button").forEach(ctrl=>{
    ctrl.addEventListener("change", async e=>{
      if(controlsDisabled) return showWarn("Pick a workspace first.");
      const id = e.target.dataset.id;
      const f  = e.target.dataset.f;
      const i  = state.employees.findIndex(x=>x.id===id);
      if(i>=0){
        if(f==="name") state.employees[i].name = e.target.value.trim();
        if(f==="cutType") state.employees[i].cutType = e.target.value;
        if(f==="cutValue") state.employees[i].cutValue = parseFloat(e.target.value || 0);
        await readyPromise; await save();
      }
    });
    ctrl.addEventListener("click", async e=>{
      if(controlsDisabled) return;
      if(e.target.dataset.action==="del"){
        const id = e.target.dataset.id;
        state.employees = state.employees.filter(x=>x.id!==id);
        await readyPromise; await save();
      }
    });
  });

  const sel = document.getElementById("employeeSelect");
  if (sel){
    sel.innerHTML = `<option value="">(Auto / Choose)</option>` + state.employees.map(e=> `<option value="${e.id}">${e.name}</option>`).join("");
  }
}

function renderSummary(){
  const overall = document.getElementById("overallTotals");
  if(!overall) return;
  const ot = computeOverallTotals();
  overall.innerHTML = `
    <div class="border rounded-lg p-3 bg-white"><div class="text-xs text-gray-500">Total Sent</div><div class="font-medium">${fmtMoney(ot.totalSent)}</div></div>
    <div class="border rounded-lg p-3 bg-white"><div class="text-xs text-gray-500">Expected Back</div><div class="font-medium">${fmtMoney(ot.totalExpected)}</div></div>
    <div class="border rounded-lg p-3 bg-white"><div class="text-xs text-gray-500">Returned (CA)</div><div class="font-medium">${fmtMoney(ot.totalReturned)}</div></div>
    <div class="border rounded-lg p-3 ${ot.overallBalance>0?'bg-amber-50':'bg-emerald-50'}"><div class="text-xs text-gray-500">Overall Balance</div><div class="font-medium">${fmtMoney(ot.overallBalance)}</div></div>
  `;

  const per = computeSummary();
  const wrap = document.getElementById("summaryCards"); if(!wrap) return; wrap.innerHTML = "";
  Object.values(per).forEach(e=>{
    const card = el("div","rounded-xl border p-4 bg-white shadow-sm");
    card.innerHTML = `
      <div class="flex items-center justify-between">
        <div class="font-semibold">${e.name}</div>
        <div class="text-xs text-gray-500">Cut: ${e.cutType==="percent"? e.cutValue+"%":"₹ "+e.cutValue}</div>
      </div>
      <div class="grid grid-cols-3 gap-2 mt-3 text-sm">
        <div class="border rounded-lg p-2"><div class="text-xs text-gray-500">Sent</div><div class="font-medium">${fmtMoney(e.totalSent)}</div></div>
        <div class="border rounded-lg p-2"><div class="text-xs text-gray-500">Expected</div><div class="font-medium">${fmtMoney(e.totalExpected)}</div></div>
        <div class="border rounded-lg p-2"><div class="text-xs text-gray-500">Cut</div><div class="font-medium">${fmtMoney(e.totalCut)}</div></div>
      </div>
    `;
    wrap.appendChild(card);
  });
}

function renderTransactions(){
  const outT = document.getElementById("outgoingTbody");
  const retT = document.getElementById("returnTbody");
  if(!outT || !retT) return;
  outT.innerHTML=""; retT.innerHTML="";

  const per = computeSummary();

  state.transactions.slice().sort((a,b)=>(a.createdAt||0)-(b.createdAt||0)).forEach(t=>{
    if(t.type==="outgoing"){
      const emp = state.employees.find(e=>e.id===t.employeeId);
      const e = per[t.employeeId];
      const o = e?.outgoings.find(x=>x.id===t.id);
      const tr = el("tr");
      tr.innerHTML = `
        <td class="p-2">${t.date || "-"}</td>
        <td class="p-2">${emp?.name || "-"}</td>
        <td class="p-2">${fmtMoney(t.amount)}</td>
        <td class="p-2">${fmtMoney(o?.computedCut || 0)}</td>
        <td class="p-2">${fmtMoney(o?.expectedReturn || 0)}</td>
        <td class="p-2">${t.mode || "-"}</td>
        <td class="p-2">${t.ref || "-"}</td>
        <td class="p-2">${t.note || ""}</td>
        <!-- NEW Image cell -->
        <td class="p-2">
          ${
            t.imageUrl
            ? `<a href="${t.imageUrl}" target="_blank" class="inline-flex items-center gap-2">
                 <img src="${t.imageUrl}" class="w-10 h-10 object-cover rounded border" alt="txn"/>
                 <span class="text-xs underline">View</span>
               </a>`
            : `<span class="text-xs text-gray-400">—</span>`
          }
        </td>
        <td class="p-2">
          <button class="px-2 py-1 rounded border hover:bg-gray-100" data-id="${t.id}" data-act="edit" ${controlsDisabled?'disabled':''}>Edit</button>
          <button class="px-2 py-1 rounded border text-red-700 hover:bg-red-50" data-id="${t.id}" data-act="del" ${controlsDisabled?'disabled':''}>Delete</button>
        </td>
      `;
      outT.appendChild(tr);
    }else{
      const tr = el("tr");
      tr.innerHTML = `
        <td class="p-2">${t.date || "-"}</td>
        <td class="p-2">${fmtMoney(t.amount)}</td>
        <td class="p-2">${t.mode || "-"}</td>
        <td class="p-2">${t.ref || "-"}</td>
        <td class="p-2">${t.source || ""}</td>
        <td class="p-2">${t.note || ""}</td>
        <!-- NEW Image cell -->
        <td class="p-2">
          ${
            t.imageUrl
            ? `<a href="${t.imageUrl}" target="_blank" class="inline-flex items-center gap-2">
                 <img src="${t.imageUrl}" class="w-10 h-10 object-cover rounded border" alt="txn"/>
                 <span class="text-xs underline">View</span>
               </a>`
            : `<span class="text-xs text-gray-400">—</span>`
          }
        </td>
        <td class="p-2">
          <button class="px-2 py-1 rounded border hover:bg-gray-100" data-id="${t.id}" data-act="edit" ${controlsDisabled?'disabled':''}>Edit</button>
          <button class="px-2 py-1 rounded border text-red-700 hover:bg-red-50" data-id="${t.id}" data-act="del" ${controlsDisabled?'disabled':''}>Delete</button>
        </td>
      `;
      retT.appendChild(tr);
    }
  });

  [outT,retT].forEach(tb=> tb.querySelectorAll("button").forEach(btn=>{
    btn.addEventListener("click", async e=>{
      if(controlsDisabled) return showWarn("Pick a workspace first.");
      const id = e.target.dataset.id, act = e.target.dataset.act;
      if(act==="del"){
        state.transactions = state.transactions.filter(t=>t.id!==id);
        await readyPromise; await save();
      }else if(act==="edit"){
        const t = state.transactions.find(x=>x.id===id);
        openEditDialog(t);
      }
    });
  }));
}

function renderAll(){
  renderEmployees();
  renderSummary();
  renderTransactions();
}

/* ----------------------------- Edit dialog ------------------------------- */
function openEditDialog(t){
  const overlay = el("div","fixed inset-0 bg-black/30 grid place-items-center p-4");
  const card = el("div","bg-white rounded-2xl p-5 max-w-lg w-full space-y-3");
  card.innerHTML = `
    <h3 class="font-semibold text-lg">Edit Transaction</h3>
    <div class="grid grid-cols-2 gap-2">
      <label class="text-sm">Type
        <select id="edType" class="w-full border rounded px-2 py-1">
          <option value="outgoing" ${t.type==='outgoing'?'selected':''}>Outgoing</option>
          <option value="return"   ${t.type==='return'  ?'selected':''}>Return</option>
        </select>
      </label>
      <label class="text-sm">Employee
        <select id="edEmp" class="w-full border rounded px-2 py-1">
          ${state.employees.map(e=> `<option value="${e.id}" ${e.id===t.employeeId?'selected':''}>${e.name}</option>`).join("")}
          <option value="" ${t.employeeId? "": "selected"}>(None)</option>
        </select>
      </label>
      <label class="text-sm">Amount
        <input id="edAmt" type="number" step="0.01" class="w-full border rounded px-2 py-1" value="${t.amount}">
      </label>
      <label class="text-sm">Cut Override (optional)
        <input id="edCut" type="number" step="0.01" class="w-full border rounded px-2 py-1" value="${t.cutOverride ?? ''}" placeholder="Leave blank for rule">
      </label>
      <label class="text-sm col-span-2">Date
        <input id="edDate" class="w-full border rounded px-2 py-1" value="${t.date || ''}">
      </label>
      <label class="text-sm">Time
        <input id="edTime" class="w-full border rounded px-2 py-1" value="${t.time || ''}">
      </label>
      <label class="text-sm">Mode
        <input id="edMode" class="w-full border rounded px-2 py-1" value="${t.mode || ''}">
      </label>
      <label class="text-sm col-span-2">Ref
        <input id="edRef" class="w-full border rounded px-2 py-1" value="${t.ref || ''}">
      </label>
      <label class="text-sm">Return Source
        <input id="edSource" class="w-full border rounded px-2 py-1" value="${t.source || ''}">
      </label>
      <label class="text-sm col-span-2">Note
        <input id="edNote" class="w-full border rounded px-2 py-1" value="${t.note || ''}">
      </label>
      ${ t.imageUrl ? `
        <div class="col-span-2">
          <div class="text-sm text-gray-600 mb-1">Attached Image</div>
          <a href="${t.imageUrl}" target="_blank" class="inline-flex items-center gap-2">
            <img src="${t.imageUrl}" class="w-16 h-16 object-cover rounded border" alt="txn"/>
            <span class="text-xs underline">Open full image</span>
          </a>
        </div>` : "" }
    </div>
    <div class="flex justify-end gap-2">
      <button id="edCancel" class="px-3 py-1.5 rounded border">Cancel</button>
      <button id="edSave" class="px-3 py-1.5 rounded bg-indigo-600 text-white">Save</button>
    </div>
  `;
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  overlay.addEventListener("click", e=>{ if(e.target===overlay) overlay.remove(); });
  card.querySelector("#edCancel").addEventListener("click", ()=> overlay.remove());
  card.querySelector("#edSave").addEventListener("click", async ()=>{
    t.type = card.querySelector("#edType").value;
    t.employeeId = card.querySelector("#edEmp").value;
    t.amount = parseFloat(card.querySelector("#edAmt").value || 0);
    const co = card.querySelector("#edCut").value;
    t.cutOverride = (co==="") ? null : parseFloat(co);
    t.date = card.querySelector("#edDate").value.trim();
    t.time = card.querySelector("#edTime").value.trim();
    t.mode = card.querySelector("#edMode").value.trim();
    t.ref  = card.querySelector("#edRef").value.trim();
    t.source = card.querySelector("#edSource").value.trim();
    t.note = card.querySelector("#edNote").value.trim();
    overlay.remove();
    await readyPromise; await save();
  });
}

/* ------------------------------- UI wiring -------------------------------- */
function renderSelectedFiles(files){
  const sel = document.getElementById("selectedFiles");
  if(!sel) return;
  if(!files || !files.length){ sel.innerHTML=""; return; }
  sel.innerHTML = `<div class="text-sm text-gray-600">${files.length} file(s) selected.</div>`;
}

async function ocrImage(file){
  const worker = await Tesseract.createWorker();
  const { data:{ text } } = await worker.recognize(file);
  await worker.terminate();
  return text;
}

function makeParsedCard(parsed, imgUrl, file){
  const card = el("div","border rounded-xl p-3 bg-white shadow-sm");
  card.innerHTML = `
    <div class="flex gap-3">
      <img src="${imgUrl}" class="w-24 h-24 object-cover rounded-lg border" alt="screenshot">
      <div class="flex-1 grid grid-cols-2 gap-2">
        <label class="text-xs">Type
          <select class="w-full border rounded px-2 py-1" data-f="type">
            <option value="outgoing">Outgoing</option>
            <option value="return">Return</option>
          </select>
        </label>
        <label class="text-xs">Employee
          <select class="w-full border rounded px-2 py-1" data-f="employeeId">
            ${state.employees.map(e=> `<option value="${e.id}">${e.name}</option>`).join("")}
            <option value="">(Choose)</option>
          </select>
        </label>
        <label class="text-xs">Amount
          <input class="w-full border rounded px-2 py-1" data-f="amount" value="${parsed.amount ?? ""}">
        </label>
        <label class="text-xs">Mode
          <input class="w-full border rounded px-2 py-1" data-f="mode" value="${parsed.mode ?? ""}">
        </label>
        <label class="text-xs col-span-2">Date
          <input class="w-full border rounded px-2 py-1" data-f="date" value="${parsed.date ?? ""}">
        </label>
        <label class="text-xs">Time
          <input class="w-full border rounded px-2 py-1" data-f="time" value="${parsed.time ?? ""}">
        </label>
        <label class="text-xs">Ref
          <input class="w-full border rounded px-2 py-1" data-f="ref" value="${parsed.ref ?? ""}">
        </label>
        <label class="text-xs">Return Source
          <input class="w-full border rounded px-2 py-1" data-f="source" value="">
        </label>
        <label class="text-xs col-span-2">Note
          <input class="w-full border rounded px-2 py-1" data-f="note" value="">
        </label>
      </div>
    </div>
    <div class="mt-2 flex justify-end gap-2">
      <button class="px-3 py-1.5 rounded border" data-act="cancel">Discard</button>
      <button class="px-3 py-1.5 rounded bg-emerald-600 text-white" data-act="save">Save</button>
    </div>
  `;

  const typeSel = card.querySelector('[data-f="type"]');
  const empSel  = card.querySelector('[data-f="employeeId"]');
  // Pre-fill type/employee from OCR guess
  const dirSel = document.getElementById("directionSelect");
  const dir = dirSel?.value === "auto" ? (parsed.direction || "outgoing") : dirSel.value;
  typeSel.value = dir === "return" ? "return" : "outgoing";
  if(parsed.employeeId){ empSel.value = parsed.employeeId; }

  card.querySelector('[data-act="cancel"]').addEventListener("click", ()=> card.remove());
  card.querySelector('[data-act="save"]').addEventListener("click", async ()=>{
    if(controlsDisabled) return showWarn("Pick a workspace first.");
    const id = uid();
    const rec = {
      id,
      type: typeSel.value,
      employeeId: empSel.value || "",
      amount: parseNumber(card.querySelector('[data-f="amount"]').value || 0),
      mode: card.querySelector('[data-f="mode"]').value.trim(),
      date: card.querySelector('[data-f="date"]').value.trim(),
      time: card.querySelector('[data-f="time"]').value.trim(),
      ref:  card.querySelector('[data-f="ref"]').value.trim(),
      source: card.querySelector('[data-f="source"]').value.trim(),
      note: card.querySelector('[data-f="note"]').value.trim(),
      cutOverride: null,
      createdAt: Date.now(),
      imageUrl: "" // NEW
    };
    if(!rec.amount || isNaN(rec.amount)){ alert("Amount missing/invalid"); return; }
    if(rec.type==="outgoing" && !rec.employeeId){ alert("Please choose an employee for outgoing"); return; }

    // Upload image and attach URL (non-blocking on failure)
    try{
      if(file){
        rec.imageUrl = await uploadTxnImage(file, id);
      }
    }catch(err){
      console.error("Image upload failed; saving without image", err);
      showWarn("Could not upload image; saved transaction without image.");
    }

    state.transactions.push(rec);
    card.remove();
    await readyPromise; await save();
  });

  return card;
}

function employeeNameById(id){
  const e = state.employees.find(x => x.id === id);
  return e ? e.name : "";
}
function findOrCreateEmployeeIdByName(name){
  const n = (name || "").trim();
  if(!n) return "";
  let e = state.employees.find(x => x.name.toLowerCase() === n.toLowerCase());
  if(!e){
    e = { id: uid(), name: n, cutType: "percent", cutValue: 10 };
    state.employees.push(e);
  }
  return e.id;
}


/* ------------------------------ App bootstrap ----------------------------- */
function init(){
  // Auth + workspace
  initAuth();

  // Workspace controls
  document.getElementById("switchWorkspaceBtn")?.addEventListener("click", openWorkspaceModal);
  document.getElementById("wsCancel")?.addEventListener("click", closeWorkspaceModal);
  document.getElementById("wsGenerate")?.addEventListener("click", ()=>{
    document.getElementById("wsInput").value = randomCode();
  });
  document.getElementById("wsConfirm")?.addEventListener("click", ()=>{
    const v = document.getElementById("wsInput").value.trim();
    if(!v) { document.getElementById("wsError").classList.remove("hidden"); return; }
    closeWorkspaceModal(); setWorkspace(v);
  });

  const wsFromHash = getWorkspaceFromHash();
  const wsFromLS   = (()=>{ try{ return localStorage.getItem(WS_KEY); }catch(_){ return null; } })();
  const initialWs  = wsFromHash || wsFromLS || randomCode();
  setWorkspace(initialWs);

  // Import/Export
  document.getElementById("exportJsonBtn")?.addEventListener("click", exportJSON);
  const importJsonBtn = document.getElementById("importJsonBtn");
  const importJsonFile= document.getElementById("importJsonFile");
  importJsonBtn?.addEventListener("click", ()=> importJsonFile.click());
  importJsonFile?.addEventListener("change", e=>{
    const f = e.target.files?.[0];
    if(f) importJSONFile(f, importJsonFile);
  });

  // Employees
  document.getElementById("addEmployeeBtn")?.addEventListener("click", async ()=>{
    if(controlsDisabled) return showWarn("Pick a workspace first.");
    state.employees.push({ id: uid(), name:"", cutType:"percent", cutValue:10 });
    await readyPromise; await save();
  });
  document.getElementById("importEmpBtn")?.addEventListener("click", ()=> document.getElementById("importEmpFile").click());
  document.getElementById("importEmpFile")?.addEventListener("change", async e=>{
    if(controlsDisabled) return showWarn("Pick a workspace first.");
    const f=e.target.files?.[0]; if(!f) return;
    const t = await f.text();
    const rows = parseCsv(t);
    rows.forEach(r=>{
      state.employees.push({
        id: uid(),
        name: r.name || r.employee || "",
        cutType: (r.cuttype || r.cut_type || "percent").toLowerCase()==="flat" ? "flat":"percent",
        cutValue: parseFloat(r.cutvalue || r.cut_value || r.cut || "10")
      });
    });
    e.target.value="";
    await readyPromise; await save();
  });

  // File upload + OCR
  const dz = document.getElementById("dropZone");
  const input = document.getElementById("fileInput");
  dz?.addEventListener("click", ()=> input.click());
  dz?.addEventListener("dragover", e=>{ e.preventDefault(); dz.classList.add("ring-2","ring-emerald-400"); });
  dz?.addEventListener("dragleave", ()=> dz.classList.remove("ring-2","ring-emerald-400"));
  dz?.addEventListener("drop", e=>{
    e.preventDefault(); dz.classList.remove("ring-2","ring-emerald-400");
    const files = Array.from(e.dataTransfer.files || []).filter(f=> f.type.startsWith("image/"));
    input.files = (new DataTransfer()).files; // reset
    renderSelectedFiles(files);
    input.__picked = files;
  });
  input?.addEventListener("change", e=>{
    const files = Array.from(e.target.files || []);
    renderSelectedFiles(files);
    input.__picked = files;
  });

  document.getElementById("processBtn")?.addEventListener("click", async ()=>{
    if(controlsDisabled) return showWarn("Pick a workspace first.");
    const files = (input.__picked || []).filter(f=> f.type.startsWith("image/"));
    if(!files.length){ showWarn("Choose one or more screenshots first."); return; }

    const parsedList = document.getElementById("parsedList");
    const progress   = document.getElementById("progress");
    progress.textContent = "Running OCR…";
    parsedList.innerHTML = "";
    let done = 0;
    for(const file of files){
      try{
        const text = await ocrImage(file);
        const parsed = parseTransactionText(text);
        const url = URL.createObjectURL(file);
        parsedList.appendChild( makeParsedCard(parsed, url, file) ); // pass file
      }catch(err){
        console.error(err);
        parsedList.appendChild( el("div","text-red-600",`Failed to OCR: ${file.name}`) );
      }finally{
        done++; progress.textContent = `Processed ${done}/${files.length}`;
      }
    }
    progress.textContent = "Done.";
  });

  // Clear buttons & export/import for transactions (kept from your previous app)
  document.getElementById("clearOutgoingBtn")?.addEventListener("click", async ()=>{
    if(controlsDisabled) return showWarn("Pick a workspace first.");
    state.transactions = state.transactions.filter(t=>t.type!=="outgoing");
    await readyPromise; await save();
  });
  document.getElementById("clearIncomingBtn")?.addEventListener("click", async ()=>{
    if(controlsDisabled) return showWarn("Pick a workspace first.");
    state.transactions = state.transactions.filter(t=>t.type!=="return");
    await readyPromise; await save();
  });
  document.getElementById("clearAllBtn")?.addEventListener("click", async ()=>{
    if(controlsDisabled) return showWarn("Pick a workspace first.");
    state = { employees: [], transactions: [] };
    await readyPromise; await save();
  });

  // TODO: keep/import/export CSV handlers for outgoing/return (your existing ones)
  // ===== Export / Import buttons =====

// Export Employees (CSV)
document.getElementById("exportEmpBtn")?.addEventListener("click", () => {
  const rows = state.employees.map(e => ({
    name: e.name,
    cutType: e.cutType,
    cutValue: e.cutValue
  }));
  if(!rows.length){ showWarn("No employees to export."); return; }
  downloadCsv(toCsv(rows), "employees.csv");
});

// Export Outgoing (CSV)
document.getElementById("exportOutBtn")?.addEventListener("click", () => {
  const rows = state.transactions
    .filter(t => t.type === "outgoing")
    .map(t => ({
      date: t.date || "",
      employee: employeeNameById(t.employeeId),
      amount: t.amount ?? "",
      mode: t.mode || "",
      ref: t.ref || "",
      note: t.note || "",
      imageUrl: t.imageUrl || ""
    }));
  if(!rows.length){ showWarn("No outgoing transactions to export."); return; }
  downloadCsv(toCsv(rows), "outgoing.csv");
});

// Export Incoming (CSV)
document.getElementById("exportRetBtn")?.addEventListener("click", () => {
  const rows = state.transactions
    .filter(t => t.type === "return")
    .map(t => ({
      date: t.date || "",
      amount: t.amount ?? "",
      mode: t.mode || "",
      ref: t.ref || "",
      source: t.source || "",
      note: t.note || "",
      imageUrl: t.imageUrl || ""
    }));
  if(!rows.length){ showWarn("No incoming transactions to export."); return; }
  downloadCsv(toCsv(rows), "incoming.csv");
});

// Import Outgoing (CSV)
const importOutInput = document.getElementById("importOutFile");
document.getElementById("importOutBtn")?.addEventListener("click", () => importOutInput?.click());
importOutInput?.addEventListener("change", async (e) => {
  const f = e.target.files?.[0]; if(!f) return;
  const rows = parseCsv(await f.text()); // headers are lowercased by parseCsv()
  let count = 0;
  for(const r of rows){
    const empName = r.employee || r.name || "";
    const employeeId = findOrCreateEmployeeIdByName(empName);
    const id = uid();
    state.transactions.push({
      id,
      type: "outgoing",
      employeeId,
      amount: parseNumber(r.amount),
      mode: r.mode || "",
      date: r.date || "",
      time: r.time || "",
      ref: r.ref || r.reference || "",
      note: r.note || "",
      imageUrl: r.imageurl || r.image || "",
      cutOverride: r.cutoverride ? parseNumber(r.cutoverride) : null,
      createdAt: Date.now()
    });
    count++;
  }
  e.target.value = "";
  await save();
  showWarn(`Imported ${count} outgoing rows.`);
});

// Import Incoming (CSV)
const importRetInput = document.getElementById("importRetFile");
document.getElementById("importRetBtn")?.addEventListener("click", () => importRetInput?.click());
importRetInput?.addEventListener("change", async (e) => {
  const f = e.target.files?.[0]; if(!f) return;
  const rows = parseCsv(await f.text());
  let count = 0;
  for(const r of rows){
    const id = uid();
    state.transactions.push({
      id,
      type: "return",
      employeeId: "",                 // not used for returns
      amount: parseNumber(r.amount),
      mode: r.mode || "",
      date: r.date || "",
      time: r.time || "",
      ref: r.ref || r.reference || "",
      source: r.source || "",
      note: r.note || "",
      imageUrl: r.imageurl || r.image || "",
      cutOverride: null,
      createdAt: Date.now()
    });
    count++;
  }
  e.target.value = "";
  await save();
  showWarn(`Imported ${count} incoming rows.`);
});

}

function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function pickCSVFile() {
  return new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv";
    input.onchange = e => resolve(e.target.files[0]);
    input.click();
  });
}

async function parseCSV(file) {
  const text = await file.text();
  return text
    .split("\n")
    .map(line => line.split(","))
    .filter(row => row.length > 1); // filter out empty rows
}

window.addEventListener("load", ()=>{
  // Auto-open workspace on first load
  const fromHash = getWorkspaceFromHash();
  if(!fromHash){
    openWorkspaceModal();
    document.getElementById("wsInput").value = (()=>{
      try{ return localStorage.getItem(WS_KEY) || randomCode(); }catch(_){ return randomCode(); }
    })();
  }
  init();
});
