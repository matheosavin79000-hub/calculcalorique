/* =========================================================
   Métabolyse — application logic
   Pure client-side: all data lives in localStorage.
   ========================================================= */

const STORAGE_KEY = 'metabolyse:data:v1';

const Store = {
  load(){
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    }catch(e){ return null; }
  },
  save(data){
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  },
  init(){
    return { profile:null, logs:{}, goals:{}, journal:[] };
  }
};

let DB = Store.load() || Store.init();

function persist(){ Store.save(DB); }

/* ---------- date helpers ---------- */
const todayISO = () => new Date().toISOString().slice(0,10);
const addDays = (iso, n) => {
  const d = new Date(iso); d.setDate(d.getDate()+n);
  return d.toISOString().slice(0,10);
};
const daysBetween = (a,b) => Math.round((new Date(b)-new Date(a))/86400000);
const fmt1 = n => (n===null||n===undefined||isNaN(n)) ? '—' : n.toFixed(1);
const fmt0 = n => (n===null||n===undefined||isNaN(n)) ? '—' : Math.round(n).toString();

function age(birthdate){
  const b = new Date(birthdate), n = new Date();
  let a = n.getFullYear()-b.getFullYear();
  if(n.getMonth()<b.getMonth() || (n.getMonth()===b.getMonth() && n.getDate()<b.getDate())) a--;
  return a;
}

/* =========================================================
   METABOLISM CALCULATIONS
   ========================================================= */

// Estimate body fat % from measurements (US Navy method) when unknown
function estimateBodyFat({sex, height, neck, waist, hip}){
  if(!neck || !waist || (sex==='female' && !hip)) return null;
  if(sex === 'male'){
    return 86.010*Math.log10(waist-neck) - 70.041*Math.log10(height) + 36.76;
  } else {
    return 163.205*Math.log10(waist+hip-neck) - 97.684*Math.log10(height) - 78.387;
  }
}

function mifflinStJeor({sex, weight, height, ageYears}){
  const base = 10*weight + 6.25*height - 5*ageYears;
  return sex === 'male' ? base + 5 : base - 161;
}

function katchMcArdle({weight, bodyfatPct}){
  const leanMass = weight * (1 - bodyfatPct/100);
  return 370 + 21.6*leanMass;
}

function computeTheoreticalBMR(profile, currentWeight, currentBodyfat){
  const mifflin = mifflinStJeor({
    sex: profile.sex, weight: currentWeight, height: profile.height,
    ageYears: age(profile.birthdate)
  });
  if(currentBodyfat){
    const katch = katchMcArdle({weight:currentWeight, bodyfatPct:currentBodyfat});
    // Katch-McArdle is more precise when body-fat is known; weight toward it.
    return Math.round(katch*0.65 + mifflin*0.35);
  }
  return Math.round(mifflin);
}

function getLogsSorted(){
  return Object.values(DB.logs).sort((a,b)=> a.date < b.date ? -1 : 1);
}

function getLatestField(field, before){
  const logs = getLogsSorted().filter(l => l[field]!==undefined && l[field]!==null && (!before || l.date<=before));
  return logs.length ? logs[logs.length-1][field] : null;
}

