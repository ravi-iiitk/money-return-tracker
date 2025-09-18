// ===== Simple, colorful, mobile-first OCR money tracker =====

const DB_KEY = "smt-data-v1";
let state = {
  employees: [], // {id, name, cutType:'percent'|'flat', cutValue:number}
  transactions: [] // {id,type:'outgoing'|'return',employeeId?,amount,date,time,mode,ref,source?,note,cutOverride?,createdAt}
};

// ---- Utils ----
const uid = () => Math.random().toString(36).slice(2);
const save = () => { localStorage.setItem(DB_KEY, JSON.stringify(state)); renderAll(); };
const load = () => { try{ const raw = localStorage.getItem(DB_KEY); if(raw) state = JSON.parse(raw);}catch(_){} };

const el = (t,c="",h="") => { const e=document.createElement(t); if(c) e.className=c; if(h) e.innerHTML=h; return e; };
const fmtMoney = n => "₹ " + (Number(n||0)).toLocaleString(undefined,{maximumFractionDigits:2});
const parseNumber = s => parseFloat(String(s??"").replace(/[^\d.-]/g,""))

// ---- Employees table ----
function renderEmployees(){
  const tbody = document.getElementById("employeeTbody");
  tbody.innerHTML = "";
  state.employees.forEach(emp=>{
    const tr = el("tr");
    tr.innerHTML = `
      <td class="p-2"><input class="w-full border rounded px-2 py-1" value="${emp.name}" data-id="${emp.id}" data-f="name"></td>
      <td class="p-2">
        <select class="border rounded px-2 py-1" data-id="${emp.id}" data-f="cutType">
          <option value="percent" ${emp.cutType==='percent'?'selected':''}>Percent (%)</option>
          <option value="flat" ${emp.cutType==='flat'?'selected':''}>Flat (₹)</option>
        </select>
      </td>
      <td class="p-2"><input type="number" step="0.01" class="w-32 border rounded px-2 py-1" value="${emp.cutValue}" data-id="${emp.id}" data-f="cutValue"></td>
      <td class="p-2">
        <button class="px-2 py-1 rounded bg-red-50 text-red-700 border border-red-200 hover:bg-red-100" data-id="${emp.id}" data-action="del">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll("input,select,button").forEach(ctrl=>{
    ctrl.addEventListener("change", e=>{
      const id = e.target.dataset.id;
      const f  = e.target.dataset.f;
      const i  = state.employees.findIndex(x=>x.id===id);
      if(i>=0){
        if(f==="name") state.employees[i].name = e.target.value.trim();
        if(f==="cutType") state.employees[i].cutType = e.target.value;
        if(f==="cutValue") state.employees[i].cutValue = parseFloat(e.target.value || 0);
        save();
      }
    });
    ctrl.addEventListener("click", e=>{
      if(e.target.dataset.action==="del"){
        const id = e.target.dataset.id;
        state.employees = state.employees.filter(x=>x.id!==id);
        save();
      }
    });
  });

  // Fill quick-select used in OCR cards
  const sel = document.getElementById("employeeSelect");
  sel.innerHTML = `<option value="">(Auto / Choose)</option>` + state.employees.map(e=> `<option value="${e.id}">${e.name}</option>`).join("");
}

// ---- OCR helpers ----
function detectDirection(text){
  const t = text.toLowerCase();
  const isReturn   = /(credited|received|payment received|incoming)/.test(t);
  const isOutgoing = /(debited|paid to|payment to|sent to|transfer to|outgoing)/.test(t);
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
    if(token in scales){ if(current===0) current=1; current*=scales[token]; total+=current; current=0; seen=true; continue; }
  }
  total+=current;
  return seen?total:null;
}
const lineLooksLikeTime = line => /\d{1,2}:\d{2}/.test(line) && /(am|pm)\b/i.test(line);
const cleanNumericToken = s => s.replace(/[Oo]/g,"0").replace(/[Il]/g,"1").replace(/[,\s]/g,"");
function extractAmount(text){
  const add=(v,w)=>{ if(v==null||isNaN(v)) return; cands.push({val:+v,weight:w}); };
  const lines = text.split(/\n+/).map(s=>s.trim()).filter(Boolean);
  const cands = [];

  // currency-marked lines
  for(const line of lines){
    if(/(₹|rs\.?|inr)/i.test(line)){
      const m=line.match(/(?:₹|rs\.?|inr)\s*([0-9][0-9\s,]*(?:\.\d{1,2})?)/i);
      if(m) add(parseFloat(cleanNumericToken(m[1])),5);
    }
  }
  // label lines
  for(const line of lines){
    if(/(total amount|amount|debited|credited|paid|transfer)/i.test(line)){
      const m=line.match(/([0-9][0-9\s,]*(?:\.\d{1,2})?)/);
      if(m) add(parseFloat(cleanNumericToken(m[1])),4);
    }
  }
  // words
  const wm=text.match(/([A-Za-z\s\-]+)\s+(?:rupees|rs\.?|only)\b/i);
  if(wm){ const w=wordsToNumber(wm[1]); if(w!=null) add(w,3); }

  // fallback: per line numerics (skip time-like)
  for(const line of lines){
    if(lineLooksLikeTime(line)) continue;
    const ms=Array.from(line.matchAll(/([0-9][0-9\s,]*(?:\.\d{1,2})?)/g));
    for(const mm of ms){
      const raw=mm[1];
      const n=parseFloat(cleanNumericToken(raw));
      if(n<50) continue;
      const digitsOnly=raw.replace(/[^\d]/g,"");
      if(!/[,\s]/.test(raw) && digitsOnly.length>=9) continue; // looks like ID
      add(n, /[,\s]/.test(raw) ? 2 : 1.2);
    }
  }
  if(!cands.length) return null;
  cands.sort((a,b)=> b.weight-a.weight || b.val-a.val);
  return cands[0].val;
}
function extractDateTime(text){
  const datePatterns=[/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/g,/(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4})/g];
  const timePattern=/(\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM|am|pm)?)/;
  let date=null,time=null; for(const p of datePatterns){ const m=p.exec(text); if(m){date=m[1];break;} }
  const tm=timePattern.exec(text); if(tm) time=tm[1];
  return {date,time};
}
function extractRef(text){
  const m=text.match(/(?:UTR|UPI Ref(?:erence)?|Ref(?:erence)? No\.?|Txn(?:\.|) ?ID|Transaction(?:\s*ID)?|Transaction\s*ID)\s*[:\-]?\s*([A-Z0-9\-]+)/i);
  return m?m[1]:null;
}
function extractMode(text){
  const t=text.toLowerCase();
  if(t.includes("upi")) return "UPI";
  if(t.includes("imps")) return "IMPS";
  if(t.includes("neft")) return "NEFT";
  if(t.includes("rtgs")) return "RTGS";
  if(t.includes("gpay") || t.includes("google pay")) return "GPay";
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
  }
  return null;
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

// ---- Totals (employees never return; CA does) ----
function computeSummary(){
  const per = {};
  state.employees.forEach(e => per[e.id] = {
    name:e.name, cutType:e.cutType, cutValue:e.cutValue,
    outgoings:[], totalSent:0, totalCut:0, totalExpected:0
  });

  state.transactions.filter(t=>t.type==="outgoing").forEach(t=>{
    const emp = per[t.employeeId]; if(!emp) return;
    const cut = (t.cutOverride!=null) ? t.cutOverride :
      (emp.cutType==="percent" ? (t.amount*(emp.cutValue/100)) : emp.cutValue);
    const expected = Math.max(0, t.amount - cut);
    emp.outgoings.push({...t, computedCut:cut, expectedReturn:expected});
    emp.totalSent += t.amount;
    emp.totalCut += cut;
    emp.totalExpected += expected;
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

// ---- Summary & tables ----
function renderSummary(){
  // Overall
  const ot = computeOverallTotals();
  const overall = document.getElementById("overallTotals");
  overall.innerHTML = `
    <div class="border rounded-lg p-3 bg-white"><div class="text-xs text-gray-600">Total Sent</div><div class="font-medium">${fmtMoney(ot.totalSent)}</div></div>
    <div class="border rounded-lg p-3 bg-white"><div class="text-xs text-gray-600">Expected Back</div><div class="font-medium">${fmtMoney(ot.totalExpected)}</div></div>
    <div class="border rounded-lg p-3 bg-white"><div class="text-xs text-gray-600">Returned (CA)</div><div class="font-medium">${fmtMoney(ot.totalReturned)}</div></div>
    <div class="border rounded-lg p-3 ${ot.overallBalance>0?'bg-amber-50':'bg-emerald-50'}"><div class="text-xs text-gray-600">Overall Balance</div><div class="font-medium">${fmtMoney(ot.overallBalance)}</div></div>
  `;

  // Per-employee
  const per = computeSummary();
  const wrap = document.getElementById("summaryCards");
  wrap.innerHTML = "";
  Object.values(per).forEach(e=>{
    const card = el("div","rounded-xl border p-4 bg-white shadow-sm");
    card.innerHTML = `
      <div class="flex items-center justify-between">
        <div class="font-semibold">${e.name}</div>
        <div class="text-xs text-gray-500">Cut rule: ${e.cutType==="percent"? e.cutValue+"%":"₹ "+e.cutValue}</div>
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
        <td class="p-2">
          <button class="px-2 py-1 rounded border hover:bg-gray-100" data-id="${t.id}" data-act="edit">Edit</button>
          <button class="px-2 py-1 rounded border text-red-700 hover:bg-red-50" data-id="${t.id}" data-act="del">Delete</button>
        </td>
      `;
      outT.appendChild(tr);
    } else {
      const tr = el("tr");
      tr.innerHTML = `
        <td class="p-2">${t.date || "-"}</td>
        <td class="p-2">${fmtMoney(t.amount)}</td>
        <td class="p-2">${t.mode || "-"}</td>
        <td class="p-2">${t.ref || "-"}</td>
        <td class="p-2">${t.source || ""}</td>
        <td class="p-2">${t.note || ""}</td>
        <td class="p-2">
          <button class="px-2 py-1 rounded border hover:bg-gray-100" data-id="${t.id}" data-act="edit">Edit</button>
          <button class="px-2 py-1 rounded border text-red-700 hover:bg-red-50" data-id="${t.id}" data-act="del">Delete</button>
        </td>
      `;
      retT.appendChild(tr);
    }
  });

  [outT,retT].forEach(tb=> tb.querySelectorAll("button").forEach(btn=>{
    btn.addEventListener("click", e=>{
      const id = e.target.dataset.id, act = e.target.dataset.act;
      if(act==="del"){
        state.transactions = state.transactions.filter(t=>t.id!==id);
        save();
      }else if(act==="edit"){
        const t = state.transactions.find(x=>x.id===id);
        openEditDialog(t);
      }
    });
  }));
}

// ---- Edit dialog ----
function openEditDialog(t){
  const overlay = el("div","fixed inset-0 bg-black/30 grid place-items-center p-4 z-50");
  const card = el("div","bg-white rounded-2xl p-5 max-w-lg w-full space-y-3 shadow-xl");
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
        <input id="edCut" type="number" step="0.01" class="w-full border rounded px-2 py-1" value="${t.cutOverride ?? ''}">
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
    </div>
    <div class="flex justify-end gap-2">
      <button id="edCancel" class="px-3 py-1.5 rounded border">Cancel</button>
      <button id="edSave" class="px-3 py-1.5 rounded bg-primary text-white">Save</button>
    </div>
  `;
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  overlay.addEventListener("click", e=>{ if(e.target===overlay) overlay.remove(); });
  card.querySelector("#edCancel").addEventListener("click", ()=> overlay.remove());
  card.querySelector("#edSave").addEventListener("click", ()=>{
    t.type = card.querySelector("#edType").value;
    t.employeeId = card.querySelector("#edEmp").value;
    t.amount = parseFloat(card.querySelector("#edAmt").value || 0);
    const co = card.querySelector("#edCut").value; t.cutOverride = (co==="") ? null : parseFloat(co);
    t.date = card.querySelector("#edDate").value.trim();
    t.time = card.querySelector("#edTime").value.trim();
    t.mode = card.querySelector("#edMode").value.trim();
    t.ref  = card.querySelector("#edRef").value.trim();
    t.source = card.querySelector("#edSource").value.trim();
    t.note = card.querySelector("#edNote").value.trim();
    overlay.remove(); save();
  });
}

// ---- Selected files widget ----
function renderSelectedFiles(){
  const wrap = document.getElementById("selectedFiles");
  const input = document.getElementById("fileInput");
  const files = input.files;
  if(!files || !files.length){
    wrap.innerHTML = `<div class="text-sm text-gray-600">No files selected.</div>`;
    return;
  }
  let total=0; const cards=[];
  for(let i=0;i<files.length;i++){
    const f=files[i]; total+=f.size||0;
    const url=URL.createObjectURL(f); const name=f.name||`image-${i+1}`;
    cards.push(`
      <div class="border rounded-lg p-2 flex items-center gap-2 bg-white">
        <img src="${url}" class="w-12 h-12 object-cover rounded border" alt="preview">
        <div class="min-w-0 flex-1">
          <div class="text-sm truncate" title="${name}">${name}</div>
          <div class="text-xs text-gray-500">${(f.size/1024).toFixed(1)} KB</div>
        </div>
        <button class="px-2 py-1 text-xs rounded border hover:bg-gray-100" onclick="removeSelectedFile(${i})">Remove</button>
      </div>
    `);
  }
  wrap.innerHTML = `
    <div class="flex items-center justify-between mb-2">
      <div class="text-sm font-medium">${files.length} file(s) selected — ${(total/1024).toFixed(1)} KB</div>
      <button class="px-2 py-1 text-xs rounded border hover:bg-gray-100" onclick="clearSelectedFiles()">Clear selection</button>
    </div>
    <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">${cards.join("")}</div>
  `;
}
function removeSelectedFile(idx){
  const input=document.getElementById("fileInput");
  try{
    const dt=new DataTransfer();
    for(let i=0;i<input.files.length;i++){ if(i!==idx) dt.items.add(input.files[i]); }
    input.files=dt.files; renderSelectedFiles();
  }catch{ alert("Your browser can't remove single files; use Clear selection."); }
}
function clearSelectedFiles(){ document.getElementById("fileInput").value=""; renderSelectedFiles(); }

// ---- Export / Import (JSON + CSV) ----
function exportJSON(){
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(state,null,2));
  const a=document.createElement("a"); a.href=dataStr; a.download="screenshot-money-tracker.json"; a.click();
}
const toCsv = rows => {
  if(!rows.length){ alert("Nothing to export"); return ""; }
  const esc = s => `"${String(s??"").replace(/"/g,'""')}"`;
  const header = Object.keys(rows[0]).map(esc).join(",");
  const body   = rows.map(r => Object.values(r).map(esc).join(",")).join("\n");
  return header + "\n" + body;
};
function downloadCsv(content, name){
  const blob=new Blob([content],{type:"text/csv;charset=utf-8;"}); 
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a"); a.href=url; a.download=name; a.click(); URL.revokeObjectURL(url);
}

function exportEmployeesCSV(){
  const per = computeSummary();
  const rows = Object.values(per).map(e=>({
    employee: e.name,
    cut_type: e.cutType,
    cut_value: e.cutValue,
    total_sent: e.totalSent,
    total_cut: e.totalCut,
    total_expected: e.totalExpected
  }));
  const csv = toCsv(rows); if(csv) downloadCsv(csv,"employees.csv");
}
function exportOutgoingCSV(){
  const per = computeSummary();
  const rows = [];
  Object.values(per).forEach(e=> e.outgoings.forEach(o=>{
    rows.push({ date:o.date||"", time:o.time||"", employee:e.name, amount:o.amount, cut:o.computedCut,
      expected_return:o.expectedReturn, mode:o.mode||"", ref:o.ref||"", note:o.note||"" });
  }));
  const csv = toCsv(rows); if(csv) downloadCsv(csv,"outgoing.csv");
}
function exportReturnsCSV(){
  const rows = state.transactions.filter(t=>t.type==="return").map(r=>({
    date:r.date||"", time:r.time||"", amount:r.amount, mode:r.mode||"",
    ref:r.ref||"", source:r.source||"", note:r.note||""
  }));
  const csv = toCsv(rows); if(csv) downloadCsv(csv,"incoming.csv");
}

// --- CSV parser & imports ---
function parseCSV(text){
  // tiny RFC4180-ish parser (handles quotes and commas)
  const rows=[]; let cur=[], val="", inQ=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i], next=text[i+1];
    if(inQ){
      if(ch==='"' && next==='"'){ val+='"'; i++; }
      else if(ch === '"'){ inQ=false; }
      else { val+=ch; }
    }else{
      if(ch === '"'){ inQ=true; }
      else if(ch === ','){ cur.push(val); val=""; }
      else if(ch === '\n'){ cur.push(val); rows.push(cur); cur=[]; val=""; }
      else if(ch === '\r'){ /* ignore */ }
      else { val+=ch; }
    }
  }
  cur.push(val); rows.push(cur);
  // map to objects using header
  const header = rows.shift().map(h => h.toLowerCase().trim().replace(/[^\w]+/g,'_'));
  return rows.filter(r=> r.some(x=>String(x).trim()!=="")).map(r=>{
    const obj={}; header.forEach((h,i)=> obj[h]=r[i] ?? ""); return obj;
  });
}

