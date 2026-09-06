const STORAGE_KEY = 'elo-arena-state-v1';
const SEED_KEY = 'elo-arena-seed-imported-v2';
const STATE_API = '/state';
const ADMIN_TOKEN_KEY = 'elo-arena-admin-token';
const TABS = [
  {id:'queue', label:'Kolejka'},
  {id:'leaderboard', label:'Ranking'},
  {id:'players', label:'Gracze'},
  {id:'history', label:'Historia'},
  {id:'settings', label:'Ustawienia'},
];

let state = defaultState();
let activeTab = 'queue';
let saving = false;
let resolveFlow = null; // { winner, mvpId, aceId }

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

function startResolveFlow(winner){
  resolveFlow = { winner, mvpId: '', aceId: '' };
  render();
}

function cancelResolveFlow(){
  resolveFlow = null;
  render();
}

function confirmResolve(){
  if(!resolveFlow) return;
  const winner = resolveFlow.winner;
  if(resolveFlow.mvpId && resolveFlow.mvpId === resolveFlow.aceId) return;
  const mvpId = resolveFlow.mvpId;
  const aceId = resolveFlow.aceId;
  resolveFlow = null;
  resolveMatch(winner, mvpId, aceId);
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
  const previousMatch = state.matches[0];
  const previousPositions = new Map();
  if(previousMatch){
    previousMatch.teamA.forEach((id, position) => previousPositions.set(id, position));
    previousMatch.teamB.forEach((id, position) => previousPositions.set(id, position));
  }

  let bestOrder = [...ids];
  let bestRepeats = Infinity;
  const visit = (remaining, order) => {
    if(remaining.length === 0){
      const repeats = order.reduce((count, id, position) => {
        return count + (previousPositions.get(id) === position ? 1 : 0);
      }, 0);
      if(repeats < bestRepeats || (repeats === bestRepeats && Math.random() < 0.5)){
        bestOrder = [...order];
        bestRepeats = repeats;
      }
      return;
    }
    remaining.forEach((id, index) => {
      visit(
        [...remaining.slice(0, index), ...remaining.slice(index + 1)],
        [...order, id]
      );
    });
  };
  visit([...ids], []);
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

const MVP_BONUS = 5;

function resolveMatch(winner, mvpId, aceId){
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
    ids.forEach(id => {
      const bonus = id === mvpId ? MVP_BONUS : (id === aceId ? MVP_BONUS : 0);
      const total = baseDelta + bonus;
      applyResult(id, total, won);
      playerDeltas[id] = total;
    });
  };
  applyTeam(teamA, deltaA, winner === 'A');
  applyTeam(teamB, deltaB, winner === 'B');

  state.matches.unshift({
    id: uid(),
    date: Date.now(),
    teamA: [...teamA],
    teamB: [...teamB],
    avgA, avgB,
    winner, deltaA, deltaB,
    playerDeltas,
    playerSnapshots,
    mvpId,
    aceId
  });
  state.pending = null;
  saveState();
}

function applyResult(id, delta, won){
  const p = findPlayer(id);
  if(!p) return;
  p.elo += delta;
  p.games += 1;
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
  else if(activeTab === 'players') el.appendChild(renderPlayersTab());
  else if(activeTab === 'history') el.appendChild(renderHistoryTab());
  else if(activeTab === 'settings') el.appendChild(renderSettingsTab());
}

function renderAdminControl(){
  const control = document.getElementById('admin-control');
  const mode = isAdmin() ? 'admin' : 'login';
  if(control.dataset.mode === mode) return;
  control.dataset.mode = mode;
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
        input.focus();
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

function renderResolveFlow(){
  const wrap = document.createElement('div');
  wrap.className = 'resolve-flow';

  const header = document.createElement('div');
  header.className = 'row space-between';
  header.style.marginBottom = '10px';
  const title = document.createElement('div');
  title.className = 'muted';
  title.textContent = `Zwycięzca: Drużyna ${resolveFlow.winner}`;
  const cancel = document.createElement('button');
  cancel.className = 'btn secondary';
  cancel.style.padding = '5px 10px';
  cancel.style.fontSize = '12px';
  cancel.textContent = 'Anuluj';
  cancel.onclick = () => cancelResolveFlow();
  header.appendChild(title);
  header.appendChild(cancel);
  wrap.appendChild(header);

  const winnerIds = state.pending[resolveFlow.winner === 'A' ? 'teamA' : 'teamB'];
  const loserIds = state.pending[resolveFlow.winner === 'A' ? 'teamB' : 'teamA'];
  const selectPlayer = (label, ids, property) => {
    const field = document.createElement('label');
    field.className = 'form-row';
    field.textContent = label;
    const select = document.createElement('select');
    select.innerHTML = '<option value="">Wybierz gracza…</option>' + ids.map(id => {
      const player = findPlayer(id);
      return `<option value="${id}">${player ? player.name : '?'}</option>`;
    }).join('');
    select.value = resolveFlow[property];
    select.onchange = () => {
      resolveFlow[property] = select.value;
      render();
    };
    field.appendChild(select);
    wrap.appendChild(field);
  };
  selectPlayer('MVP wygranej drużyny (+5 ELO)', winnerIds, 'mvpId');
  selectPlayer('ACE przegranej drużyny (traci 5 ELO mniej)', loserIds, 'aceId');

  const actions = document.createElement('div');
  actions.className = 'row';
  actions.style.marginTop = '14px';
  const save = document.createElement('button');
  save.className = 'btn';
  save.style.flex = '1';
  save.textContent = 'Zapisz wynik';
  save.onclick = () => confirmResolve();
  actions.appendChild(save);
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
      if(m.mvpId || m.aceId){
        const awards = document.createElement('div');
        awards.className = 'muted';
        awards.style.marginTop = '8px';
        const mvpName = m.mvpId ? findPlayer(m.mvpId)?.name || '(usunięty)' : '—';
        const aceName = m.aceId ? findPlayer(m.aceId)?.name || '(usunięty)' : '—';
        awards.textContent = `MVP: ${mvpName} (+${MVP_BONUS}) · ACE: ${aceName} (+${MVP_BONUS} względem standardowej straty)`;
        row.appendChild(awards);
      }
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