// Adaptive metabolism: compares expected weight trajectory (from declared
// calorie deficit at theoretical TDEE) against the actual observed weight
// change, and infers how much the real BMR has drifted from theory.
function computeAdaptiveBMR(profile){
  const logs = getLogsSorted().filter(l=>l.calories);
  const theoBMR = computeTheoreticalBMR(profile, getLatestField('weight') ?? profile.weight, getLatestField('bodyfat') ?? profile.bodyfat);
  if(logs.length < 10) return { theoretical: theoBMR, adapted: theoBMR, gap: 0 };

  const window = logs.slice(-21); // last 3 weeks of declared intake
  const firstWeight = getLatestField('weight', window[0].date) ?? profile.weight;
  const lastWeight = getLatestField('weight', window[window.length-1].date) ?? firstWeight;
  const observedDays = daysBetween(window[0].date, window[window.length-1].date) || 1;
  const weightDeltaKg = lastWeight - firstWeight; // negative = loss
  // 1kg of body mass change ≈ 7700 kcal (mixed fat/lean assumption)
  const impliedDailyBalance = (weightDeltaKg*7700)/observedDays;
  const avgIntake = window.reduce((s,l)=>s+l.calories,0)/window.length;
  // avgIntake - actualTDEE = impliedDailyBalance  =>  actualTDEE = avgIntake - impliedDailyBalance
  const actualTDEE = avgIntake - impliedDailyBalance;
  const activityFactor = parseFloat(profile.activity);
  const adaptedBMR = actualTDEE / activityFactor;

  // Smooth: blend theoretical and observed-derived BMR to avoid noise swings
  const blended = theoBMR*0.4 + adaptedBMR*0.6;
  const clamped = Math.max(theoBMR*0.75, Math.min(theoBMR*1.05, blended));
  return { theoretical: Math.round(theoBMR), adapted: Math.round(clamped), gap: Math.round(clamped-theoBMR) };
}

function getTDEE(profile, bmr){
  return Math.round(bmr * parseFloat(profile.activity));
}

/* =========================================================
   TREND / SMOOTHING
   ========================================================= */
function movingAverage(series, windowSize){
  // series: array of {date, value}
  return series.map((point, i) => {
    const start = Math.max(0, i-windowSize+1);
    const slice = series.slice(start, i+1).filter(p=>p.value!=null);
    if(!slice.length) return {date:point.date, value:null};
    const avg = slice.reduce((s,p)=>s+p.value,0)/slice.length;
    return {date:point.date, value:avg};
  });
}

function buildWeightSeries(){
  return getLogsSorted().filter(l=>l.weight!=null).map(l=>({date:l.date, value:l.weight}));
}
function buildSeries(field){
  return getLogsSorted().filter(l=>l[field]!=null).map(l=>({date:l.date, value:l[field]}));
}

/* =========================================================
   DAILY STATUS / DEFICIT
   ========================================================= */
function dailyBalance(log, profile, adaptedBMR){
  if(!log || log.calories==null) return null;
  const tdee = getTDEE(profile, adaptedBMR);
  return log.calories - tdee; // negative = deficit
}

function statusFromBalance(balance){
  if(balance===null) return 'unknown';
  if(balance <= -400) return 'deficit-strong';
  if(balance <= -100) return 'deficit-light';
  if(balance < 150) return 'maintenance';
  if(balance < 500) return 'surplus-light';
  return 'surplus-strong';
}
const STATUS_LABEL = {
  'deficit-strong':'Déficit optimal','deficit-light':'Déficit léger','maintenance':'Maintenance',
  'surplus-light':'Surplus léger','surplus-strong':'Surplus important','unknown':'Pas de donnée'
};

/* =========================================================
   SCORES
   ========================================================= */
function computeScores(){
  const bf = buildSeries('bodyfat'), mm = buildSeries('muscle'), w = buildWeightSeries();
  if(w.length<2) return {fle:null, mps:null};
  const weightLoss = w[0].value - w[w.length-1].value; // total kg lost
  let fle = null, mps = null;
  if(bf.length>=2){
    const bfLossPct = bf[0].value - bf[bf.length-1].value;
    // crude proxy: how much of the weight lost correlates with bodyfat % drop
    fle = Math.max(0, Math.min(100, Math.round((bfLossPct / (weightLoss||1)) * 40 + 50)));
  }
  if(mm.length>=2){
    const mmChangePct = mm[mm.length-1].value - mm[0].value;
    mps = Math.max(0, Math.min(100, Math.round(70 + mmChangePct*20)));
  }
  return {fle, mps};
}

/* =========================================================
   INSIGHTS ENGINE
   ========================================================= */
