import * as pdfjs from './pdf.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.mjs';
const $=id=>document.getElementById(id), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const STOCK=new Set('1003 1020 5001 5004 5005 5007 5008 5010 5023 5024 6005 6022 7001 7076 8001 8055 8064 8069 8070'.split(' '));
const statuses=['New','To Run','To Pull','Sent to Moulder'];
const tabStatus={run:'To Run',pull:'To Pull',sent:'Sent to Moulder'};
let db=null, committed=null, revision=0, operator='', tab='new', selection=new Set();
let generating=false, saving=false, refreshing=false, printing=false, pendingPrint=null;
let setupAvailable=false, viewingBatch=null;
let loadedImport=null;
function hasLoadedSchedule(){
  return !!loadedImport&&db?.snapshot?.importedAt===loadedImport.at
    &&pdfInputs.every((id,index)=>$(id).files[0]===loadedImport.files[index]);
}
const displayState=()=>viewingBatch?.data??db;
const batchDate=new Intl.DateTimeFormat('en-US',{dateStyle:'medium',timeStyle:'short',timeZone:'America/New_York'});
const activityDate=new Intl.DateTimeFormat('en-US',{dateStyle:'medium',timeZone:'America/New_York'});
function batchLabel(batch){
  return batch.day?activityDate.format(new Date(batch.savedAt))+' · Reconstructed':batchDate.format(new Date(batch.savedAt));
}
const busy=()=>generating||saving||refreshing||printing;
const norm=s=>String(s).toLowerCase().replace(/[^a-z0-9]/g,''), now=()=>new Date().toISOString();
function message(s,error=false){$('message').textContent=s;$('message').className=error?'error':'notice';}
function splitFields(r){let p=r.description.split(' - ');return {...r,profile:p[0],species:p[1]||'UNKNOWN',finish:p.slice(2).join(' - ')};}
async function hash(s){const a=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));return Array.from(new Uint8Array(a),x=>x.toString(16).padStart(2,'0')).join('');}
const scheduleRowPattern=/^\s*(-?\d+)\s+(\d{6})\s+(\d+)\s+(\d{4})\s+-\s+(.*)/;
const crossedOffPrefix='MFG_CROSSED_OFF ';

async function scheduleStrikeLines(page){
  const {fnArray,argsArray}=await page.getOperatorList({annotationMode:pdfjs.AnnotationMode.DISABLE});
  const ops=pdfjs.OPS, saved=[], lines=[];
  let transform=[1,0,0,1,0,0];
  for(let i=0;i<fnArray.length;i++){
    const op=fnArray[i], args=argsArray[i];
    if(op===ops.save){saved.push(transform);continue;}
    if(op===ops.restore){transform=saved.pop()??transform;continue;}
    if(op===ops.transform){transform=pdfjs.Util.transform(transform,args);continue;}
    if(op!==ops.constructPath)continue;
    // PDF.js supplies the painted path and its bounds in the active coordinate system.
    const [paint,,bounds]=args;
    if(!bounds||![ops.fill,ops.eoFill,ops.stroke,ops.closeStroke].includes(paint))continue;
    const pageBounds=[Infinity,Infinity,-Infinity,-Infinity];
    pdfjs.Util.axialAlignedBoundingBox(bounds,transform,pageBounds);
    const [left,bottom,right,top]=pageBounds;
    if(top-bottom<=2&&right-left>=4)lines.push({left,right,y:(bottom+top)/2});
  }
  return lines;
}

function hasStrikeThrough(item,lines){
  if(!item||item.width<=0||item.height<=0)return false;
  const [,,,,x,y]=item.transform;
  return lines.some(line=>{
    const heightFraction=(line.y-y)/item.height;
    const overlap=Math.min(line.right,x+item.width)-Math.max(line.left,x);
    return heightFraction>=0.18&&heightFraction<=0.55&&overlap>=item.width*0.8;
  });
}

function isCrossedOff(match,items,lines){
  if(!match)return false;
  // A divider or a mark over one cell alone should not complete an order line.
  const order=items.find(it=>it.str.trim()===match[2]);
  const product=items.find(it=>it.str.trim().startsWith(match[4]+' -'));
  return hasStrikeThrough(order,lines)&&hasStrikeThrough(product,lines);
}

