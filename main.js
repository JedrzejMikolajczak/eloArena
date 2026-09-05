const STORAGE_KEY = 'elo-arena-state-v1';
const SEED_KEY = 'elo-arena-seed-imported-v2';
const STATE_API = '/.netlify/functions/state';
const ADMIN_TOKEN_KEY = 'elo-arena-admin-token';
const TABS = [
  {id:'queue', label:'Kolejka'},
  {id:'leaderboard', label:'Ranking'},
  {id:'stats', label:'Statystyki'},
  {id:'players', label:'Gracze'},
  {id:'history', label:'Historia'},
  {id:'settings', label:'Ustawienia'},
];

let state = defaultState();
let activeTab = 'queue';
let saving = false;
let resolveFlow = null; // { winner, rows, status, progress, imageObjectUrl, uploadBlob }

function adminToken(){
  return sessionStorage.getItem(ADMIN_TOKEN_KEY) || '';
}

function isAdmin(){
  return Boolean(adminToken());
}

function apiFetch(url, options = {}){
  const headers = new Headers(options.headers || {});
  const token = adminToken();
  if(token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(url, {...options, headers});
}

function defaultState(){
  return {
    _updatedAt: 0,
    players: [],
    queue: [],
    pending: null,
    matches: [],
    settings: { k: 40, startElo: 1000 }
  };
}

function uid(){
  return Date.now().toString(36) + Math.random().toString(36).slice(2,7);
}

function findPlayer(id){
  return state.players.find(p => p.id === id);
}

// ---------- storage ----------
function applyStoredState(parsed){
  state = Object.assign(defaultState(), parsed);
  if(!state.settings) state.settings = {k:40,startElo:1000};
  state.players.forEach(p => {
    if(typeof p.kills !== 'number') p.kills = 0;
    if(typeof p.deaths !== 'number') p.deaths = 0;
    if(typeof p.assists !== 'number') p.assists = 0;
    if(typeof p.statGames !== 'number') p.statGames = 0;
  });
}

function isEmptyState(value){
  return value.players.length === 0 && value.matches.length === 0;
}

async function loadSeedState(){
  if(localStorage.getItem(SEED_KEY)) return false;

  const seed = await fetch('/a.txt', { cache: 'no-store' });
  if(!seed.ok) return false;

  applyStoredState(await seed.json());
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  localStorage.setItem(SEED_KEY, '1');

  try{
    if(isAdmin()) await apiFetch(STATE_API, {
      method:'PUT',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(state)
    });
  }catch(e){
    console.error('Nie udało się wysłać danych początkowych', e);
  }
  return true;
}

async function loadState(){
  try{
    const remote = await fetch(STATE_API, { cache: 'no-store' });
    if(remote.ok){
      const payload = await remote.json();
      const local = localStorage.getItem(STORAGE_KEY);
      if(isEmptyState(payload.state) && local){
        const localState = JSON.parse(local);
        if(!isEmptyState(localState)){
          applyStoredState(localState);
          if(isAdmin()) await apiFetch(STATE_API, {
            method:'PUT',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify(state)
          });
          return;
        }
      }
      applyStoredState(payload.state);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      if(state.players.length === 0 && state.matches.length === 0){
        await loadSeedState();
      }
      return;
    }

    const local = localStorage.getItem(STORAGE_KEY);
    if(local){
      applyStoredState(JSON.parse(local));
    }else{
      await loadSeedState();
    }
  }catch(e){
    const local = localStorage.getItem(STORAGE_KEY);
    if(local){
      applyStoredState(JSON.parse(local));
    }else{
      try{
        await loadSeedState();
      }catch(seedError){
        console.error('Błąd wczytywania danych początkowych', seedError);
      }
    }
    console.error('Błąd wczytywania wspólnego stanu', e);
  }
}

let saveQueued = false;

async function saveState(){
  saveQueued = true;
  render();
  if(saving) return; // zapis już trwa — bieżąca pętla i tak wyśle najnowszy stan zaraz po nim
  saving = true;
  while(saveQueued){
    saveQueued = false;
    try{
      state._updatedAt = Math.max(Date.now(), (Number(state._updatedAt) || 0) + 1);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      const remote = await apiFetch(STATE_API, {
        method:'PUT',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify(state)
      });
      if(!remote.ok) throw new Error(`HTTP ${remote.status}`);
    }catch(e){
      console.error('Zapis wspólnego stanu nie powiódł się', e);
    }
  }
  saving = false;
  render();
}

function pollLoop(){
  setInterval(async () => {
    if(saving) return;

    try{
      const remote = await fetch(STATE_API, { cache: 'no-store' });
      if(!remote.ok) return;

      const payload = await remote.json();
      if(isEmptyState(payload.state) && !isEmptyState(state)){
        if(isAdmin()) await apiFetch(STATE_API, {
          method:'PUT',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify(state)
        });
        return;
      }
      const remoteUpdatedAt = Number(payload.state._updatedAt) || 0;
      const localUpdatedAt = Number(state._updatedAt) || 0;
      if(remoteUpdatedAt < localUpdatedAt) return;

      const nextState = JSON.stringify(payload.state);
      if(nextState !== JSON.stringify(state)){
        applyStoredState(payload.state);
        localStorage.setItem(STORAGE_KEY, nextState);
        render();
      }
    }catch(e){
      console.error('Błąd synchronizacji wspólnego stanu', e);
    }
  }, 5000);
}

window.addEventListener('storage', (e) => {
  if (e.key === STORAGE_KEY && e.newValue) {
    try {
      state = Object.assign(defaultState(), JSON.parse(e.newValue));
      render();
    } catch(err) {
      console.error('Błąd synchronizacji zakładek', err);
    }
  }
});

// ---------- screenshot OCR ----------
const SCREENSHOT_API = '/.netlify/functions/screenshot';
const KDA_RE = /(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{1,2})/;

function loadTesseract(){
  if(window.Tesseract) return Promise.resolve(window.Tesseract);
  if(window.__tesseractLoading) return window.__tesseractLoading;
  window.__tesseractLoading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
    script.onload = () => resolve(window.Tesseract);
    script.onerror = () => reject(new Error('Nie udało się wczytać biblioteki OCR'));
    document.head.appendChild(script);
  });
  return window.__tesseractLoading;
}