function generateInsights(profile){
  const insights = [];
  const w = buildWeightSeries();
  const logs = getLogsSorted();
  if(w.length>=2){
    const days = daysBetween(w[0].date, w[w.length-1].date) || 1;
    const totalLoss = w[0].value - w[w.length-1].value;
    const perWeek = (totalLoss/days)*7;
    if(Math.abs(perWeek) > 0.05){
      insights.push(`Tu ${perWeek>0?'perds':'prends'} en moyenne ${Math.abs(perWeek).toFixed(2)} kg par semaine.`);
    }
  }
  const withCalories = logs.filter(l=>l.calories!=null);
  if(withCalories.length>=5){
    const {adapted} = computeAdaptiveBMR(profile);
    const tdee = getTDEE(profile, adapted);
    const avgIntake = withCalories.slice(-14).reduce((s,l)=>s+l.calories,0)/Math.min(14,withCalories.slice(-14).length);
    const avgDeficit = tdee - avgIntake;
    if(Math.abs(avgDeficit) > 30){
      insights.push(`Ton ${avgDeficit>0?'déficit':'surplus'} moyen sur 14 jours est de ${Math.abs(Math.round(avgDeficit))} kcal/jour.`);
    }
    const theo = computeTheoreticalBMR(profile, getLatestField('weight')??profile.weight, getLatestField('bodyfat')??profile.bodyfat);
    if(theo>0){
      const pct = Math.round(((adapted-theo)/theo)*100);
      if(pct <= -3) insights.push(`Ton métabolisme semble avoir ralenti de ${Math.abs(pct)} %.`);
      if(pct >= 3) insights.push(`Ton métabolisme semble s'être accéléré de ${pct} %.`);
    }
  }
  const mm = buildSeries('muscle');
  if(mm.length>=2){
    const last = mm[mm.length-1], stableFrom = [...mm].reverse().find(p=>Math.abs(p.value-last.value)>0.3);
    const stableDays = stableFrom ? daysBetween(stableFrom.date, last.date) : daysBetween(mm[0].date, last.date);
    if(stableDays>=14) insights.push(`Ta masse musculaire est stable depuis ${stableDays} jours.`);
  }
  // plateau detection
  if(w.length>=14){
    const recent = w.slice(-14);
    const span = Math.max(...recent.map(p=>p.value)) - Math.min(...recent.map(p=>p.value));
    const hasDeficitDeclared = withCalories.slice(-14).length>=10;
    if(span < 0.4 && hasDeficitDeclared){
      insights.push(`Ton poids stagne depuis 14 jours malgré un déficit déclaré : possible plateau ou rétention d'eau.`);
    }
  }
  // goal projection
  if(DB.goals.targetWeight && w.length>=4){
    const days = daysBetween(w[0].date, w[w.length-1].date) || 1;
    const perDay = (w[0].value - w[w.length-1].value)/days;
    if(perDay > 0.005){
      const remaining = w[w.length-1].value - DB.goals.targetWeight;
      if(remaining > 0){
        const weeks = Math.ceil((remaining/perDay)/7);
        insights.push(`Ton rythme actuel te permettra d'atteindre ton objectif dans ${weeks} semaine${weeks>1?'s':''}.`);
      }
    }
  }
  if(!insights.length) insights.push('Continue à renseigner tes données quotidiennes pour débloquer des analyses personnalisées.');
  return insights;
}

/* =========================================================
   PREDICTIONS
   ========================================================= */
function predictWeight(daysAhead){
  const w = buildWeightSeries();
  if(w.length<4) return null;
  const days = daysBetween(w[0].date, w[w.length-1].date) || 1;
  const perDay = (w[w.length-1].value - w[0].value)/days; // signed slope
  return w[w.length-1].value + perDay*daysAhead;
}

/* =========================================================
   RENDERING
   ========================================================= */
const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

function showScreen(){
  if(!DB.profile){
    $('#onboarding').classList.remove('hidden');
    $('#app').classList.add('hidden');
  } else {
    $('#onboarding').classList.add('hidden');
    $('#app').classList.remove('hidden');
    renderAll();
  }
}

function renderAll(){
  renderDashboard();
  renderCharts();
  renderCalendar();
  renderGoals();
  renderJournal();
}