async function pdfText(file,readScheduleMarks=false){
  if(!file)throw Error('Choose both PDF files.');
  if(file.size>30*1024*1024)throw Error('PDF is larger than 30 MB.');
  const doc=await pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer()),useSystemFonts:true,disableFontFace:true,isEvalSupported:false}).promise;
  const lines=[];
  try{
    for(let n=1;n<=doc.numPages;n++){
      const page=await doc.getPage(n);
      const {items}=await page.getTextContent();
      const strikes=readScheduleMarks?await scheduleStrikeLines(page):[];
      const rows=[];
      for(const item of items){
        if(!item.str?.trim())continue;
        const y=item.transform[5];
        let row=rows.find(r=>Math.abs(r.y-y)<2);
        if(!row){row={y,items:[]};rows.push(row);}
        row.items.push(item);
      }
      rows.sort((a,b)=>b.y-a.y);
      for(const row of rows){
        let line='';
        for(const item of row.items.sort((a,b)=>a.transform[4]-b.transform[4])){
          const pos=Math.round(item.transform[4]/3);
          line+=' '.repeat(Math.max(line?1:0,pos-line.length))+item.str;
        }
        lines.push(isCrossedOff(line.match(scheduleRowPattern),row.items,strikes)?crossedOffPrefix+line:line);
      }
      lines.push('PAGE_BREAK');
    }
  }finally{await doc.destroy();}
  return lines.join('\n');
}
function parseSchedule(text){
  if(!text.includes('Until')||!text.includes('Days'))throw Error('Current schedule: Days Until Due heading missing. Check the selected PDF.');
  const rows=[];
  let cur=null;
  for(const rawLine of text.split('\n')){
    const alreadyRun=rawLine.startsWith(crossedOffPrefix);
    const line=alreadyRun?rawLine.slice(crossedOffPrefix.length):rawLine;
    const match=line.match(scheduleRowPattern);
    if(match){
      cur={days:+match[1],order:match[2],qty:+match[3],number:match[4],description:match[5].trim()};
      if(alreadyRun)cur.alreadyRun=true;
      rows.push(cur);
    }else if(line.trim()){
      if(cur&&line.search(/\S/)>=20&&!/Open|logout|PAGE_BREAK/.test(line)&&!/^\s*\d{4}\s+-/.test(line))cur.description+=' '+line.trim();
      else cur=null;
    }
  }
  if(!rows.length)throw Error('No schedule rows found. An empty or scanned PDF cannot be interpreted as completed work.');
  return rows.map(splitFields);
}
function parseWip(text){if(!text.includes('INVOICE')||!text.includes('ASSEMBLE BY'))throw Error('WIP headings missing. Check the selected PDF.');let rows=[],cur=null;for(const l of text.split('\n')){if(/Moulding Schedule|Printed on|ASSEMBLE BY|PAGE_BREAK|^\s*(?:To|From)\s*$/.test(l))continue;if(/^\s*TOTAL\b/.test(l)){cur=null;continue;}let m=l.match(/\b(\d+)\s+(\d{4})\s+-\s+(.*)/), inv=l.match(/^\s*(\d{6})\s+(\d{1,2}\/\d{1,2}\/\d{4})/);if(m){cur={qty:+m[1],number:m[2],description:m[3].trim(),order:null,notes:[],date:''};rows.push(cur);}if(cur&&inv){if(cur.order&&cur.order!==inv[1])throw Error('WIP row alignment changed. Import stopped.');cur.order=inv[1];cur.date=inv[2];}if(cur&&!m){let tail=(inv?l.slice(inv[0].length):l).trim();if(/^\(\d+\)\s+at\b/.test(tail))cur.notes.push(tail);else if(tail){if(cur.notes.length)cur.notes[cur.notes.length-1]+=' '+tail;else cur.description+=' '+tail;}}}let count=(text.match(/^\s*\d{6}\s+\d{1,2}\/\d{1,2}\/\d{4}/gm)||[]).length;if(!rows.length||rows.length!==count||rows.some(r=>!r.order))throw Error('WIP row validation failed. No tracking changes were made.');return rows.map(splitFields);}
function stock(r){let s=norm(r.species);return STOCK.has(r.number)&&(['maple','hardmaple','maplehard'].includes(s)||s.includes('paintgrade'));}
function longNotes(notes){return notes.filter(n=>{n=n.replace(/[′’]/g,"'").replace(/″/g,'"');let found=false;for(const m of n.matchAll(/(\d+(?:\.\d+)?)\s*(?:'|feet\b|ft\b)(?:\s*(\d+(?:\.\d+)?)\s*(?:"|in\b))?/gi))if(+m[1]*12+ +(m[2]||0)>96)found=true;for(const m of n.matchAll(/(\d+(?:\.\d+)?)\s*(?:"|inches\b|in\b)\s*(?:long|length)/gi))if(+m[1]>96)found=true;return found;});}
async function mergePDFs(a,b){const schedule=parseSchedule(a),wip=parseWip(b),counts=new Map();for(const r of schedule){const key=r.order+'|'+r.number+'|'+norm(r.description);counts.set(key,(counts.get(key)||0)+1);}let rows=[];for(const r of schedule){let issues=[];const matches=wip.filter(w=>w.order===r.order&&w.number===r.number&&norm(w.description)===norm(r.description));let notes=[],date='';if(matches.length!==1)issues.push('WIP match missing or ambiguous — check sizing.');else{notes=matches[0].notes;date=matches[0].date;if(matches[0].qty!==r.qty)issues.push(`Quantity mismatch: schedule ${r.qty}, WIP ${matches[0].qty}.`);let nq=notes.reduce((s,n)=>s+ +(n.match(/^\((\d+)\)/)?.[1]||0),0);if(nq>r.qty)issues.push('Sizing quantities exceed the order line quantity.');}if(counts.get(r.order+'|'+r.number+'|'+norm(r.description))>1)throw Error(`Duplicate indistinguishable lines for ${r.order} / ${r.number}. Import stopped to avoid overwriting one line with another.`);const key=r.order+'-'+r.number+'-'+(await hash(norm(r.description))).slice(0,16);const fingerprint=await hash(JSON.stringify({qty:r.qty,notes:notes.map(n=>n.toLowerCase().replace(/\s+/g,' ').trim()).sort()}));rows.push({...r,key,fingerprint,notes,date,issues,stock:stock(r),long:longNotes(notes)});}return {rows,scheduleCount:schedule.length,wipCount:wip.length};}
function record(r){
  const data=displayState();
  return data?.records[r.key]??(viewingBatch?data?.archivedRecords?.[r.key]:undefined);
}
function priorBatchHandled(r){
  const data=displayState(),pair=r.order+'|'+r.number;
  return !!data?.priorScheduled?.[pair]||(data?.sentKeys??[]).includes(r.key);
}
function currentlyHandled(r){
  const data=displayState(),pair=r.order+'|'+r.number,handled=new Set(['To Run','To Pull','Sent to Moulder']);
  return Object.values({...data?.archivedRecords,...data?.records})
    .some(row=>row.order+'|'+row.number===pair&&handled.has(row.status))
    ||(data?.history??[]).some(entry=>[entry.previous,entry.current].some(row=>row&&row.order+'|'+row.number===pair&&handled.has(row.status)))
    ||(data?.reports??[]).some(report=>report.rows?.some(row=>row.order+'|'+row.number===pair));
}
function previouslyHandled(r){return priorBatchHandled(r)||currentlyHandled(r);}
function priorWarning(r){
  if(viewingBatch)return '';
  const prior=db?.priorScheduled?.[r.order+'|'+r.number];
  return prior?'Earlier batch: '+prior[0]+' · '+batchDate.format(new Date(prior[1]))+'. Verify before scheduling again.':'';
}
function review(r){let list=[...r.issues],old=record(r),data=displayState();if(old&&old.fingerprint!==r.fingerprint)list.push('Changed since last marked — compare quantity and sizing before marking again.');if(!old&&Object.values({...data.archivedRecords,...data.records}).some(o=>o.order===r.order&&o.number===r.number&&o.status!=='New'))list.push('Variant exists — another species or finish on this order/profile was marked.');if(!old&&data.archivedRecords?.[r.key])list.push('Previously removed from the MFG schedule — review before requesting again.');return list;}
function hidden(r){if(r.alreadyRun)return true;let o=record(r);return o&&o.status!=='New'&&o.fingerprint===r.fingerprint&&!review(r).length;}
function currentRows(){
  const data=displayState(), rows=data?.snapshot?.rows??[];
  if(!viewingBatch)return hasLoadedSchedule()?rows:[];
  const keys=new Set(rows.map(row=>row.key));
  return [...rows,...Object.values({...data.archivedRecords,...data.records})
    .filter(row=>!keys.has(row.key)).map(row=>({...row,absent:true}))];
}
function visibleRows(){let search=$('search').value.toLowerCase();let rows=currentRows().filter(r=>tab==='completed'?r.alreadyRun:!r.alreadyRun&&(tab==='new'?(r.days<=6&&!hidden(r)&&!previouslyHandled(r)):(record(r)?.status===tabStatus[tab]&&(viewingBatch||!review(r).length))));return rows.filter(r=>[r.order,r.number,r.species,r.description].join(' ').toLowerCase().includes(search)).sort((a,b)=>(a.days??999)-(b.days??999)||a.number.localeCompare(b.number)||a.species.localeCompare(b.species));}
function sizingLabel(r){
 const notes=r.notes||[]; let used=0;
 const explicit=n=>/(?:\d\s*(?:['′’]|ft\b|feet\b)|(?:"|inches\b|in\b)\s*(?:long|length))/i.test(n);
 const result=notes.map(n=>{const m=n.match(/^\((\d+)\)/);if(m)used+=+m[1];return explicit(n)?n:n+" × 8′ long";});
 if(!notes.length)return `(${r.qty}) at 8′`;
 if(used<r.qty)result.push(`(${r.qty-used}) at 8′`);
 return result.join('; ');
}
function formatRunWidth(widthInches){
  const units=widthInches*64;
  if(!Number.isSafeInteger(units)||!units)return String(widthInches);
  const whole=Math.floor(units/64);
  let numerator=units%64, denominator=64;
  if(!numerator)return String(whole);
  while(numerator%2===0){numerator/=2;denominator/=2;}
  return (whole?whole+' ':'')+numerator+'/'+denominator;
}

function overrideLabel(number, overrides=displayState()?.mouldingOverrides){
  const override=overrides?.[number];
  if(!override)return '';
  const labels=[];
  if(override.widthInches>0)labels.push('Run width '+formatRunWidth(override.widthInches)+'″');
  if(override.sticksPerPass>1)labels.push(override.sticksPerPass+' sticks per pass');
  return labels.join(' · ');
}

function rowHTML(r,interactive=true){let o=record(r),rev=review(r),flags='';const warning=priorWarning(r);if(warning)flags+='<div class="prior-warning">'+esc(warning)+'</div>';if(r.stock){flags+='<div class="flag stock-callout"><strong>STOCK PROFILE + SPECIES</strong><br>CHECK HARD MAPLE STOCK BEFORE RUNNING</div>';if(r.long?.length)flags+='<div class="flag red">OVER 8′ — VERIFY STOCK LENGTH; MAY NEED RUN<br>'+esc(r.long.join('; '))+'</div>';}if(rev.length)flags+='<div class="flag red">'+rev.map(esc).join('<br>')+'</div>';if(r.absent)flags+='<div class="muted">Not on latest schedule — history retained</div>';let oldDiff=o&&o.fingerprint!==r.fingerprint?'<div class="muted">Previously marked: '+esc(o.qty)+' pcs; '+esc(sizingLabel(o))+'</div>':'';const runLabel=r.alreadyRun?'Already Run · MFG report':o?.status||'New';return '<tr'+(r.stock?' class="stock-row"':'')+'>'+(interactive?'<td><input type="checkbox" aria-label="Select '+esc(r.order+' '+r.number)+'" data-key="'+esc(r.key)+'" '+(selection.has(r.key)?'checked':'')+'></td>':'')+'<td><strong>'+esc(r.number)+'</strong><br>'+esc(r.profile)+'<div class="muted">'+esc(r.species)+'</div>'+(r.stock?'<span class="stock-badge">STOCK MATCH</span>':'')+'</td><td>'+esc(r.order)+'<div class="muted">'+esc(runLabel)+'</div></td><td>'+esc(r.absent?'—':r.days<0?Math.abs(r.days)+' overdue':r.days)+'</td><td><strong>'+esc(r.qty)+'</strong></td><td>'+esc(sizingLabel(r))+(overrideLabel(r.number)?'<div class="muted"><strong>'+esc(overrideLabel(r.number))+'</strong></div>':'')+oldDiff+flags+'</td><td>'+esc(r.finish)+'<div class="muted">'+esc(o?.markedBy||'')+(o?.markedAt?' · '+esc(new Date(o.markedAt).toLocaleDateString()):'')+'</div></td></tr>';}
function tableHTML(rows,interactive=true){return '<table><thead><tr>'+(interactive?'<th><input id="selectAll" type="checkbox" aria-label="Select all visible"></th>':'')+'<th>Profile / species</th><th>Order / status</th><th>Workdays due</th><th>Pcs</th><th>Sizing / action</th><th>Finish / marking</th></tr></thead><tbody>'+rows.map(r=>rowHTML(r,interactive)).join('')+'</tbody></table>';}
const pdfInputs=['schedule','wip'];
function isPdf(file){
  return !!file&&(file.type==='application/pdf'||/\.pdf$/i.test(file.name??''));
}
function updateGenerate(){
  let selected=0;
  for(const id of pdfInputs){
    const loaded=isPdf($(id).files[0]);
    if(loaded)selected++;
    $(id+'Drop').classList.toggle('is-ready',loaded);
    $(id+'Status').textContent=loaded?'PDF selected':'Drop or choose a PDF';
  }
  const ready=selected===pdfInputs.length;
  const readiness=$('pdfReadiness');
  const label=ready?'Both PDFs ready':selected+' of '+pdfInputs.length+' PDFs selected';
  if(readiness.textContent!==label)readiness.textContent=label;
  readiness.classList.toggle('is-ready',ready);
  $('generate').disabled=!db||!ready||busy()||!!viewingBatch;
  $('generate').title=ready?'Generate the moulding list':'Choose both PDFs to generate the list';
}
for(const id of pdfInputs){
  const input=$(id), drop=$(id+'Drop');
  input.addEventListener('change',()=>{
    if(input.files.length&&!isPdf(input.files[0])){
      input.value='';
      message('Choose a PDF for this report.',true);
    }
    render();
  });
  drop.addEventListener('dragover',event=>{
    event.preventDefault();
    event.dataTransfer.dropEffect=input.disabled?'none':'copy';
    drop.classList.toggle('is-dragging',!input.disabled);
  });
  drop.addEventListener('dragleave',event=>{
    if(!drop.contains(event.relatedTarget))drop.classList.remove('is-dragging');
  });
  drop.addEventListener('drop',event=>{
    event.preventDefault();
    drop.classList.remove('is-dragging');
    if(input.disabled)return;
    const files=event.dataTransfer.files;
    if(files.length!==1||!isPdf(files[0])){
      message('Drop one PDF into each report area.',true);
      return;
    }
    input.files=files;
    render();
    message('');
  });
}
function render(){
  const enabled=!!db, historical=!!viewingBatch, data=displayState();
  document.body.classList.toggle('tracking-locked',!enabled);
  for(const id of ['schedule','wip','search'])$(id).disabled=!enabled||busy();
  document.querySelectorAll('[data-needs-db], [data-tab]').forEach(e=>e.disabled=!enabled||busy());
  for(const id of ['schedule','wip','print'])$(id).disabled=!enabled||busy()||historical;
  $('print').hidden=historical||!hasLoadedSchedule();
  $('newBatch').disabled=busy()||historical||(!db?.snapshot&&!Object.keys(db?.records??{}).length);
  $('viewBatches').disabled=busy();
  $('archiveBanner').hidden=!historical;
  $('archiveLabel').textContent=historical?batchLabel(viewingBatch):'';
  $('importPanel').hidden=historical;
  $('workActions').hidden=historical||!hasLoadedSchedule();
  updateGenerate();
  $('initialSetup').hidden=enabled||!setupAvailable;
  for(const id of ['initialTrackingFile','initialImport'])$(id).disabled=busy();
  const startedAt=db?.activeBatch?.startedAt??db?.snapshot?.importedAt;
  $('state').textContent=saving?'Saving changes…':startedAt?'Current batch · '+batchDate.format(new Date(startedAt))
    :enabled?'Shared tracker':setupAvailable?'First-time setup':'Shared tracker unavailable';
  $('operator').textContent=operator;
  const rows=enabled?visibleRows():[];
  const due=currentRows().filter(row=>row.days<=+$('days').value);
  $('metrics').innerHTML='<span><b>'+rows.length+'</b> visible lines</span><span><b>'+rows.reduce((total,row)=>total+row.qty,0)+'</b> pieces</span><span><b>'+due.filter(hidden).length+'</b> already marked / excluded</span>';
  $('snapshot').textContent=historical?(data.reports?.length??0)+' saved moulder reports'
    :hasLoadedSchedule()?'Schedule imported '+batchDate.format(new Date(data.snapshot.importedAt))+' · '+data.snapshot.scheduleCount+' schedule lines'
    :'Upload both PDFs to create the run list.';
  $('results').innerHTML=rows.length?tableHTML(rows,!historical&&tab==='new'):'<div class="empty">'+(!historical&&!hasLoadedSchedule()?'Choose the two PDFs, then click Generate.':'No lines in this view.')+'</div>';
  $('selected').textContent=selection.size+' selected';
  $('apply').hidden=tab!=='new';
  $('pull').hidden=tab!=='new';
  $('reset').hidden=true;
  $('print').textContent='Print Moulder Report';
  $('send').textContent='Finish report';
  $('send').hidden=tab!=='run'||!pendingPrint;
  document.querySelectorAll('[data-tab]').forEach(button=>button.classList.toggle('active',button.dataset.tab===tab));
  const selectAll=$('selectAll');
  if(selectAll){
    const selectable=rows.filter(row=>!row.alreadyRun&&!previouslyHandled(row));
    selectAll.checked=selectable.length>0&&selectable.every(row=>selection.has(row.key));
    selectAll.disabled=busy();
    selectAll.onchange=({target})=>{
      for(const row of selectable)target.checked?selection.add(row.key):selection.delete(row.key);
      render();
    };
  }
  for(const checkbox of document.querySelectorAll('[data-key]')){
    const row=rows.find(item=>item.key===checkbox.dataset.key);
    checkbox.disabled=busy()||!row||row.alreadyRun||previouslyHandled(row);
    checkbox.onchange=()=>{
      checkbox.checked?selection.add(checkbox.dataset.key):selection.delete(checkbox.dataset.key);
      $('selected').textContent=selection.size+' selected';
    };
  }
}

async function sharedRequest(body, method='PUT', path='/api/state'){
  const options=body?{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{};
  const response=await fetch(path,{...options,cache:'no-store',redirect:'error'});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok){
    const error=Error(payload.error||'Could not connect to shared tracking. Check your sign-in and try again.');
    error.status=response.status;
    throw error;
  }
  return payload;
}

function acceptShared(payload){
  const newBatch=!!db&&db.activeBatch?.id!==payload.data?.activeBatch?.id;
  setupAvailable=false;
  committed=payload.data;
  db=structuredClone(payload.data);
  revision=payload.revision;
  operator=payload.email;
  $('days').value=6;
  if(newBatch){
    if(!viewingBatch){tab='new';$('search').value='';}
    selection.clear();
    pendingPrint=null;
    for(const id of pdfInputs)$(id).value='';
  }
}

async function refreshShared(){
  if(busy()||$('reportDone').open)return;
  refreshing=true;
  try{
    const payload=await sharedRequest();
    if(payload.needsSetup){
      setupAvailable=payload.canInitialize;
      operator=payload.email;
      message(setupAvailable?'Choose the latest tracking JSON and import it once.':'The tracker is waiting for its first import.');
      return;
    }
    if(payload.revision!==revision){
      acceptShared(payload);
      selection.clear();
      pendingPrint=null;
      message('Latest shared tracking loaded.');
    }
  }catch(error){
    if(!db){setupAvailable=false;message(error.message,true);}
  }finally{
    refreshing=false;
    render();
  }
}

async function save(success, saveBatch=false){
  saving=true;
  render();
  try{
    acceptShared(await sharedRequest({revision,data:db},saveBatch?'POST':'PUT',saveBatch?'/api/batches/save-current':'/api/state'));
    message(success);
    return true;
  }catch(error){
    db=structuredClone(committed);
    try{
      const current=await sharedRequest();
      if(!current.needsSetup)acceptShared(current);
    }catch{}
    pendingPrint=null;
    selection.clear();
    message(error.status===409?error.message:'Save could not be confirmed. Review the shared list before retrying. '+error.message,true);
  }finally{
    saving=false;
    render();
  }
}

$('newBatch').onclick=async()=>{
  if(!db||busy()||viewingBatch||!confirm('Save this batch to history and start a new work list?'))return;
  saving=true;
  render();
  try{
    acceptShared(await sharedRequest({revision},'POST','/api/batches'));
    message('Batch saved. Upload both PDFs to start the new work list.');
  }catch(error){message(error.message,true);}
  finally{saving=false;render();}
};

async function openSavedBatch(id){
  const status=$('batchHistoryStatus');
  const list=$('batchHistoryList');
  for(const button of list.querySelectorAll('button'))button.disabled=true;
  try{
    const batch=await sharedRequest(null,'GET','/api/batches/'+encodeURIComponent(id));
    if(!$('batchHistory').open)return;
    viewingBatch=batch;
    const savedStatuses=Object.values(batch.data.records??{}).map(row=>row.status);
    tab=savedStatuses.includes('Sent to Moulder')?'sent':savedStatuses.includes('To Pull')?'pull':savedStatuses.includes('To Run')?'run':'new';
    selection.clear();
    $('search').value='';
    $('batchHistory').close();
    message('');
    render();
  }catch(error){status.textContent=error.message;}
  finally{for(const button of list.querySelectorAll('button'))button.disabled=false;}
}

$('viewBatches').onclick=async()=>{
  const dialog=$('batchHistory'), status=$('batchHistoryStatus'), list=$('batchHistoryList');
  list.replaceChildren();
  status.textContent='Loading saved batches…';
  if(!dialog.open)dialog.showModal();
  try{
    const {batches}=await sharedRequest(null,'GET','/api/batches');
    status.textContent=batches.length?'':'No saved batches yet.';
    for(const batch of batches){
      const entry=document.createElement('div');
      entry.className='batch-entry';
      const open=document.createElement('button');
      open.type='button';
      open.className='batch-open';
      open.textContent=batchLabel(batch);
      open.onclick=()=>openSavedBatch(batch.id);
      entry.append(open);
      const remove=document.createElement('button');
      remove.type='button';
      remove.className='batch-delete';
      if(batch.active){
        const active=document.createElement('span');
        active.className='muted';
        active.textContent='Current batch';
        entry.append(active);
      }else{
        remove.textContent='Delete';
        remove.setAttribute('aria-label','Delete batch '+batchLabel(batch));
        remove.onclick=()=>deleteSavedBatch(batch.id,batchLabel(batch),entry);
        entry.append(remove);
      }
      list.append(entry);
    }
  }catch(error){status.textContent=error.message;}
};
async function deleteSavedBatch(id,label,entry){
  if(busy()||!confirm('Delete batch '+label+' from history? Items already marked in it will remain blocked from future lists.'))return;
  saving=true;
  render();
  const list=$('batchHistoryList'),status=$('batchHistoryStatus');
  for(const button of list.querySelectorAll('button'))button.disabled=true;
  try{
    const result=await sharedRequest({revision},'DELETE','/api/batches/'+encodeURIComponent(id));
    if(result.data)acceptShared(result);
    entry.remove();
    status.textContent=list.children.length?'Batch deleted.':'No saved batches yet.';
  }catch(error){status.textContent=error.message;}
  finally{
    saving=false;
    for(const button of list.querySelectorAll('button'))button.disabled=false;
    render();
  }
}
$('backToBatch').onclick=()=>{
  viewingBatch=null;
  tab='new';
  selection.clear();
  $('search').value='';
  render();
};
$('initialSetup').onsubmit=async event=>{
  event.preventDefault();
  const file=$('initialTrackingFile').files[0];
  if(!setupAvailable||busy()||!file)return;
  if(file.size>4_000_000){message('Tracking import is too large.',true);return;}
  saving=true;
  render();
  try{
    const data=JSON.parse(await file.text());
    acceptShared(await sharedRequest(data,'POST','/api/setup'));
    $('initialTrackingFile').value='';
    message('Tracking history imported.');
  }catch(error){message(error.message,true);}
  finally{saving=false;render();}
};
$('generate').onclick=async()=>{
  if(!db||busy()||viewingBatch||!pdfInputs.every(id=>isPdf($(id).files[0])))return;
  const [schedule,wip]=[$('schedule').files[0],$('wip').files[0]];
  generating=true;
  render();
  message('Reading PDFs locally…');
  try{
    const parsed=await mergePDFs(await pdfText(schedule,true),await pdfText(wip));
    db.priorScheduled??={};
    for(const row of parsed.rows)if(row.alreadyRun){
      const key=row.order+'|'+row.number;
      if(!db.priorScheduled[key])db.priorScheduled[key]=['Already Run',now()];
    }
    archiveMissing(parsed.rows);
    db.snapshot={...parsed,importedAt:now(),scheduleName:schedule.name,wipName:wip.name};
    selection.clear();
    tab='new';
    pendingPrint=null;
    const count=parsed.rows.filter(row=>row.alreadyRun).length;
    if(await save(count?'Schedule saved. '+count+' crossed-off '+(count===1?'line is':'lines are')+' in Already Run.':'Schedule saved.'))loadedImport={at:db.snapshot.importedAt,files:[schedule,wip]};
  }catch(error){message(error.message,true);}
  finally{generating=false;render();}
};
function markRows(rows,status){for(const r of rows){let previous=record(r);const rec={...r,status,markedAt:now(),markedBy:''};delete rec.absent;db.records[r.key]=rec;db.history.push({at:now(),key:r.key,status,previous:previous?structuredClone(previous):null,current:structuredClone(rec)});}}
async function changeSelected(status){if(busy()||viewingBatch)return;if(!db||!selection.size){message('Select one or more lines first.',true);return;}const rows=visibleRows().filter(r=>selection.has(r.key));if(rows.some(r=>r.alreadyRun||previouslyHandled(r))){message('Already-run or previously handled mouldings cannot be scheduled again.',true);return;}if(rows.some(r=>r.issues.length)&&status!=='New'){message('Resolve PDF matching/quantity issues before marking these lines.',true);return;}if(rows.some(r=>review(r).length)&&!confirm('These lines changed or have another marked variant. Check any earlier moulder request before accepting the current quantity and sizing. Apply '+status+'?'))return;markRows(rows,status);selection.clear();await save(rows.length+' '+(rows.length===1?'line':'lines')+' marked '+status+'.');}
function archiveMissing(rows){const live=new Set(rows.map(r=>r.key));db.archivedRecords??={};for(const [key,r] of Object.entries(db.records)){if(!live.has(key)){db.archivedRecords[key]=structuredClone(r);db.history.push({at:now(),key,event:'Removed from MFG schedule',previous:structuredClone(r),current:null});delete db.records[key];}}}
$('apply').onclick=()=>changeSelected('To Run');$('pull').onclick=()=>changeSelected('To Pull');$('reset').onclick=()=>changeSelected('New');
function finishReport(){if(!pendingPrint)return;$('reportDoneDetail').textContent=pendingPrint.rows.length+' lines in report '+pendingPrint.id+' · Batch '+String(pendingPrint.batchId||'').slice(0,8);$('reportDoneDetail').textContent+=' · Check all grouped order pages and profile drawings, including any manual-drawing reminders.';if(!$('reportDone').open)$('reportDone').showModal();}
$('send').onclick=finishReport;$('notPrinted').onclick=()=>{$('reportDone').close();pendingPrint=null;message('Items remain in To Run. Print again when ready.');render();};
$('printedSave').onclick=async()=>{const batch=pendingPrint;if(busy()||!batch?.rows.length)return;const rows=batch.rows.map(r=>currentRows().find(x=>x.key===r.key));if(rows.some((r,i)=>!r||r.alreadyRun||priorBatchHandled(r)||record(r)?.status!=='To Run'||r.fingerprint!==batch.rows[i].fingerprint||review(r).length)){$('reportDone').close();message('The prepared report no longer matches the current To Run list. Print a fresh report before marking it sent.',true);return;}$('reportDone').close();markRows(rows,'Sent to Moulder');db.reports??=[];db.reports.push({...batch,sentAt:now()});db.pendingRunReport=null;pendingPrint=null;selection.clear();await save('Report marked sent and batch history saved. Those lines will not appear in a future decision list.',true);};
$('search').oninput=()=>{selection.clear();render();};
document.querySelectorAll('[data-tab]').forEach(button=>button.onclick=()=>{tab=button.dataset.tab;selection.clear();render();});
const profileDrawings=new Map();
async function loadDrawings(rows){
  const numbers=[...new Set(rows.map(row=>row.number))];
  await Promise.all(numbers.map(async number=>{
    if(profileDrawings.has(number)||!/^\d{4}$/.test(number))return;
    const response=await fetch('/drawings/'+number+'.json',{redirect:'error'});
    if(response.status===404){profileDrawings.set(number,[]);return;}
    if(!response.ok)throw Error('Could not load drawing '+number+'.');
    profileDrawings.set(number,await response.json());
  }));
}
function drawingsFor(number){return profileDrawings.get(number)||[];}
const STOCK_RUN_QTY=Object.freeze({'7001':50,'7076':50,'1003':50,'1020':50,'5004':30,'5005':30,'5008':30,'5010':30,'5023':30,'5007':30,'6005':30,'6022':30,'8055':50,'8064':50,'8069':50,'8070':50,'5024':50,'5001':50,'8001':40});
function stockRunPlan(rows){const grouped=new Map();for(const r of rows){if(!stock(r)||!STOCK_RUN_QTY[r.number])continue;if(!grouped.has(r.number))grouped.set(r.number,[]);grouped.get(r.number).push(r);}return Array.from(grouped,([number,items])=>{const orderedQty=items.reduce((n,r)=>n+r.qty,0),runQty=Math.max(orderedQty,STOCK_RUN_QTY[number]);return {number,orderedQty,runQty,extraQty:runQty-orderedQty,items};}).sort((a,b)=>a.number.localeCompare(b.number,undefined,{numeric:true}));}
function packetReport(rows,id,savedReport,overrides=displayState()?.mouldingOverrides){
 const meta=savedReport??pendingPrint??{},printed=meta.printedAt?batchDate.format(new Date(meta.printedAt)):'',batchId=meta.batchId?String(meta.batchId).slice(0,8):'',batchStarted=meta.batchStartedAt?batchDate.format(new Date(meta.batchStartedAt)):'';const printMeta=[meta.id?'Report '+meta.id:'',printed?'Printed '+printed:'',batchId?'Batch '+batchId+(batchStarted?' · Started '+batchStarted:''):''].filter(Boolean).join(' · ');const stockPlan=savedReport?.stockRuns??stockRunPlan(rows);const grouped=new Map();for(const r of rows){const key=String(r.number);if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(r);}
 const groups=Array.from(grouped.entries()).sort((a,b)=>a[0].localeCompare(b[0],undefined,{numeric:true}));let sheets=[];
 for(const [i,[number,items]] of groups.entries()){
  items.sort((a,b)=>a.species.localeCompare(b.species)||a.order.localeCompare(b.order)||a.key.localeCompare(b.key));
  const stockBatch=stockPlan.find(g=>g.number===number),orderedTotal=items.reduce((n,r)=>n+r.qty,0),drawings=drawingsFor(number).slice(0,1),total=orderedTotal+(stockBatch?.extraQty||0),profileNames=Array.from(new Set(items.map(r=>r.profile))).join(' / ');
  const settings=overrideLabel(number,overrides);
  const header='<div class="packet-top">KEYSTONE WOOD SPECIALTIES · MOULDER REQUEST</div>'+(printMeta?'<div class="print-meta">'+esc(printMeta)+'</div>':'')+'<div class="group-heading"><div><h1>Moulding '+esc(number)+'</h1><h2>'+esc(profileNames)+'</h2></div><div class="group-total"><strong>'+esc(total)+'</strong><span>pieces to run</span></div></div>'+(settings?'<p class="run-settings">'+esc(settings)+'</p>':'')+(stockBatch?'<div class="stock-batch-banner"><strong>HARD MAPLE STOCK RUN: '+esc(stockBatch.runQty)+' PIECES</strong>'+(items.some(r=>!stock(r))?'<div>Other species: '+esc(items.filter(r=>!stock(r)).reduce((n,r)=>n+r.qty,0))+' pieces, as listed below.</div>':'')+'</div>':'');
  const orderItems=stockBatch?items.filter(r=>!stock(r)):items;
  const body=orderItems.map(r=>{const rev=review(r),flags=[];if(r.stock&&r.long?.length)flags.push('<span class="urgent-label">OVER 8′ — VERIFY STOCK LENGTH</span>');for(const issue of rev)flags.push('<span class="urgent-label">'+esc(issue)+'</span>');return '<tr'+(r.stock?' class="stock-order"':'')+'><td class="order-number">'+esc(r.order)+'<small>'+esc(r.days<0?Math.abs(r.days)+' workdays overdue':r.days+' workdays until due')+'</small></td><td class="qty">'+esc(r.qty)+'</td><td class="sizing">'+esc(sizingLabel(r))+flags.join('')+'</td><td>'+esc(r.species)+'</td><td>'+esc(r.finish||'Not specified')+'</td></tr>';}).join('');
  sheets.push('<section class="packet-sheet group-sheet"><table class="orders-table"><colgroup><col style="width:15%"><col style="width:7%"><col style="width:30%"><col style="width:21%"><col style="width:27%"></colgroup><thead><tr><td colspan="5" class="group-banner">'+header+'</td></tr>'+(orderItems.length?'<tr class="column-labels"><th>Order</th><th>Qty</th><th>Length / width</th><th>Species</th><th>Finish</th></tr>':'')+'</thead><tbody>'+body+'</tbody></table>'+(drawings.length?'':'<div class="drawing-notice missing">PRINT DRAWING MANUALLY</div>')+'<div class="scale-check"><svg xmlns="http://www.w3.org/2000/svg" width="72pt" height="12pt" viewBox="0 0 72 12"><path d="M0 6 H72 M0 1 V11 M72 1 V11" fill="none" stroke="black" stroke-width="0.6"/></svg><br>1 inch</div></section>');
 }
 for(const number of Array.from(new Set(rows.map(r=>r.number))).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})))for(const d of drawingsFor(number).slice(0,1))for(const [j,img] of d.pages.entries()){const [w,h]=d.pageSizes[j],rotate=w>612&&h<=612;const style=rotate?'width:'+w+'pt;height:'+h+'pt;left:0;top:0;transform-origin:0 0;transform:translateX('+h+'pt) rotate(90deg)':'width:'+w+'pt;height:'+h+'pt;left:'+Math.max(0,(612-w)/2)+'pt;top:'+Math.max(0,(792-h)/2)+'pt';sheets.push('<section class="packet-sheet drawing-sheet"><img style="'+style+'" src="'+img+'" alt="'+esc(d.name)+'"></section>');}
 return '<!doctype html><html><head><meta charset="utf-8"><title>Moulder Request '+esc(id)+'</title><style>@page{size:letter portrait;margin:0}*{box-sizing:border-box}body{margin:0;color:#182a21;font:12px Arial,sans-serif}.packet-sheet{padding:.35in;break-before:page;page-break-before:always}.packet-sheet:first-child{break-before:auto;page-break-before:auto}.packet-top{font-size:10px;font-weight:bold;letter-spacing:1px;color:#496653}.print-meta{font-size:9px;color:#526459;margin-top:4px}.group-heading{display:flex;justify-content:space-between;align-items:center;gap:20px;margin:16px 0 12px}h1{font-size:27px;margin:0 0 5px}h2{font-size:15px;font-weight:normal;margin:0;line-height:1.4}.group-total{text-align:right;white-space:nowrap}.group-total strong{display:block;font-size:30px}.group-total span{font-size:10px;color:#526459}.run-settings{margin:0 0 14px;padding:7px 9px;border:1px solid #829b88;font-size:12px;font-weight:700}.group-meta{font-size:10px;margin-bottom:16px;color:#526459}.orders-table{width:100%;border-collapse:collapse;table-layout:fixed}.orders-table th,.orders-table td{padding:11px 8px;vertical-align:top;overflow-wrap:anywhere;border-bottom:1px solid #d5ded7;text-align:left;line-height:1.45}.orders-table .group-banner{padding:0;border-bottom:0}.orders-table thead{display:table-header-group}.orders-table tr{break-inside:avoid;page-break-inside:avoid}.column-labels th{font-size:10px;text-transform:uppercase;letter-spacing:.4px;background:#e9efea;border-top:2px solid #294d37;border-bottom:1px solid #829b88}.orders-table th:nth-child(1){width:15%}.orders-table th:nth-child(2){width:7%}.orders-table th:nth-child(3){width:30%}.orders-table th:nth-child(4){width:21%}.orders-table th:nth-child(5){width:27%}.order-number,.sizing{font-weight:bold}.orders-table small{display:block;font-weight:normal;font-size:9px;color:#59655d;margin-top:5px}.orders-table .qty{font-weight:bold;font-size:16px}.stock-order{background:#fff8e7}.stock-label,.urgent-label{display:block;margin-top:7px;padding:4px 5px;border:1px solid #987129;font-size:9px;line-height:1.4}.urgent-label{border-color:#a13c27;color:#8c2716}.drawing-notice{margin-top:18px;padding:12px;border:1px solid #8a9e90;background:#f0f4f0;font-size:10px;font-weight:bold;line-height:1.5;break-inside:avoid}.drawing-notice.missing{border:2px solid #9a452b;background:#fff4e8}.stock-batch-banner{padding:12px 14px;margin:0 0 16px;background:#fff5dc;border:2px solid #9b762c;font-size:11px;line-height:1.6}.stock-batch-banner strong{display:block;font-size:17px}.packet-small{font-size:10px;line-height:1.5}.packet-footer{margin-top:20px;border-top:1px solid #aaa;padding-top:10px;font-size:9px;line-height:1.5}.drawing-sheet img{display:block;position:absolute;max-width:none;max-height:none}.drawing-sheet{padding:0;position:relative;width:612pt;height:792pt;overflow:hidden}.scale-check{margin-top:15px;font-size:9px;line-height:1.5}.stock-run-table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:10px}.stock-run-table thead{display:table-header-group}.stock-run-table td,.stock-run-table th{padding:3px 5px;border-bottom:1px solid #d5ded7;vertical-align:top;text-align:left;overflow-wrap:anywhere;line-height:1.4}.stock-run-table .group-banner{padding:0;border:0}.stock-run-table th:nth-child(1){width:11%}.stock-run-table th:nth-child(2){width:10%}.stock-run-table th:nth-child(3){width:10%}.stock-run-table th:nth-child(4){width:17%}.stock-run-table th:nth-child(5){width:52%}.stock-run-table tr{break-inside:avoid;page-break-inside:avoid}.stock-run-table .stock-run-qty{font-weight:bold;font-size:16px;color:#214a31}.stock-run-table small{display:block;font-size:9px;margin-top:2px}.stock-reference{font-size:9px;margin-bottom:3px}.stock-run-table tbody tr:nth-child(odd){background:#f2f6f1}.stock-run-sheet .group-heading{margin:12px 0}.stock-run-sheet .group-meta{margin-bottom:12px}thead{-webkit-print-color-adjust:exact;print-color-adjust:exact}@media screen{body{background:#eee}.packet-sheet{max-width:8.5in;min-height:11in;background:white;margin:20px auto}.drawing-sheet{padding:0}}</style></head><body>'+sheets.join('')+'</body></html>';
}
function report(rows=visibleRows(),id=''){if(tab==='run')return packetReport(rows,id);const title={new:'New Moulding Decisions',run:'Moulder Request',pull:'Stock Pull List',sent:'Outstanding Moulder Requests — REFERENCE ONLY'}[tab];return '<!doctype html><html><head><meta charset="utf-8"><title>'+esc(title)+'</title><style>'+document.querySelector('style').textContent+'</style></head><body class="report"><h1>Keystone · '+esc(title)+'</h1><p>'+esc(id)+' · '+rows.length+' lines · '+rows.reduce((s,r)=>s+r.qty,0)+' pieces</p><p>'+esc($('snapshot').textContent)+'</p><p>Pieces without a specified length are shown as 8′. Stock warnings require checking available quantity and dimensions.</p>'+tableHTML(rows,false)+'</body></html>';}
function prepareReport(rows){
  const id='MR-'+now().replace(/[^0-9]/g,'')+'-'+crypto.randomUUID().slice(0,8);
  pendingPrint={
    id,createdAt:now(),printedAt:now(),batchId:db.activeBatch?.id??'',
    batchStartedAt:db.activeBatch?.startedAt??db.snapshot?.importedAt??'',rows:structuredClone(rows),
    mouldingOverrides:Object.fromEntries([...new Set(rows.map(row=>row.number))]
      .filter(number=>overrideLabel(number))
      .map(number=>[number,structuredClone(db.mouldingOverrides[number])])),
    stockRuns:stockRunPlan(rows).map(({number,orderedQty,runQty,extraQty})=>({number,orderedQty,runQty,extraQty}))
  };
  return report(rows,id);
}

$('print').onclick=async()=>{
  if(!db||busy()||viewingBatch||!hasLoadedSchedule())return;
  printing=true;
  pendingPrint=null;
  tab='run';
  $('search').value='';
  selection.clear();
  render();
  message('Preparing item pages and profile drawings…');
  let frame;
  try{
    const payload=await sharedRequest();
    if(payload.revision!==revision){
      acceptShared(payload);
      message('Shared tracking changed. Review the refreshed To Run list and print again.',true);
      return;
    }
    const rows=visibleRows();
    if(!rows.length){message('There are no lines to print in To Run.',true);return;}
    await loadDrawings(rows);
    const html=prepareReport(rows);
    frame=document.createElement('iframe');
    frame.style.cssText='position:fixed;width:0;height:0;border:0';
    await new Promise((resolve,reject)=>{
      frame.onload=resolve;
      frame.onerror=reject;
      frame.srcdoc=html;
      document.body.append(frame);
    });
    await Promise.all(Array.from(frame.contentDocument.images,img=>img.decode()));
    finishReport();
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(()=>frame.remove(),60000);
    message('Confirm once the report has printed.');
  }catch(error){
    frame?.remove();
    pendingPrint=null;
    if($('reportDone').open)$('reportDone').close();
    message('Could not prepare the moulder report. '+(error.message||''),true);
  }finally{printing=false;render();}
};

window.addEventListener('beforeunload',event=>{
  if(saving){event.preventDefault();event.returnValue='';}
});
window.addEventListener('focus',()=>refreshShared());
setInterval(()=>{if(document.visibilityState==='visible')refreshShared();},30000);
refreshShared();