function resizeImageBlob(file, maxWidth){
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Konwersja obrazu nie powiodła się')), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Nie udało się wczytać obrazu')); };
    img.src = url;
  });
}

function parseOcrRows(rawText){
  const lines = (rawText || '').split('\n').map(l => l.trim()).filter(Boolean);
  const rows = [];
  lines.forEach(line => {
    const m = line.match(KDA_RE);
    if(!m) return;
    const nameGuess = line.slice(0, m.index).replace(/[^\p{L}\p{N}\s._-]/gu, '').trim();
    rows.push({
      raw: line,
      nameGuess,
      kills: Number(m[1]),
      deaths: Number(m[2]),
      assists: Number(m[3])
    });
  });
  return rows;
}

function levenshtein(a, b){
  const m = a.length, n = b.length;
  const dp = Array.from({length: m + 1}, () => new Array(n + 1).fill(0));
  for(let i = 0; i <= m; i++) dp[i][0] = i;
  for(let j = 0; j <= n; j++) dp[0][j] = j;
  for(let i = 1; i <= m; i++){
    for(let j = 1; j <= n; j++){
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j-1], dp[i-1][j], dp[i][j-1]);
    }
  }
  return dp[m][n];
}

function nameSimilarity(a, b){
  a = (a || '').toLowerCase().trim();
  b = (b || '').toLowerCase().trim();
  if(!a || !b) return 0;
  if(a === b) return 1;
  if(a.includes(b) || b.includes(a)) return 0.8;
  const at = new Set(a.split(/\s+/));
  const bt = new Set(b.split(/\s+/));
  let common = 0;
  at.forEach(t => { if(t.length > 1 && bt.has(t)) common++; });
  if(common) return Math.min(0.95, 0.5 + 0.15 * common);
  const maxLen = Math.max(a.length, b.length) || 1;
  return 1 - levenshtein(a, b) / maxLen;
}

function matchOcrToRows(ocrRows){
  if(!resolveFlow) return;
  const combos = [];
  resolveFlow.rows.forEach((row, ri) => {
    ocrRows.forEach((orow, oi) => {
      combos.push({ ri, oi, score: nameSimilarity(row.name, orow.nameGuess) });
    });
  });
  combos.sort((a, b) => b.score - a.score);
  const rowUsed = new Set(), ocrUsed = new Set();
  combos.forEach(c => {
    if(c.score < 0.3) return;
    if(rowUsed.has(c.ri) || ocrUsed.has(c.oi)) return;
    rowUsed.add(c.ri); ocrUsed.add(c.oi);
    const row = resolveFlow.rows[c.ri];
    const orow = ocrRows[c.oi];
    row.kills = orow.kills;
    row.deaths = orow.deaths;
    row.assists = orow.assists;
  });
}

async function handleScreenshotFile(file){
  if(!resolveFlow) return;
  if(resolveFlow.imageObjectUrl) URL.revokeObjectURL(resolveFlow.imageObjectUrl);
  resolveFlow.status = 'processing';
  resolveFlow.progress = null;
  render();
  try{
    const resized = await resizeImageBlob(file, 1600);
    if(!resolveFlow) return;
    resolveFlow.uploadBlob = resized;
    resolveFlow.imageObjectUrl = URL.createObjectURL(resized);
    render();

    const Tesseract = await loadTesseract();
    const worker = await Tesseract.createWorker('eng', 1, {
      logger: m => {
        if(!resolveFlow) return;
        const prevPct = resolveFlow.progress ? Math.round((resolveFlow.progress.progress || 0) * 100) : -1;
        const pct = Math.round((m.progress || 0) * 100);
        if(pct === prevPct && resolveFlow.progress && resolveFlow.progress.status === m.status) return;
        resolveFlow.progress = m;
        render();
      }
    });
    const { data } = await worker.recognize(resized);
    await worker.terminate();
    if(!resolveFlow) return;

    const ocrRows = parseOcrRows(data.text || '');
    matchOcrToRows(ocrRows);
    resolveFlow.status = ocrRows.length ? 'done' : 'empty';
  }catch(e){
    console.error('Błąd OCR', e);
    if(resolveFlow) resolveFlow.status = 'error';
  }
  render();
}