function renderDashboard(){
  const profile = DB.profile;
  const today = todayISO();
  const log = DB.logs[today];
  const {theoretical, adapted, gap} = computeAdaptiveBMR(profile);
  const tdee = getTDEE(profile, adapted);

  $('#bmr-theo').textContent = fmt0(theoretical)+' kcal';
  $('#bmr-adapt').textContent = fmt0(adapted)+' kcal';
  $('#bmr-gap').textContent = (gap>0?'+':'')+fmt0(gap)+' kcal';

  $('#cal-consumed').textContent = log?.calories!=null ? fmt0(log.calories) : '0';
  $('#cal-target').textContent = fmt0(tdee);
  const consumed = log?.calories ?? 0;
  const pct = tdee ? Math.min(100, Math.round((consumed/tdee)*100)) : 0;
  $('#cal-progress').style.width = pct+'%';
  $('#cal-remaining').textContent = fmt0(tdee-consumed)+' kcal';

  const bal = dailyBalance(log, profile, adapted);
  const status = statusFromBalance(bal);
  $('#deficit-day').textContent = bal!=null ? (bal>0?'+':'')+fmt0(bal)+' kcal' : '—';
  const chip = $('#deficit-status');
  chip.textContent = STATUS_LABEL[status];
  chip.className = 'status-chip ' + (status.startsWith('deficit')?'ok':status==='maintenance'?'warn':status.startsWith('surplus')?'bad':'');

  const logs = getLogsSorted();
  const weekLogs = logs.filter(l=>l.calories!=null && daysBetween(l.date, today)<=7);
  const monthLogs = logs.filter(l=>l.calories!=null && daysBetween(l.date, today)<=30);
  const avgBal = arr => arr.length ? arr.reduce((s,l)=>s+(l.calories-tdee),0)/arr.length : null;
  const wb = avgBal(weekLogs), mb = avgBal(monthLogs);
  $('#deficit-week').textContent = wb!=null ? (wb>0?'+':'')+fmt0(wb)+' kcal' : '—';
  $('#deficit-month').textContent = mb!=null ? (mb>0?'+':'')+fmt0(mb)+' kcal' : '—';

  const wNow = getLatestField('weight') ?? profile.weight;
  $('#weight-current').textContent = fmt1(wNow);
  const w7 = getLatestField('weight', addDays(today,-7));
  const w30 = getLatestField('weight', addDays(today,-30));
  $('#weight-week').textContent = w7!=null ? ((wNow-w7)>=0?'+':'')+fmt1(wNow-w7)+' kg' : '—';
  $('#weight-month').textContent = w30!=null ? ((wNow-w30)>=0?'+':'')+fmt1(wNow-w30)+' kg' : '—';

  $('#bf-current').textContent = fmt1(getLatestField('bodyfat') ?? profile.bodyfat)+' %';
  $('#mm-current').textContent = fmt1(getLatestField('muscle') ?? profile.muscle)+' %';

  const scores = computeScores();
  $('#score-fle').textContent = scores.fle!=null ? scores.fle+'/100' : '—';
  $('#score-mps').textContent = scores.mps!=null ? scores.mps+'/100' : '—';

  const insights = generateInsights(profile);
  $('#top-insight').textContent = insights[0];
  $('#insights-list').innerHTML = insights.map(i=>`<li>${i}</li>`).join('');
}

let charts = {};
function destroyCharts(){ Object.values(charts).forEach(c=>c?.destroy()); charts={}; }

function chartTheme(){
  const dark = document.documentElement.dataset.theme==='dark';
  return {
    grid: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
    text: dark ? '#9AA8A0' : '#5B6660',
    accent: dark ? '#3FCB91' : '#1F7A5C'
  };
}