function getOrCreateEmployeeByName(name){
  const nm=(name||"").trim(); if(!nm) return "";
  const e = state.employees.find(x => x.name.toLowerCase() === nm.toLowerCase());
  if(e) return e.id;
  const id = uid();
  state.employees.push({id, name:nm, cutType:"percent", cutValue:0});
  return id;
}

function importEmployeesCSV(file){
  const reader = new FileReader();
  reader.onload = e=>{
    try{
      const rows = parseCSV(e.target.result);
      rows.forEach(r=>{
        const name = r.employee || r.name || "";
        if(!name) return;
        const cutType = /flat/i.test(r.cut_type) ? "flat" : "percent";
        const cutValue = parseNumber(r.cut_value);
        const id = getOrCreateEmployeeByName(name);
        const ix = state.employees.findIndex(x=>x.id===id);
        state.employees[ix].cutType = cutType;
        if(!isNaN(cutValue)) state.employees[ix].cutValue = cutValue;
      });
      save();
      alert("Employees imported.");
    }catch{ alert("Failed to import Employees CSV."); }
  };
  reader.readAsText(file);
}

function importOutgoingCSV(file){
  const reader = new FileReader();
  reader.onload = e=>{
    try{
      const rows = parseCSV(e.target.result);
      rows.forEach(r=>{
        const empId = getOrCreateEmployeeByName(r.employee || r.name || "");
        const amount = parseNumber(r.amount);
        if(!amount || isNaN(amount)) return;
        state.transactions.push({
          id: uid(),
          type: "outgoing",
          employeeId: empId,
          amount,
          date: (r.date||"").trim(),
          time: (r.time||"").trim(),
          mode: (r.mode||"").trim(),
          ref:  (r.ref||r.reference||"").trim(),
          note: (r.note||"").trim(),
          cutOverride: r.cut ? parseNumber(r.cut) : null,
          createdAt: Date.now()
        });
      });
      save();
      alert("Outgoing imported.");
    }catch{ alert("Failed to import Outgoing CSV."); }
  };
  reader.readAsText(file);
}