async function uploadScreenshot(key, blob){
  const res = await apiFetch(`${SCREENSHOT_API}?key=${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': blob.type || 'image/png' },
    body: blob
  });
  if(!res.ok) throw new Error(`HTTP ${res.status}`);
}

function initResolveRows(){
  const ids = [...state.pending.teamA, ...state.pending.teamB];
  return ids.map(id => ({ id, name: findPlayer(id)?.name || '?', kills: 0, deaths: 0, assists: 0 }));
}

function startResolveFlow(winner){
  resolveFlow = { winner, rows: initResolveRows(), status: 'idle', progress: null, imageObjectUrl: null, uploadBlob: null };
  render();
}

function cancelResolveFlow(){
  if(resolveFlow?.imageObjectUrl) URL.revokeObjectURL(resolveFlow.imageObjectUrl);
  resolveFlow = null;
  render();
}

async function confirmResolveWithStats(){
  if(!resolveFlow) return;
  const winner = resolveFlow.winner;
  const matchId = uid();
  let screenshotKey = null;
  if(resolveFlow.uploadBlob){
    try{
      await uploadScreenshot(matchId, resolveFlow.uploadBlob);
      screenshotKey = matchId;
    }catch(e){
      console.error('Nie udało się zapisać screena', e);
      alert('Nie udało się zapisać screena — wynik meczu i statystyki zostaną zapisane bez niego.');
    }
  }
  const statsByPlayer = {};
  resolveFlow.rows.forEach(r => {
    statsByPlayer[r.id] = { kills: r.kills, deaths: r.deaths, assists: r.assists };
  });
  if(resolveFlow.imageObjectUrl) URL.revokeObjectURL(resolveFlow.imageObjectUrl);
  resolveFlow = null;
  resolveMatch(winner, statsByPlayer, screenshotKey, matchId);
}

function confirmResolveWithoutStats(){
  if(!resolveFlow) return;
  const winner = resolveFlow.winner;
  if(resolveFlow.imageObjectUrl) URL.revokeObjectURL(resolveFlow.imageObjectUrl);
  resolveFlow = null;
  resolveMatch(winner);
}

// ---------- elo math ----------
function expected(a, b){
  return 1 / (1 + Math.pow(10, (b - a) / 100));
}

function avg(nums){
  return nums.reduce((s,n)=>s+n,0) / nums.length;
}

function popcount(mask){
  let c = 0;
  while(mask){ c += mask & 1; mask >>= 1; }
  return c;
}

function bestSplit(ids){
  const n = ids.length;
  const eloOf = id => findPlayer(id).elo;
  let best = null;
  const total = 1 << n;
  for(let mask = 1; mask < total - 1; mask++){
    if(popcount(mask) !== n/2) continue;
    const teamA = [], teamB = [];
    for(let i=0;i<n;i++){
      if(mask & (1<<i)) teamA.push(ids[i]); else teamB.push(ids[i]);
    }
    const avgA = avg(teamA.map(eloOf));
    const avgB = avg(teamB.map(eloOf));
    const diff = Math.abs(avgA - avgB);
    if(!best || diff < best.diff){
      best = { teamA, teamB, avgA, avgB, diff };
    }
  }
  return best;
}

function shufflePositions(ids){
  const history = new Map();
  state.matches.forEach(match => {
    [...match.teamA, ...match.teamB].forEach((id, position) => {
      if(!history.has(id)) history.set(id, new Set());
      history.get(id).add(position % 5);
    });
  });

  let bestOrder = [...ids];
  let bestRepeats = Infinity;
  for(let attempt = 0; attempt < 200; attempt++){
    const order = [...ids];
    for(let index = order.length - 1; index > 0; index--){
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [order[index], order[swapIndex]] = [order[swapIndex], order[index]];
    }
    const repeats = order.reduce((count, id, position) => {
      return count + (history.get(id)?.has(position) ? 1 : 0);
    }, 0);
    if(repeats < bestRepeats){
      bestOrder = order;
      bestRepeats = repeats;
    }
    if(repeats === 0) break;
  }
  return bestOrder;
}

// ---------- actions ----------
function addPlayer(name){
  if(!isAdmin()) return null;
  name = name.trim();
  if(!name) return null;
  if(state.players.some(p => p.name.toLowerCase() === name.toLowerCase())){
    alert('Gracz o tej nazwie już istnieje.');
    return null;
  }
  const p = {
    id: uid(),
    name,
    elo: state.settings.startElo,
    wins: 0,
    losses: 0,
    games: 0,
    streak: 0,
    kills: 0,
    deaths: 0,
    assists: 0,
    statGames: 0
  };
  state.players.push(p);
  return p;
}

function renamePlayer(id, name){
  if(!isAdmin()) return false;
  const player = findPlayer(id);
  if(!player) return false;

  name = name.trim();
  if(!name){
    alert('Nick nie może być pusty.');
    return false;
  }
  if(state.players.some(p => p.id !== id && p.name.toLowerCase() === name.toLowerCase())){
    alert('Gracz o tej nazwie już istnieje.');
    return false;
  }
  if(player.name === name) return false;

  player.name = name;
  saveState();
  return true;
}

function joinQueue(playerId){
  if(!isAdmin()) return;
  if(state.pending) return;
  if(state.queue.includes(playerId)) return;
  if(state.queue.length >= 10) return;
  state.queue.push(playerId);
  if(state.queue.length === 10){
    const split = bestSplit(state.queue);

    state.pending = {
      teamA: shufflePositions(split.teamA),
      teamB: shufflePositions(split.teamB),
      avgA: Math.round(split.avgA),
      avgB: Math.round(split.avgB),
      createdAt: Date.now()
    };
    state.queue = [];
  }
  saveState();
}

function leaveQueue(playerId){
  if(!isAdmin()) return;
  state.queue = state.queue.filter(id => id !== playerId);
  saveState();
}

function cancelPendingMatch(){
  if(!isAdmin() || !state.pending) return;
  if(!confirm('Anulować ten mecz i zwrócić graczy do kolejki?')) return;

  state.queue = [...state.pending.teamA, ...state.pending.teamB];
  state.pending = null;
  if(resolveFlow?.imageObjectUrl) URL.revokeObjectURL(resolveFlow.imageObjectUrl);
  resolveFlow = null;
  saveState();
}

const PERF_SCALE = 3;
const PERF_CAP = 8;

function kdaRatioOf(p){
  return ((p.kills || 0) + (p.assists || 0)) / Math.max(1, p.deaths || 0);
}

// Mały bonus/malus do ELO za KDA względem średniej drużyny (max ±PERF_CAP).
function performanceModifiers(ids, statsByPlayer){
  const ratios = ids.map(id => {
    const s = statsByPlayer[id];
    if(!s) return null;
    return { id, r: (s.kills + s.assists) / Math.max(1, s.deaths) };
  }).filter(Boolean);
  if(ratios.length === 0) return {};
  const avgR = ratios.reduce((sum, x) => sum + x.r, 0) / ratios.length;
  const mods = {};
  ratios.forEach(x => {
    const mod = Math.max(-PERF_CAP, Math.min(PERF_CAP, Math.round((x.r - avgR) * PERF_SCALE)));
    mods[x.id] = mod;
  });
  return mods;
}

function resolveMatch(winner, statsByPlayer, screenshotKey, matchId){
  if(!isAdmin()) return;
  const { teamA, teamB, avgA, avgB } = state.pending;
  const playerSnapshots = {};
  [...teamA, ...teamB].forEach(id => {
    const player = findPlayer(id);
    if(player){
      playerSnapshots[id] = {
        elo: player.elo,
        wins: player.wins,
        losses: player.losses,
        games: player.games,
        streak: player.streak,
        kills: player.kills || 0,
        deaths: player.deaths || 0,
        assists: player.assists || 0,
        statGames: player.statGames || 0
      };
    }
  });
  const k = Number(state.settings.k) || 40;
  const eA = expected(avgA, avgB);
  const eB = 1 - eA;
  let deltaA, deltaB;
  if(winner === 'A'){
    deltaA = Math.round(k * (1 - eA));
    deltaB = -deltaA;
  }else{
    deltaB = Math.round(k * (1 - eB));
    deltaA = -deltaB;
  }

  const playerDeltas = {};
  const applyTeam = (ids, baseDelta, won) => {
    const mods = statsByPlayer ? performanceModifiers(ids, statsByPlayer) : {};
    ids.forEach(id => {
      const total = baseDelta + (mods[id] || 0);
      applyResult(id, total, won, statsByPlayer ? statsByPlayer[id] : null);
      playerDeltas[id] = total;
    });
  };
  applyTeam(teamA, deltaA, winner === 'A');
  applyTeam(teamB, deltaB, winner === 'B');

  state.matches.unshift({
    id: matchId || uid(),
    date: Date.now(),
    teamA: [...teamA],
    teamB: [...teamB],
    avgA, avgB,
    winner, deltaA, deltaB,
    playerDeltas,
    playerSnapshots,
    stats: statsByPlayer || null,
    screenshotKey: screenshotKey || null
  });
  state.pending = null;
  saveState();
}

function applyResult(id, delta, won, stats){
  const p = findPlayer(id);
  if(!p) return;
  p.elo += delta;
  p.games += 1;
  if(stats){
    p.kills = (p.kills || 0) + (stats.kills || 0);
    p.deaths = (p.deaths || 0) + (stats.deaths || 0);
    p.assists = (p.assists || 0) + (stats.assists || 0);
    p.statGames = (p.statGames || 0) + 1;
  }
  if(won){
    p.wins += 1;
    p.streak = p.streak > 0 ? p.streak + 1 : 1;
  }else{
    p.losses += 1;
    p.streak = p.streak < 0 ? p.streak - 1 : -1;
  }
}

function recalculateStreak(playerId){
  let streak = 0;
  for(const match of state.matches){
    let result = null;
    if(match.teamA.includes(playerId)) result = match.winner === 'A' ? 1 : -1;
    if(match.teamB.includes(playerId)) result = match.winner === 'B' ? 1 : -1;
    if(result === null) continue;
    if(streak === 0 || Math.sign(streak) === result) streak += result;
    else break;
  }
  return streak;
}

function rollbackLastMatch(){
  if(!isAdmin() || state.matches.length === 0) return;
  if(!confirm('Cofnąć ostatni wynik meczu i przywrócić poprzednie statystyki?')) return;

  const match = state.matches.shift();
  const ids = [...new Set([...(match.teamA || []), ...(match.teamB || [])])];
  ids.forEach(id => {
    const player = findPlayer(id);
    if(!player) return;

    const snapshot = match.playerSnapshots?.[id];
    if(snapshot){
      Object.assign(player, snapshot);
      return;
    }

    const delta = match.playerDeltas?.[id]
      ?? (match.teamA.includes(id) ? match.deltaA : match.deltaB);
    player.elo -= delta || 0;
    player.games = Math.max(0, (player.games || 0) - 1);
    const won = (match.winner === 'A' && match.teamA.includes(id))
      || (match.winner === 'B' && match.teamB.includes(id));
    if(won) player.wins = Math.max(0, (player.wins || 0) - 1);
    else player.losses = Math.max(0, (player.losses || 0) - 1);
    const stats = match.stats?.[id];
    if(stats){
      player.kills = Math.max(0, (player.kills || 0) - (stats.kills || 0));
      player.deaths = Math.max(0, (player.deaths || 0) - (stats.deaths || 0));
      player.assists = Math.max(0, (player.assists || 0) - (stats.assists || 0));
      player.statGames = Math.max(0, (player.statGames || 0) - 1);
    }
  });
  ids.forEach(id => {
    const player = findPlayer(id);
    if(player) player.streak = recalculateStreak(id);
  });
  saveState();
}

function removePlayer(id){
  if(!isAdmin()) return;
  if(state.queue.includes(id)){
    alert('Ten gracz jest w kolejce — usuń go najpierw z kolejki.');
    return;
  }
  if(state.pending && (state.pending.teamA.includes(id) || state.pending.teamB.includes(id))){
    alert('Ten gracz bierze udział w trwającym meczu.');
    return;
  }
  if(!confirm('Usunąć tego gracza i jego historię z rankingu?')) return;
  state.players = state.players.filter(p => p.id !== id);
  saveState();
}

// ---------- render ----------
function render(){
  if(!state.pending && resolveFlow) resolveFlow = null;
  renderAdminControl();
  renderTabs();
  const el = document.getElementById('content');
  el.innerHTML = '';
  if(activeTab === 'queue') el.appendChild(renderQueueTab());
  else if(activeTab === 'leaderboard') el.appendChild(renderLeaderboardTab());
  else if(activeTab === 'stats') el.appendChild(renderStatsTab());
  else if(activeTab === 'players') el.appendChild(renderPlayersTab());
  else if(activeTab === 'history') el.appendChild(renderHistoryTab());
  else if(activeTab === 'settings') el.appendChild(renderSettingsTab());
}

function renderAdminControl(){
  const control = document.getElementById('admin-control');
  control.innerHTML = '';
  const form = document.createElement('form');
  form.className = 'admin-control';

  if(isAdmin()){
    const status = document.createElement('span');
    status.className = 'admin-status';
    status.textContent = 'Tryb admina';
    const logout = document.createElement('button');
    logout.type = 'button';
    logout.className = 'btn secondary';
    logout.textContent = 'Wyloguj';
    logout.onclick = () => {
      sessionStorage.removeItem(ADMIN_TOKEN_KEY);
      render();
    };
    form.append(status, logout);
  }else{
    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = 'Hasło admina';
    input.setAttribute('aria-label', 'Hasło admina');
    const login = document.createElement('button');
    login.className = 'btn secondary';
    login.textContent = 'Zaloguj';
    form.append(input, login);
    form.onsubmit = async (event) => {
      event.preventDefault();
      login.disabled = true;
      const response = await fetch(STATE_API, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({password:input.value})
      });
      if(response.ok){
        const payload = await response.json();
        sessionStorage.setItem(ADMIN_TOKEN_KEY, payload.token);
        render();
      }else{
        const error = await response.json().catch(() => ({}));
        input.value = '';
        input.placeholder = response.status === 503
          ? 'Brak konfiguracji ADMIN_PASSWORD'
          : (error.error || 'Nieprawidłowe hasło');
        login.disabled = false;
      }
    };
  }
  control.appendChild(form);
}

function renderTabs(){
  const nav = document.getElementById('tabs');
  nav.innerHTML = '';
  TABS.forEach(t => {
    const btn = document.createElement('button');
    btn.textContent = t.label + (t.id==='queue' && state.pending ? ' •' : '');
    if(t.id === activeTab) btn.classList.add('active');
    btn.onclick = () => { activeTab = t.id; render(); };
    nav.appendChild(btn);
  });
}

function panel(title){
  const d = document.createElement('div');
  d.className = 'panel';
  if(title){
    const h = document.createElement('h2');
    h.className = 'section-title';
    h.textContent = title;
    d.appendChild(h);
  }
  return d;
}

document.addEventListener('paste', (e) => {
  if(!resolveFlow || resolveFlow.status === 'processing') return;
  const items = e.clipboardData?.items;
  if(!items) return;
  for(const item of items){
    if(item.type && item.type.startsWith('image/')){
      const file = item.getAsFile();
      if(file){
        e.preventDefault();
        handleScreenshotFile(file);
      }
      break;
    }
  }
});

function renderResolveFlow(){
  const wrap = document.createElement('div');
  wrap.className = 'resolve-flow';

  const header = document.createElement('div');
  header.className = 'row space-between';
  header.style.marginBottom = '10px';
  const title = document.createElement('div');
  title.className = 'muted';
  title.textContent = `Zwycięzca: Drużyna ${resolveFlow.winner} — wklej screena z wynikami (opcjonalnie)`;
  const cancel = document.createElement('button');
  cancel.className = 'btn secondary';
  cancel.style.padding = '5px 10px';
  cancel.style.fontSize = '12px';
  cancel.textContent = 'Anuluj';
  cancel.onclick = () => cancelResolveFlow();
  header.appendChild(title);
  header.appendChild(cancel);
  wrap.appendChild(header);

  const zone = document.createElement('div');
  zone.className = 'paste-zone';
  zone.tabIndex = 0;
  zone.textContent = resolveFlow.imageObjectUrl
    ? 'Kliknij tutaj i wklej (Ctrl+V), żeby podmienić screena'
    : 'Kliknij tutaj i wklej screena (Ctrl+V) — albo wybierz plik poniżej';
  wrap.appendChild(zone);

  const fileRow = document.createElement('div');
  fileRow.className = 'row';
  fileRow.style.margin = '8px 0';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.onchange = () => { if(fileInput.files[0]) handleScreenshotFile(fileInput.files[0]); };
  fileRow.appendChild(fileInput);
  wrap.appendChild(fileRow);

  if(resolveFlow.imageObjectUrl){
    const img = document.createElement('img');
    img.src = resolveFlow.imageObjectUrl;
    img.className = 'screenshot-thumb';
    wrap.appendChild(img);
  }

  const status = document.createElement('div');
  status.className = 'muted ocr-progress';
  status.style.margin = '10px 0';
  if(resolveFlow.status === 'processing'){
    const pct = resolveFlow.progress ? Math.round((resolveFlow.progress.progress || 0) * 100) : 0;
    const label = resolveFlow.progress?.status === 'recognizing text' ? 'Rozpoznawanie tekstu' : 'Wczytywanie OCR';
    status.textContent = `${label}… ${pct}%`;
  }else if(resolveFlow.status === 'done'){
    status.textContent = 'Rozpoznano dane ze screena — sprawdź i popraw liczby poniżej przed zapisem.';
  }else if(resolveFlow.status === 'empty'){
    status.textContent = 'Nie udało się automatycznie rozpoznać wierszy K/D/A — wpisz dane ręcznie poniżej.';
  }else if(resolveFlow.status === 'error'){
    status.textContent = 'Błąd rozpoznawania — wpisz dane ręcznie poniżej.';
  }else{
    status.textContent = 'Statystyki K/D/A możesz też wpisać ręcznie, bez wklejania screena.';
  }
  wrap.appendChild(status);

  const table = document.createElement('table');
  table.className = 'resolve-table';
  table.innerHTML = `<thead><tr><th>Gracz</th><th>K</th><th>D</th><th>A</th></tr></thead>`;
  const tbody = document.createElement('tbody');
  resolveFlow.rows.forEach(row => {
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    tdName.textContent = row.name;
    tr.appendChild(tdName);
    ['kills','deaths','assists'].forEach(field => {
      const td = document.createElement('td');
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.min = '0';
      inp.value = row[field];
      inp.oninput = () => { row[field] = Number(inp.value) || 0; };
      td.appendChild(inp);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);

  const actions = document.createElement('div');
  actions.className = 'row';
  actions.style.marginTop = '14px';
  const saveWithStats = document.createElement('button');
  saveWithStats.className = 'btn';
  saveWithStats.style.flex = '1';
  saveWithStats.textContent = 'Zapisz wynik ze statystykami';
  saveWithStats.onclick = () => confirmResolveWithStats();
  const saveWithout = document.createElement('button');
  saveWithout.className = 'btn secondary';
  saveWithout.style.flex = '1';
  saveWithout.textContent = 'Zapisz bez statystyk';
  saveWithout.onclick = () => confirmResolveWithoutStats();
  actions.appendChild(saveWithStats);
  actions.appendChild(saveWithout);
  wrap.appendChild(actions);

  return wrap;
}

function renderQueueTab(){
  const frag = document.createDocumentFragment();

  if(state.pending){
    const p = panel('Mecz gotowy');
    const note = document.createElement('div');
    note.className = 'muted';
    note.style.marginBottom = '14px';
    note.textContent = 'Drużyny dobrane automatycznie tak, by różnica średniego ELO była jak najmniejsza. Pozycje wylosowane automatycznie.';
    p.appendChild(note);

    const teamsRow = document.createElement('div');
    teamsRow.className = 'row';
    teamsRow.style.alignItems = 'stretch';
    teamsRow.style.gap = '10px';

    ['A','B'].forEach(team => {
      const ids = team === 'A' ? state.pending.teamA : state.pending.teamB;
      const avgVal = team === 'A' ? state.pending.avgA : state.pending.avgB;
      const card = document.createElement('div');
      card.className = 'team-card team' + team;
      card.innerHTML = `<div class="team-header">
          <span class="team-name">Drużyna ${team}</span>
          <span class="team-avg">${avgVal}</span>
        </div>`;
      const ul = document.createElement('ul');
      ids.forEach((id, index) => {
        const pl = findPlayer(id);
        const li = document.createElement('li');
        // Dodano renderowanie numerka (index + 1) obok nicku
        li.innerHTML = `
          <span style="font-weight:bold; margin-right:8px; color:#888;">[${index + 1}]</span>
          <span class="n">${pl ? pl.name : '?'}</span>
          <span>${pl ? pl.elo : ''}</span>
        `;
        ul.appendChild(li);
      });
      card.appendChild(ul);
      teamsRow.appendChild(card);
    });
    p.appendChild(teamsRow);

    const diffNote = document.createElement('div');
    diffNote.className = 'diff-note';
    diffNote.textContent = `Różnica średniego ELO: ${Math.abs(state.pending.avgA - state.pending.avgB)}`;
    p.appendChild(diffNote);

    if(isAdmin()){
      if(!resolveFlow){
        const btnRow = document.createElement('div');
        btnRow.className = 'row';
        btnRow.style.marginTop = '14px';
        const btnA = document.createElement('button');
        btnA.className = 'btn';
        btnA.style.flex = '1';
        btnA.textContent = 'Wygrała Drużyna A';
        btnA.onclick = () => startResolveFlow('A');
        const btnB = document.createElement('button');
        btnB.className = 'btn';
        btnB.style.flex = '1';
        btnB.textContent = 'Wygrała Drużyna B';
        btnB.onclick = () => startResolveFlow('B');
        btnRow.appendChild(btnA);
        btnRow.appendChild(btnB);
        p.appendChild(btnRow);
      }else{
        p.appendChild(renderResolveFlow());
      }

      const cancelMatch = document.createElement('button');
      cancelMatch.className = 'btn danger';
      cancelMatch.style.width = '100%';
      cancelMatch.style.marginTop = '10px';
      cancelMatch.textContent = 'Anuluj mecz i wróć do kolejki';
      cancelMatch.onclick = () => cancelPendingMatch();
      p.appendChild(cancelMatch);
    }

    frag.appendChild(p);
    return frag;
  }

  const p = panel('Kolejka (' + state.queue.length + '/10)');
  const slots = document.createElement('div');
  slots.className = 'queue-slots';
  for(let i=0;i<10;i++){
    const slot = document.createElement('div');
    const id = state.queue[i];
    if(id){
      const pl = findPlayer(id);
      slot.className = 'slot filled';
      slot.innerHTML = `<span class="x" title="Usuń z kolejki">✕</span>
        <div class="name">${pl ? pl.name : '?'}</div>
        <div class="elo">${pl ? pl.elo : ''}</div>`;
      slot.querySelector('.x').onclick = () => leaveQueue(id);
    }else{
      slot.className = 'slot';
      slot.textContent = '—';
    }
    slots.appendChild(slot);
  }
  p.appendChild(slots);

  const available = state.players.filter(pl => !state.queue.includes(pl.id));
  const addRow = document.createElement('div');
  addRow.className = 'form-row';
  if(isAdmin() && available.length > 0){
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="">Wybierz gracza…</option>' +
      available.map(pl => `<option value="${pl.id}">${pl.name} (${pl.elo})</option>`).join('');
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Dołącz do kolejki';
    btn.onclick = () => { if(sel.value) joinQueue(sel.value); };
    addRow.appendChild(sel);
    addRow.appendChild(btn);
    p.appendChild(addRow);
  }

  const newRow = document.createElement('div');
  newRow.className = 'form-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Nowy gracz — imię/nick';
  const newBtn = document.createElement('button');
  newBtn.className = 'btn secondary';
  newBtn.textContent = 'Dodaj i dołącz';
  newBtn.onclick = () => {
    const pl = addPlayer(input.value);
    if(pl){ input.value=''; joinQueue(pl.id); }
  };
  input.onkeydown = (e) => { if(e.key === 'Enter') newBtn.click(); };
  newRow.appendChild(input);
  newRow.appendChild(newBtn);
  if(isAdmin()) p.appendChild(newRow);

  if(state.players.length === 0){
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.marginTop = '10px';
    empty.textContent = 'Dodaj pierwszego gracza powyżej, żeby zacząć.';
    p.appendChild(empty);
  }

  frag.appendChild(p);
  return frag;
}

function renderLeaderboardTab(){
  const frag = document.createDocumentFragment();
  const p = panel('Ranking');
  if(state.players.length === 0){
    const e = document.createElement('div');
    e.className = 'empty-state';
    e.textContent = 'Brak graczy — dodaj kogoś w zakładce Gracze.';
    p.appendChild(e);
  }else{
    const sorted = [...state.players].sort((a,b) => b.elo - a.elo);
    const table = document.createElement('table');
    table.innerHTML = `<thead><tr>
        <th>#</th><th>Gracz</th><th>ELO</th><th>W-L</th><th>Seria</th>
      </tr></thead>`;
    const tbody = document.createElement('tbody');
    sorted.forEach((pl, i) => {
      const tr = document.createElement('tr');
      const streakClass = pl.streak > 0 ? 'streak-pos' : (pl.streak < 0 ? 'streak-neg' : '');
      const streakTxt = pl.streak === 0 ? '—' : (pl.streak > 0 ? `W${pl.streak}` : `P${Math.abs(pl.streak)}`);
      tr.innerHTML = `<td class="rank">${i+1}</td>
        <td>${pl.name}</td>
        <td class="elo-val">${pl.elo}</td>
        <td>${pl.wins}-${pl.losses}</td>
        <td class="${streakClass}">${streakTxt}</td>`;
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    p.appendChild(table);
  }
  frag.appendChild(p);
  return frag;
}

function renderStatsTab(){
  const frag = document.createDocumentFragment();

  const p1 = panel('Statystyki graczy');
  const withStats = state.players.filter(pl => (pl.statGames || 0) > 0);
  if(withStats.length === 0){
    const e = document.createElement('div');
    e.className = 'empty-state';
    e.textContent = 'Brak jeszcze statystyk K/D/A — dodaj je przy rozstrzyganiu meczu (wklejając screena lub wpisując ręcznie).';
    p1.appendChild(e);
  }else{
    const sorted = [...withStats].sort((a,b) => kdaRatioOf(b) - kdaRatioOf(a));
    const table = document.createElement('table');
    table.innerHTML = `<thead><tr><th>Gracz</th><th>KDA</th><th>K</th><th>D</th><th>A</th><th>Mecze ze staty.</th></tr></thead>`;
    const tbody = document.createElement('tbody');
    sorted.forEach(pl => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${pl.name}</td>
        <td class="elo-val">${kdaRatioOf(pl).toFixed(2)}</td>
        <td>${pl.kills || 0}</td><td>${pl.deaths || 0}</td><td>${pl.assists || 0}</td>
        <td>${pl.statGames || 0}</td>`;
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    p1.appendChild(table);
  }
  frag.appendChild(p1);

  const p2 = panel('Screeny z meczów');
  const withData = state.matches.filter(m => m.stats || m.screenshotKey);
  if(withData.length === 0){
    const e = document.createElement('div');
    e.className = 'empty-state';
    e.textContent = 'Żaden mecz nie ma jeszcze zapisanego screena ani statystyk.';
    p2.appendChild(e);
  }else{
    withData.forEach(m => {
      const row = document.createElement('div');
      row.className = 'match-row';
      const date = new Date(m.date);
      const dateStr = date.toLocaleDateString('pl-PL') + ' ' + date.toLocaleTimeString('pl-PL', {hour:'2-digit',minute:'2-digit'});
      const top = document.createElement('div');
      top.className = 'match-top';
      top.innerHTML = `<span>${dateStr}</span><span>Zwycięstwo: Drużyna ${m.winner}</span>`;
      row.appendChild(top);

      if(m.screenshotKey){
        const link = document.createElement('a');
        link.href = `${SCREENSHOT_API}?key=${encodeURIComponent(m.screenshotKey)}`;
        link.target = '_blank';
        link.rel = 'noopener';
        const img = document.createElement('img');
        img.src = link.href;
        img.className = 'screenshot-thumb';
        img.loading = 'lazy';
        link.appendChild(img);
        row.appendChild(link);
      }

      if(m.stats){
        const table = document.createElement('table');
        table.style.marginTop = '8px';
        table.innerHTML = `<thead><tr><th>Gracz</th><th>K</th><th>D</th><th>A</th><th>Δ ELO</th></tr></thead>`;
        const tbody = document.createElement('tbody');
        [...m.teamA, ...m.teamB].forEach(id => {
          const pl = findPlayer(id);
          const s = m.stats[id];
          const delta = m.playerDeltas ? m.playerDeltas[id] : null;
          const deltaTxt = delta == null ? '—' : (delta >= 0 ? `+${delta}` : delta);
          const deltaClass = delta == null ? '' : (delta >= 0 ? 'delta-pos' : 'delta-neg');
          const tr = document.createElement('tr');
          tr.innerHTML = `<td>${pl ? pl.name : '(usunięty)'}</td>
            <td>${s ? s.kills : '—'}</td><td>${s ? s.deaths : '—'}</td><td>${s ? s.assists : '—'}</td>
            <td class="${deltaClass}">${deltaTxt}</td>`;
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        row.appendChild(table);
      }

      p2.appendChild(row);
    });
  }
  frag.appendChild(p2);

  return frag;
}

function renderPlayersTab(){
  const frag = document.createDocumentFragment();
  const p = panel('Gracze');

  const newRow = document.createElement('div');
  newRow.className = 'form-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Imię / nick nowego gracza';
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.textContent = 'Dodaj gracza';
  btn.onclick = () => { if(addPlayer(input.value)){ input.value=''; saveState(); } };
  input.onkeydown = (e) => { if(e.key === 'Enter') btn.click(); };
  newRow.appendChild(input);
  newRow.appendChild(btn);
  if(isAdmin()) p.appendChild(newRow);

  const note = document.createElement('div');
  note.className = 'muted';
  note.style.marginBottom = '12px';
  note.textContent = `Nowi gracze startują z ${state.settings.startElo} ELO. Można dodawać ich w dowolnym momencie.`;
  p.appendChild(note);

  if(state.players.length === 0){
    const e = document.createElement('div');
    e.className = 'empty-state';
    e.textContent = 'Nikogo tu jeszcze nie ma.';
    p.appendChild(e);
  }else{
    const table = document.createElement('table');
    table.innerHTML = `<thead><tr><th>Gracz</th><th>ELO</th><th>Mecze</th><th></th></tr></thead>`;
    const tbody = document.createElement('tbody');
    [...state.players].sort((a,b)=>a.name.localeCompare(b.name)).forEach(pl => {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      const tdElo = document.createElement('td');
      const tdGames = document.createElement('td');
      const tdBtn = document.createElement('td');
      td.textContent = pl.name;
      tdElo.className = 'elo-val';
      tdElo.textContent = pl.elo;
      tdGames.textContent = pl.games;
      const rm = document.createElement('button');
      rm.className = 'btn danger';
      rm.style.padding = '5px 10px';
      rm.style.fontSize = '12px';
      rm.textContent = 'Usuń';
      rm.onclick = () => removePlayer(pl.id);
      const rename = document.createElement('button');
      rename.className = 'btn secondary';
      rename.style.padding = '5px 10px';
      rename.style.fontSize = '12px';
      rename.style.marginRight = '6px';
      rename.textContent = 'Zmień nick';
      rename.onclick = () => {
        const nextName = prompt('Nowy nick gracza:', pl.name);
        if(nextName !== null) renamePlayer(pl.id, nextName);
      };
      if(isAdmin()){
        tdBtn.appendChild(rename);
        tdBtn.appendChild(rm);
      }
      tr.appendChild(td); tr.appendChild(tdElo); tr.appendChild(tdGames); tr.appendChild(tdBtn);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    p.appendChild(table);
  }

  frag.appendChild(p);
  return frag;
}

function renderHistoryTab(){
  const frag = document.createDocumentFragment();
  const p = panel('Historia meczów');
  if(state.matches.length === 0){
    const e = document.createElement('div');
    e.className = 'empty-state';
    e.textContent = 'Żaden mecz nie został jeszcze rozegrany.';
    p.appendChild(e);
  }else{
    state.matches.forEach((m, index) => {
      const row = document.createElement('div');
      row.className = 'match-row';
      const date = new Date(m.date);
      const dateStr = date.toLocaleDateString('pl-PL') + ' ' + date.toLocaleTimeString('pl-PL', {hour:'2-digit',minute:'2-digit'});
      row.innerHTML = `<div class="match-top"><span>${dateStr}</span><span>Różnica ELO: ${Math.abs(m.avgA-m.avgB)}</span></div>`;
      if(index === 0 && isAdmin()){
        const rollback = document.createElement('button');
        rollback.className = 'btn danger';
        rollback.style.margin = '8px 0';
        rollback.textContent = 'Cofnij ostatni wynik';
        rollback.onclick = () => rollbackLastMatch();
        row.appendChild(rollback);
      }
      const teamsDiv = document.createElement('div');
      teamsDiv.className = 'match-teams';
      ['A','B'].forEach(team => {
        const ids = team === 'A' ? m.teamA : m.teamB;
        const delta = team === 'A' ? m.deltaA : m.deltaB;
        const won = m.winner === team;
        const div = document.createElement('div');
        div.className = 'match-team' + (won ? ' winner' : '');
        const names = ids.map(id => { const pl = findPlayer(id); return pl ? pl.name : '(usunięty)'; }).join(', ');
        const deltaClass = delta >= 0 ? 'delta-pos' : 'delta-neg';
        const deltaTxt = delta >= 0 ? `+${delta}` : delta;
        div.innerHTML = `<div class="team-lbl">Drużyna ${team}${won ? ' 🏆' : ''} <span class="${deltaClass}">${deltaTxt}</span></div>
          <div class="muted">${names}</div>`;
        teamsDiv.appendChild(div);
      });
      row.appendChild(teamsDiv);
      p.appendChild(row);
    });
  }
  frag.appendChild(p);
  return frag;
}

function renderSettingsTab(){
  const frag = document.createDocumentFragment();
  const p = panel('Ustawienia');

  if(!isAdmin()){
    const note = document.createElement('div');
    note.className = 'empty-state';
    note.textContent = 'Ustawienia są dostępne tylko dla administratora.';
    p.appendChild(note);
    frag.appendChild(p);
    return frag;
  }

  const kRow = document.createElement('div');
  kRow.style.marginBottom = '18px';
  const kLabel = document.createElement('div');
  kLabel.className = 'muted';
  kLabel.style.marginBottom = '6px';
  kLabel.textContent = 'Współczynnik K — steruje tym, ile ELO zmienia się po meczu. Przy wyrównanych drużynach zmiana wynosi w przybliżeniu K/2 punktów; im większa przepaść w ELO, tym więcej zyskuje słabsza drużyna za wygraną i tym mniej traci za przegraną.';
  const kInputRow = document.createElement('div');
  kInputRow.className = 'row';
  const kInput = document.createElement('input');
  kInput.type = 'number';
  kInput.min = '5'; kInput.max = '100';
  kInput.value = state.settings.k;
  const kSave = document.createElement('button');
  kSave.className = 'btn secondary';
  kSave.textContent = 'Zapisz';
  kSave.onclick = () => {
    const v = Number(kInput.value);
    if(v >= 5 && v <= 100){ state.settings.k = v; saveState(); }
  };
  kInputRow.appendChild(kInput);
  kInputRow.appendChild(kSave);
  kRow.appendChild(kLabel);
  kRow.appendChild(kInputRow);
  p.appendChild(kRow);

  const startRow = document.createElement('div');
  startRow.style.marginBottom = '18px';
  const startLabel = document.createElement('div');
  startLabel.className = 'muted';
  startLabel.style.marginBottom = '6px';
  startLabel.textContent = 'Startowe ELO dla nowych graczy.';
  const startInputRow = document.createElement('div');
  startInputRow.className = 'row';
  const startInput = document.createElement('input');
  startInput.type = 'number';
  startInput.value = state.settings.startElo;
  const startSave = document.createElement('button');
  startSave.className = 'btn secondary';
  startSave.textContent = 'Zapisz';
  startSave.onclick = () => {
    const v = Number(startInput.value);
    if(v > 0){ state.settings.startElo = v; saveState(); }
  };
  startInputRow.appendChild(startInput);
  startInputRow.appendChild(startSave);
  startRow.appendChild(startLabel);
  startRow.appendChild(startInputRow);
  p.appendChild(startRow);

  const infoNote = document.createElement('div');
  infoNote.className = 'muted';
  infoNote.style.marginBottom = '18px';
  infoNote.innerHTML = 'Wzór: oczekiwany wynik drużyny A = 1 / (1 + 10^((ELO_B − ELO_A)/400)). Zmiana ELO = K × (wynik − oczekiwany wynik), ten sam wynik dostaje każdy zawodnik danej drużyny.';
  p.appendChild(infoNote);

  const dangerNote = document.createElement('div');
  dangerNote.className = 'muted';
  dangerNote.style.marginBottom = '8px';
  dangerNote.textContent = 'Dane są zapisywane w pamięci przeglądarki (localStorage). Wyczyszczenie danych przeglądarki usunie te informacje.';
  p.appendChild(dangerNote);

  const resetBtn = document.createElement('button');
  resetBtn.className = 'btn danger';
  resetBtn.textContent = 'Zresetuj wszystkie dane';
  resetBtn.onclick = () => {
    if(confirm('To usunie wszystkich graczy, kolejkę i historię meczów z tej przeglądarki. Kontynuować?')){
      state = defaultState();
      saveState();
    }
  };
  p.appendChild(resetBtn);

  frag.appendChild(p);
  return frag;
}

// ---------- init ----------
(async function init(){
  await loadState();
  render();
  pollLoop();
})();