function renderCharts(){
  destroyCharts();
  const theme = chartTheme();
  const baseOpts = {
    responsive:true, maintainAspectRatio:false,
    plugins:{legend:{labels:{color:theme.text, font:{size:11}}}},
    scales:{
      x:{ticks:{color:theme.text, maxTicksLimit:8}, grid:{color:theme.grid}},
      y:{ticks:{color:theme.text}, grid:{color:theme.grid}}
    }
  };

  const wSeries = buildWeightSeries();
  const ma7 = movingAverage(wSeries,7), ma30 = movingAverage(wSeries,30);
  charts.weight = new Chart($('#chart-weight'), {
    type:'line',
    data:{ labels: wSeries.map(p=>p.date),
      datasets:[
        {label:'Poids', data:wSeries.map(p=>p.value), borderColor:theme.text, pointRadius:2, tension:0.2},
        {label:'Moy. 7j', data:ma7.map(p=>p.value), borderColor:theme.accent, borderWidth:2, pointRadius:0, tension:0.3},
        {label:'Moy. 30j', data:ma30.map(p=>p.value), borderColor:'#E0A458', borderWidth:2, pointRadius:0, tension:0.3, borderDash:[4,3]},
      ]},
    options: baseOpts
  });

  const bfSeries = buildSeries('bodyfat'), mmSeries = buildSeries('muscle');
  charts.composition = new Chart($('#chart-composition'), {
    type:'line',
    data:{ labels: bfSeries.map(p=>p.date),
      datasets:[
        {label:'Masse grasse %', data:bfSeries.map(p=>p.value), borderColor:'#C0463B', tension:0.25, pointRadius:1},
        {label:'Masse musculaire %', data:mmSeries.map(p=>p.value), borderColor:'#1F7A5C', tension:0.25, pointRadius:1},
      ]},
    options: baseOpts
  });

  // metabolism evolution: recompute adaptive BMR at each weight log point
  const metaLabels = [], metaTheo = [], metaAdapt = [];
  const sortedLogs = getLogsSorted();
  sortedLogs.forEach(l=>{
    if(l.weight==null) return;
    metaLabels.push(l.date);
    metaTheo.push(computeTheoreticalBMR(DB.profile, l.weight, l.bodyfat ?? DB.profile.bodyfat));
  });
  const {adapted} = computeAdaptiveBMR(DB.profile);
  metaLabels.forEach(()=>metaAdapt.push(adapted));
  charts.metabolism = new Chart($('#chart-metabolism'), {
    type:'line',
    data:{ labels: metaLabels,
      datasets:[
        {label:'BMR théorique', data:metaTheo, borderColor:theme.text, tension:0.2, pointRadius:1},
        {label:'BMR adapté', data:metaAdapt, borderColor:theme.accent, tension:0.2, pointRadius:1, borderDash:[4,3]},
      ]},
    options: baseOpts
  });

  // cumulative deficit
  const tdee = getTDEE(DB.profile, adapted);
  let cum = 0;
  const defLabels=[], defData=[];
  sortedLogs.filter(l=>l.calories!=null).forEach(l=>{
    cum += (tdee - l.calories);
    defLabels.push(l.date); defData.push(cum);
  });
  charts.deficit = new Chart($('#chart-deficit'), {
    type:'line',
    data:{ labels:defLabels, datasets:[{label:'Déficit cumulé (kcal)', data:defData, borderColor:theme.accent, backgroundColor:theme.accent+'33', fill:true, tension:0.25, pointRadius:0}]},
    options: baseOpts
  });

  $('#pred-30').textContent = fmt1(predictWeight(30))+' kg';
  $('#pred-60').textContent = fmt1(predictWeight(60))+' kg';
  $('#pred-90').textContent = fmt1(predictWeight(90))+' kg';
}