function importIncomingCSV(file){
  const reader = new FileReader();
  reader.onload = e=>{
    try{
      const rows = parseCSV(e.target.result);
      rows.forEach(r=>{
        const amount = parseNumber(r.amount);
        if(!amount || isNaN(amount)) return;
        state.transactions.push({
          id: uid(),
          type: "return",
          employeeId: "", // CA/bank side
          amount,
          date: (r.date||"").trim(),
          time: (r.time||"").trim(),
          mode: (r.mode||"").trim(),
          ref:  (r.ref||r.reference||"").trim(),
          source:(r.source||"").trim(),
          note:  (r.note||"").trim(),
          createdAt: Date.now()
        });
      });
      save();
      alert("Incoming imported.");
    }catch{ alert("Failed to import Incoming CSV."); }
  };
  reader.readAsText(file);
}

function importJSONFile(file){
  const reader = new FileReader();
  reader.onload = (e)=>{
    try{
      const obj = JSON.parse(e.target.result);
      if(obj && obj.employees && obj.transactions){ state=obj; save(); }
      else alert("Invalid JSON structure");
    }catch(err){ alert("Failed to parse JSON"); }
  };
  reader.readAsText(file);
}

// ---- OCR card ----
function makeParsedCard(parsed, imgUrl){
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
        <label class="text-xs">Date
          <input class="w-full border rounded px-2 py-1" data-f="date" value="${parsed.date ?? ""}">
        </label>
        <label class="text-xs">Time
          <input class="w-full border rounded px-2 py-1" data-f="time" value="${parsed.time ?? ""}">
        </label>
        <label class="text-xs col-span-2">Ref
          <input class="w-full border rounded px-2 py-1" data-f="ref" value="${parsed.ref ?? ""}">
        </label>
        <label class="text-xs">Source (for returns; e.g., CA/bank)
          <input class="w-full border rounded px-2 py-1" data-f="source" value="">
        </label>
        <label class="text-xs col-span-2">Counterparty (from OCR)
          <input class="w-full border rounded px-2 py-1" value="${parsed.counterparty ?? ""}" disabled>
        </label>
        <label class="text-xs col-span-2">Note
          <input class="w-full border rounded px-2 py-1" data-f="note" value="">
        </label>
      </div>
    </div>
    <div class="flex justify-end gap-2 mt-2">
      <button class="px-3 py-1.5 rounded border" data-act="discard">Discard</button>
      <button class="px-3 py-1.5 rounded bg-primary text-white" data-act="save">Save</button>
    </div>
  `;

  const typeSel = card.querySelector('[data-f="type"]');
  const empSel  = card.querySelector('[data-f="employeeId"]');

  // Direction override
  const dirSel = document.getElementById("directionSelect").value;
  if(dirSel==="outgoing" || dirSel==="return") typeSel.value = dirSel;
  else if(parsed.direction==="outgoing" || parsed.direction==="return") typeSel.value = parsed.direction;

  // Employee default from select or OCR mapping
  const preEmp = document.getElementById("employeeSelect").value || parsed.employeeId || "";
  if(preEmp) empSel.value = preEmp;

  card.querySelector('[data-act="discard"]').addEventListener("click", ()=> card.remove());
  card.querySelector('[data-act="save"]').addEventListener("click", ()=>{
    const rec = {
      id: uid(),
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
      createdAt: Date.now()
    };
    if(!rec.amount || isNaN(rec.amount)){ alert("Amount missing/invalid"); return; }
    if(rec.type==="outgoing" && !rec.employeeId){ alert("Choose an employee for outgoing"); return; }
    state.transactions.push(rec);
    card.remove(); save();
  });

  return card;
}

// ---- Init & event wiring ----
function renderAll(){ renderEmployees(); renderSummary(); renderTransactions(); }

function init(){
  load(); renderAll();

  const dropZone = document.getElementById("dropZone");
  const fileInput= document.getElementById("fileInput");
  const processBtn=document.getElementById("processBtn");
  const parsedList=document.getElementById("parsedList");
  const progress=document.getElementById("progress");

  dropZone.addEventListener("click", ()=> fileInput.click());
  fileInput.addEventListener("change", renderSelectedFiles);
  dropZone.addEventListener("dragover", e=>{ e.preventDefault(); dropZone.classList.add("bg-gray-50"); });
  dropZone.addEventListener("dragleave", ()=> dropZone.classList.remove("bg-gray-50"));
  dropZone.addEventListener("drop", e=>{
    e.preventDefault(); fileInput.files = e.dataTransfer.files; dropZone.classList.remove("bg-gray-50"); renderSelectedFiles();
  });
  renderSelectedFiles();

  document.getElementById("addEmployeeBtn").addEventListener("click", ()=>{
    state.employees.push({id:uid(), name:"New Employee", cutType:"percent", cutValue:0}); save();
  });
  document.getElementById("exportJsonBtn").addEventListener("click", exportJSON);
  document.getElementById("exportEmpBtn").addEventListener("click", exportEmployeesCSV);
  document.getElementById("exportOutBtn").addEventListener("click", exportOutgoingCSV);
  document.getElementById("exportRetBtn").addEventListener("click", exportReturnsCSV);
  document.getElementById("clearAllBtn").addEventListener("click", ()=>{
    if(confirm("Delete all employees & transactions?")){ state={employees:[], transactions:[]}; save(); }
  });

  // JSON import
  document.getElementById("importJsonBtn").addEventListener("click", ()=> document.getElementById("importJsonFile").click());
  document.getElementById("importJsonFile").addEventListener("change", e=>{
    if(e.target.files && e.target.files[0]) importJSONFile(e.target.files[0]);
  });

  // CSV imports
  document.getElementById("importEmpBtn").addEventListener("click", ()=> document.getElementById("importEmpFile").click());
  document.getElementById("importEmpFile").addEventListener("change", e=>{
    if(e.target.files && e.target.files[0]) importEmployeesCSV(e.target.files[0]);
  });
  document.getElementById("importOutBtn").addEventListener("click", ()=> document.getElementById("importOutFile").click());
  document.getElementById("importOutFile").addEventListener("change", e=>{
    if(e.target.files && e.target.files[0]) importOutgoingCSV(e.target.files[0]);
  });
  document.getElementById("importRetBtn").addEventListener("click", ()=> document.getElementById("importRetFile").click());
  document.getElementById("importRetFile").addEventListener("change", e=>{
    if(e.target.files && e.target.files[0]) importIncomingCSV(e.target.files[0]);
  });

  // OCR
  processBtn.addEventListener("click", async ()=>{
    const files = fileInput.files;
    if(!files || !files.length){ alert("Please choose screenshots"); return; }
    progress.textContent = "Running OCR...";
    parsedList.innerHTML = "";
    let done = 0;
    for(const file of files){
      try{
        const worker = await Tesseract.createWorker(); // lightweight default
        const { data:{ text } } = await worker.recognize(file);
        await worker.terminate();
        const parsed = parseTransactionText(text);
        const url = URL.createObjectURL(file);
        parsedList.appendChild( makeParsedCard(parsed, url) );
      }catch(err){
        console.error(err);
        parsedList.appendChild( el("div","text-red-600 text-sm",`Failed OCR for ${file.name}`) );
      }finally{
        done++; progress.textContent = `Processed ${done}/${files.length}`;
      }
    }
    progress.textContent += " — review & Save.";
  });
}
window.addEventListener("DOMContentLoaded", init);