/* ---------- calendar ---------- */
let calendarMonth = new Date();
function renderCalendar(){
  const profile = DB.profile;
  const {adapted} = computeAdaptiveBMR(profile);
  const tdee = getTDEE(profile, adapted);
  const year = calendarMonth.getFullYear(), month = calendarMonth.getMonth();
  $('#calendar-title').textContent = calendarMonth.toLocaleDateString('fr-FR',{month:'long', year:'numeric'});
  const first = new Date(year, month, 1);
  const startOffset = (first.getDay()+6)%7; // Monday-first
  const daysInMonth = new Date(year, month+1, 0).getDate();
  const grid = $('#calendar-grid');
  grid.innerHTML='';
  for(let i=0;i<startOffset;i++){
    const cell = document.createElement('div'); cell.className='cal-cell empty'; grid.appendChild(cell);
  }
  for(let d=1; d<=daysInMonth; d++){
    const iso = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const log = DB.logs[iso];
    const bal = log ? dailyBalance(log, profile, adapted) : null;
    const status = statusFromBalance(bal);
    const cell = document.createElement('div');
    cell.className = 'cal-cell ' + (status!=='unknown' ? status : '');
    if(iso===todayISO()) cell.classList.add('today');
    cell.textContent = d;
    cell.title = STATUS_LABEL[status];
    cell.addEventListener('click', ()=>showDayDetail(iso));
    grid.appendChild(cell);
  }
}

function showDayDetail(iso){
  const log = DB.logs[iso];
  const box = $('#day-detail');
  box.classList.remove('hidden');
  if(!log){
    box.innerHTML = `<div class="card-head"><span>${iso}</span></div><p>Aucune donnée enregistrée.</p>`;
    return;
  }
  const {adapted} = computeAdaptiveBMR(DB.profile);
  const tdee = getTDEE(DB.profile, adapted);
  const bal = dailyBalance(log, DB.profile, adapted);
  box.innerHTML = `
    <div class="card-head"><span>${iso}</span></div>
    <dl>
      <dt>Calories</dt><dd>${fmt0(log.calories)} kcal</dd>
      <dt>Dépense estimée</dt><dd>${fmt0(tdee)} kcal</dd>
      <dt>Bilan</dt><dd>${bal!=null?(bal>0?'+':'')+fmt0(bal):'—'} kcal</dd>
      <dt>Poids</dt><dd>${fmt1(log.weight)} kg</dd>
      <dt>Masse grasse</dt><dd>${fmt1(log.bodyfat)} %</dd>
      <dt>Masse musculaire</dt><dd>${fmt1(log.muscle)} %</dd>
      <dt>Notes</dt><dd>${log.notes || '—'}</dd>
    </dl>`;
}

/* ---------- goals ---------- */
function renderGoals(){
  const f = $('#goals-form');
  f.targetWeight.value = DB.goals.targetWeight ?? '';
  f.targetBodyfat.value = DB.goals.targetBodyfat ?? '';
  f.targetMuscle.value = DB.goals.targetMuscle ?? '';

  const box = $('#goals-progress');
  box.innerHTML='';
  const wNow = getLatestField('weight') ?? DB.profile.weight;
  const bfNow = getLatestField('bodyfat') ?? DB.profile.bodyfat;
  const mmNow = getLatestField('muscle') ?? DB.profile.muscle;
  const w0 = buildWeightSeries()[0]?.value ?? wNow;

  const rows = [
    {label:'Poids', now:wNow, start:w0, target:DB.goals.targetWeight, unit:'kg'},
    {label:'Masse grasse', now:bfNow, start:buildSeries('bodyfat')[0]?.value ?? bfNow, target:DB.goals.targetBodyfat, unit:'%'},
    {label:'Masse musculaire', now:mmNow, start:buildSeries('muscle')[0]?.value ?? mmNow, target:DB.goals.targetMuscle, unit:'%'},
  ];
  rows.forEach(r=>{
    if(r.target==null || r.target==='') return;
    const total = Math.abs(r.start - r.target) || 1;
    const done = Math.abs(r.start - r.now);
    const pct = Math.max(0, Math.min(100, Math.round((done/total)*100)));
    const div = document.createElement('div');
    div.className='goal-row';
    div.innerHTML = `<span class="trio-label">${r.label} — ${fmt1(r.now)} → ${fmt1(r.target)} ${r.unit}</span>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <span class="trio-label">${pct}% atteint</span>`;
    box.appendChild(div);
  });
  if(!box.children.length) box.innerHTML = '<p class="hint">Définis un objectif pour suivre ta progression.</p>';
}

/* ---------- journal ---------- */
function renderJournal(){
  const box = $('#journal-list');
  const entries = getLogsSorted().filter(l=>l.notes || l.mood || l.energy || l.sleep || l.photo).reverse();
  if(!entries.length){ box.innerHTML = '<p class="hint">Aucune entrée pour le moment.</p>'; return; }
  box.innerHTML = entries.map(l=>`
    <div class="journal-entry">
      <div class="j-date">${l.date}</div>
      ${l.notes?`<div>${l.notes}</div>`:''}
      <div class="hint">${l.mood?`Humeur: ${l.mood}/5  `:''}${l.energy?`Énergie: ${l.energy}/5  `:''}${l.sleep?`Sommeil: ${l.sleep}/5`:''}</div>
      ${l.photo?`<img src="${l.photo}" alt="progression" />`:''}
    </div>`).join('');
}

/* =========================================================
   ONBOARDING FLOW
   ========================================================= */
let obStep = 1;
function setupOnboarding(){
  $('#onboarding').classList.remove('hidden');
  const sexSelect = document.querySelector('select[name="sex"]');
  sexSelect.addEventListener('change', ()=>{
    document.querySelector('.hip-field').classList.toggle('hidden', sexSelect.value!=='female');
  });

  $('#ob-next').addEventListener('click', ()=>{
    if(obStep<3){ obStep++; updateOnboardStep(); }
  });
  $('#ob-back').addEventListener('click', ()=>{
    if(obStep>1){ obStep--; updateOnboardStep(); }
  });

  $('#profile-form').addEventListener('submit', e=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    const profile = {
      sex: fd.get('sex'), birthdate: fd.get('birthdate'),
      height: parseFloat(fd.get('height')), weight: parseFloat(fd.get('weight')),
      waist: parseFloat(fd.get('waist'))||null, neck: parseFloat(fd.get('neck'))||null,
      hip: parseFloat(fd.get('hip'))||null, activity: fd.get('activity'),
      bodyfat: parseFloat(fd.get('bodyfat'))||null, muscle: parseFloat(fd.get('muscle'))||null,
    };
    if(!profile.bodyfat){
      const est = estimateBodyFat(profile);
      if(est) profile.bodyfat = Math.round(est*10)/10;
    }
    if(!profile.muscle && profile.bodyfat){
      profile.muscle = Math.round((100 - profile.bodyfat - 15)*10)/10; // rough remainder estimate
    }
    DB.profile = profile;
    DB.logs[todayISO()] = DB.logs[todayISO()] || {date: todayISO(), weight: profile.weight, bodyfat: profile.bodyfat, muscle: profile.muscle};
    persist();
    showScreen();
  });
}
function updateOnboardStep(){
  $$('.step').forEach(s=>s.classList.toggle('active', parseInt(s.dataset.step)===obStep));
  $$('.dot').forEach((d,i)=>d.classList.toggle('active', i===obStep-1));
  $('#ob-back').classList.toggle('hidden', obStep===1);
  $('#ob-next').classList.toggle('hidden', obStep===3);
  $('#ob-submit').classList.toggle('hidden', obStep!==3);
}

/* =========================================================
   APP INTERACTIONS
   ========================================================= */
function setupTabs(){
  $$('.tab').forEach(tab=>{
    tab.addEventListener('click', ()=>{
      $$('.tab').forEach(t=>t.classList.remove('active'));
      tab.classList.add('active');
      $$('.view').forEach(v=>v.classList.remove('active'));
      $('#view-'+tab.dataset.view).classList.add('active');
    });
  });
}

function setupTheme(){
  const saved = localStorage.getItem('metabolyse:theme') || 'dark';
  document.documentElement.dataset.theme = saved;
  $('#theme-toggle').textContent = saved==='dark' ? '🌙' : '☀️';
  $('#theme-toggle').addEventListener('click', ()=>{
    const cur = document.documentElement.dataset.theme;
    const next = cur==='dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('metabolyse:theme', next);
    $('#theme-toggle').textContent = next==='dark' ? '🌙' : '☀️';
    if(DB.profile) renderCharts();
  });
}

function setupLogModal(){
  $('#open-log').addEventListener('click', ()=>{
    const today = todayISO();
    const existing = DB.logs[today] || {};
    const form = $('#log-form');
    form.date.value = today;
    form.calories.value = existing.calories ?? '';
    form.weight.value = existing.weight ?? '';
    form.bodyfat.value = existing.bodyfat ?? '';
    form.muscle.value = existing.muscle ?? '';
    form.mood.value = existing.mood ?? '';
    form.energy.value = existing.energy ?? '';
    form.sleep.value = existing.sleep ?? '';
    form.notes.value = existing.notes ?? '';
    $('#log-modal').classList.remove('hidden');
  });
  $('#close-log').addEventListener('click', ()=> $('#log-modal').classList.add('hidden'));
  $('#log-modal').addEventListener('click', e=>{ if(e.target.id==='log-modal') $('#log-modal').classList.add('hidden'); });

  $('#log-form').addEventListener('submit', e=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    const date = fd.get('date');
    const entry = DB.logs[date] || {date};
    entry.calories = parseFloat(fd.get('calories'))||null;
    entry.weight = parseFloat(fd.get('weight'))||entry.weight||null;
    entry.bodyfat = parseFloat(fd.get('bodyfat'))||entry.bodyfat||null;
    entry.muscle = parseFloat(fd.get('muscle'))||entry.muscle||null;
    entry.mood = fd.get('mood')||null;
    entry.energy = fd.get('energy')||null;
    entry.sleep = fd.get('sleep')||null;
    entry.notes = fd.get('notes')||null;

    const photoFile = fd.get('photo');
    const finish = ()=>{
      DB.logs[date] = entry;
      persist();
      $('#log-modal').classList.add('hidden');
      renderAll();
    };
    if(photoFile && photoFile.size){
      const reader = new FileReader();
      reader.onload = ()=>{ entry.photo = reader.result; finish(); };
      reader.readAsDataURL(photoFile);
    } else { finish(); }
  });
}

function setupGoals(){
  $('#goals-form').addEventListener('submit', e=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    DB.goals = {
      targetWeight: parseFloat(fd.get('targetWeight'))||null,
      targetBodyfat: parseFloat(fd.get('targetBodyfat'))||null,
      targetMuscle: parseFloat(fd.get('targetMuscle'))||null,
    };
    persist();
    renderGoals();
  });
}

function setupCalendarNav(){
  $('#cal-prev').addEventListener('click', ()=>{
    calendarMonth.setMonth(calendarMonth.getMonth()-1);
    renderCalendar();
  });
  $('#cal-next').addEventListener('click', ()=>{
    calendarMonth.setMonth(calendarMonth.getMonth()+1);
    renderCalendar();
  });
}

function setupExport(){
  $('#export-btn').addEventListener('click', ()=>{
    const w = window.open('', '_blank');
    const profile = DB.profile;
    const {theoretical, adapted, gap} = computeAdaptiveBMR(profile);
    const insights = generateInsights(profile);
    w.document.write(`
      <html><head><title>Rapport Métabolyse</title>
      <style>body{font-family:sans-serif;padding:40px;color:#15201B;}h1{color:#1F7A5C;}li{margin-bottom:8px;}</style>
      </head><body>
      <h1>Rapport Métabolyse — ${todayISO()}</h1>
      <p><b>BMR théorique:</b> ${theoretical} kcal &nbsp; <b>BMR adapté:</b> ${adapted} kcal (${gap>0?'+':''}${gap})</p>
      <h2>Analyse</h2>
      <ul>${insights.map(i=>`<li>${i}</li>`).join('')}</ul>
      </body></html>`);
    w.document.close();
    w.print();
  });
}

/* =========================================================
   BOOT
   ========================================================= */
document.addEventListener('DOMContentLoaded', ()=>{
  setupOnboarding();
  setupTabs();
  setupTheme();
  setupLogModal();
  setupGoals();
  setupCalendarNav();
  setupExport();
  showScreen();

  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
});
