const CLIENT_ID = '33adcc7d9d21461692e6abbe93dc51ef';
const REDIRECT_URI = 'https://qfair.github.io';

const FRIEND_NAMES = {
  '92swuvcb8qlcp67ghfse2wyhp':    'AdrianRPNK',
  'xea9kyo32dr4zuxny05sur22m':    'GooberBone',
  '31kwvg2lk7q6cda4uh2riaf3hrp4': 'Hess',
  'mqf7xginrz6bg63s5fl4pvqxn':    'The Rat Creature',
  '31c7w4225cc4vzo7dlrrypgwg6ju': 'Lương Gia Bửu',
  '9ucq3a7eyyaim0qnb1qe2xyo9':    'melkbot',
  '5mivh7dtynq4owuyq9evq66ji':    'Supernova',
  '66qcq61mvxvpfqzb32au640vq':    'Andrew Austrager',
};

// ---- State ----
let accessToken = null;
let allTracks = [];
let memberMap = {};
let activeMembers = new Set();
let queueTracks = [];
let manualMode = false;
let manualMembers = {};
let manualIdCounter = 0;
let loadingPlaylist = false;
let equalMode = 'songs'; // 'songs' | 'time'

// ---- Helpers ----
function $(id) { return document.getElementById(id); }

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setStatus(id, msg, cls) {
  const el = $(id);
  if (!el) return;
  el.textContent = msg;
  el.className = 'status' + (cls ? ' ' + cls : '');
  if (cls === 'err' && msg) window.triggerCircleFlash?.('rgba(220, 50, 50, 0.85)', 2, 1000);
}

function showStep(id) {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
  window.scrollTo(0, 0);
}

function goBack(step) {
  if (step === 'step-playlists') loadingPlaylist = false;
  showStep(step);
}

function backFromQueue() {
  setStatus('status3', '');
  showStep('step-members');
}

function toggleEqualMode(on) {
  const row = $('equal-mode-row');
  if (row) row.classList.toggle('collapsed', !on);
}

function setEqualMode(mode) {
  equalMode = mode;
  $('mode-songs').classList.toggle('active', mode === 'songs');
  $('mode-time').classList.toggle('active', mode === 'time');
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

(function () {
  const tip = document.createElement('div');
  tip.className = 'tooltip-popup';
  tip.setAttribute('aria-hidden', 'true');
  document.body.appendChild(tip);
  let current = null;

  function show(icon) {
    tip.textContent = icon.dataset.tooltip || '';
    const r = icon.getBoundingClientRect();
    const w = 200;
    const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8));
    tip.style.left = left + 'px';
    tip.style.top = (r.bottom + 8) + 'px';
    tip.classList.add('open');
    icon.classList.add('open');
    current = icon;
  }

  function hide() {
    tip.classList.remove('open');
    if (current) { current.classList.remove('open'); current = null; }
  }

  // Hover for desktop
  document.addEventListener('mouseover', e => {
    const icon = e.target.closest('.info-icon');
    if (icon) show(icon);
  });
  document.addEventListener('mouseout', e => {
    if (e.target.closest('.info-icon')) hide();
  });

  // Touch: preventDefault stops the synthetic click that causes double-fire
  document.addEventListener('touchstart', e => {
    const icon = e.target.closest('.info-icon');
    if (icon) {
      e.preventDefault();
      current === icon ? hide() : show(icon);
    } else {
      hide();
    }
  }, { passive: false });

  // Click for non-touch
  document.addEventListener('click', e => {
    const icon = e.target.closest('.info-icon');
    if (icon) {
      e.preventDefault();
      current === icon ? hide() : show(icon);
    } else {
      hide();
    }
  });
})();

// ---- OAuth PKCE ----
async function sha256(plain) {
  const enc = new TextEncoder().encode(plain);
  return crypto.subtle.digest('SHA-256', enc);
}

function base64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

async function doAuth() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(await sha256(verifier));
  localStorage.setItem('gqf_verifier', verifier);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: 'playlist-read-private playlist-read-collaborative user-modify-playback-state user-read-playback-state',
  });

  window.location = 'https://accounts.spotify.com/authorize?' + params;
}

async function exchangeCode(code) {
  const verifier = localStorage.getItem('gqf_verifier');
  localStorage.removeItem('gqf_verifier');

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error + ': ' + (data.error_description || ''));
  if (!data.access_token) throw new Error('No token: ' + JSON.stringify(data));

  localStorage.setItem('gqf_expires_at', Date.now() + (data.expires_in ?? 3600) * 1000);
  if (data.refresh_token) localStorage.setItem('gqf_refresh_token', data.refresh_token);

  return data.access_token;
}

async function refreshAccessToken() {
  const refreshToken = localStorage.getItem('gqf_refresh_token');
  if (!refreshToken) throw new Error('No refresh token - please reconnect.');

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error + ': ' + (data.error_description || ''));
  if (!data.access_token) throw new Error('Refresh failed: ' + JSON.stringify(data));

  accessToken = data.access_token;
  localStorage.setItem('gqf_expires_at', Date.now() + (data.expires_in ?? 3600) * 1000);
  if (data.refresh_token) localStorage.setItem('gqf_refresh_token', data.refresh_token);
}

async function ensureFreshToken() {
  const expiresAt = parseInt(localStorage.getItem('gqf_expires_at') || '0');
  if (accessToken && Date.now() < expiresAt - 5 * 60 * 1000) return;
  await refreshAccessToken();
}

// ---- Spotify API ----
async function spotifyGet(url) {
  await ensureFreshToken();
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '1');
      const wait = Math.min(retryAfter * Math.pow(2, attempt), 30) * 1000;
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) {
      let errMsg = res.status + ' ' + res.statusText;
      try { const e = await res.json(); errMsg = e?.error?.message || JSON.stringify(e); } catch (_) {}
      if (res.status === 403) errMsg += ' - you may not have access to this playlist';
      throw new Error(errMsg);
    }
    return res.json();
  }
  throw new Error('Rate limited by Spotify. Try again in a few minutes.');
}

// ---- Load playlists ----
async function loadPlaylists() {
  showStep('step-playlists');
  $('playlist-grid').innerHTML = '<div class="loading">Loading your playlists…</div>';

  try {
    const playlists = [];
    let url = 'https://api.spotify.com/v1/me/playlists?limit=50';
    while (url) {
      const data = await spotifyGet(url);
      playlists.push(...(data.items || []));
      url = data.next;
    }

    if (playlists.length === 0) {
      $('playlist-grid').innerHTML = '<div class="loading">No playlists found.</div>';
      return;
    }

    $('playlist-grid').innerHTML = '';
    playlists.forEach(pl => {
      if (!pl) return;
      const imgUrl = pl.images?.[0]?.url;
      const imgHtml = imgUrl
        ? `<img src="${esc(imgUrl)}" alt="" loading="lazy">`
        : '<div class="pl-img-placeholder"></div>';

      const card = document.createElement('div');
      card.className = 'playlist-card';
      card.innerHTML = `
        ${imgHtml}
        <div class="playlist-card-info">
          <div class="playlist-card-name">${esc(pl.name || 'Untitled')}</div>
          <div class="playlist-card-count">${pl.tracks?.total ?? pl.items?.total ?? 0} tracks</div>
        </div>`;
      card.onclick = () => selectPlaylist(pl);
      $('playlist-grid').appendChild(card);
    });
  } catch (e) {
    $('playlist-grid').innerHTML = `<div class="loading" style="color:#e05">✗ ${esc(e.message)}</div>`;
    triggerCircleFlash('rgba(220, 50, 50, 0.85)', 2, 1000);
  }
}

// ---- Select playlist ----
async function selectPlaylist(pl) {
  if (loadingPlaylist) return;
  loadingPlaylist = true;
  const imgUrl = pl.images?.[0]?.url;
  const selImgHtml = imgUrl
    ? `<img src="${esc(imgUrl)}" alt="">`
    : '<div class="pl-img-placeholder"></div>';

  $('selected-playlist-display').innerHTML = `
    <div class="selected-playlist">
      ${selImgHtml}
      <div>
        <div class="selected-playlist-name">${esc(pl.name || 'Untitled')}</div>
        <div class="selected-playlist-count">${pl.tracks?.total ?? pl.items?.total ?? 0} tracks</div>
      </div>
    </div>`;

  showStep('step-members');
  $('members-grid').innerHTML = '<div class="loading">Loading tracks & members…</div>';
  setStatus('status2', '');
  activeMembers = new Set();
  allTracks = [];
  memberMap = {};
  manualMode = false;
  manualMembers = {};

  try {
    const cacheKey = 'gqf_cache_' + pl.id;
    const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');

    let skipped = 0;

    if (cached && cached.snapshotId === pl.snapshot_id && cached.tracks?.length > 0) {
      allTracks = cached.tracks;
      allTracks.forEach(t => { if (t.addedBy && t.addedBy !== 'unknown') memberMap[t.addedBy] = t.addedBy; });
    } else {
      let url = `https://api.spotify.com/v1/playlists/${pl.id}/items?limit=100`;
      while (url) {
        const data = await spotifyGet(url);
        for (const item of (data.items || [])) {
          const track = item?.track ?? item?.item;
          if (!track || track.type !== 'track' || track.is_local || !track.uri) {
            skipped++;
            continue;
          }
          const userId = item.added_by?.id || 'unknown';
          allTracks.push({
            name: track.name || 'Unknown',
            artist: track.artists?.map(a => a.name).join(', ') || '',
            addedBy: userId,
            uri: track.uri,
            duration_ms: track.duration_ms || 0,
          });
          if (userId && userId !== 'unknown') memberMap[userId] = userId;
        }
        url = data.next;
      }
      if (pl.snapshot_id && allTracks.length > 0) {
        try { localStorage.setItem(cacheKey, JSON.stringify({ snapshotId: pl.snapshot_id, tracks: allTracks })); }
        catch (_) {}
      }
    }

    if (allTracks.length === 0) {
      const reason = skipped > 0
        ? `All ${skipped} tracks are local files or no longer available on Spotify and can't be queued via the API.`
        : 'No tracks found in this playlist.';
      $('members-grid').innerHTML = `<div class="loading" style="color:#e05">✗ ${esc(reason)}</div>`;
      setStatus('status2', '✗ 0 tracks loaded', 'err');
      return;
    }

    // Spotify's /users/{id} endpoint is restricted to 403 for other users.
    // Only /me works reliably, so identify the current user and shorten other IDs.
    const savedNames = JSON.parse(localStorage.getItem('gqf_names') || '{}');
    Object.keys(memberMap).forEach(uid => {
      memberMap[uid] = savedNames[uid] || FRIEND_NAMES[uid] || (uid.length > 15 ? uid.slice(0, 10) + '...' : uid);
    });

    renderMembersGrid();
    const fromCache = cached && cached.snapshotId === pl.snapshot_id;
    const skipNote = skipped > 0 ? ` (${skipped} local/unavailable skipped)` : '';
    setStatus('status2', `✓ ${allTracks.length} tracks loaded${fromCache ? ' (cached)' : ''}${skipNote}`, 'ok');
  } catch (e) {
    $('members-grid').innerHTML = `<div class="loading" style="color:#e05">✗ ${esc(e.message)}</div>`;
    triggerCircleFlash('rgba(220, 50, 50, 0.85)', 2, 1000);
    const el = $('members-grid');
    const rect = el.getBoundingClientRect();
    if (rect.bottom > window.innerHeight) {
      window.scrollTo({ top: window.scrollY + rect.bottom - window.innerHeight + 16, behavior: 'smooth' });
    }
  } finally {
    loadingPlaylist = false;
  }
}

// ---- Members ----
function renderMembersGrid() {
  const grid = $('members-grid');
  grid.innerHTML = '';
  grid.classList.remove('manual');
  const users = Object.keys(memberMap);
  if (users.length === 0) {
    showManualMode();
    return;
  }
  const trackCounts = {};
  allTracks.forEach(t => { trackCounts[t.addedBy] = (trackCounts[t.addedBy] || 0) + 1; });
  users.forEach(uid => {
    const trackCount = trackCounts[uid] || 0;
    const chip = document.createElement('div');
    chip.className = 'member-chip';

    const nameEl = document.createElement('span');
    nameEl.className = 'member-label';
    nameEl.textContent = memberMap[uid];

    const editBtn = document.createElement('button');
    editBtn.className = 'rename-btn';
    editBtn.textContent = '✎';
    editBtn.title = 'Rename';
    editBtn.addEventListener('click', e => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.type = 'text';
      input.value = memberMap[uid];
      input.className = 'rename-input';
      nameEl.replaceWith(input);
      editBtn.style.display = 'none';
      input.focus();
      input.select();
      const save = () => {
        const val = input.value.trim() || memberMap[uid];
        memberMap[uid] = val;
        const savedNames = JSON.parse(localStorage.getItem('gqf_names') || '{}');
        savedNames[uid] = val;
        localStorage.setItem('gqf_names', JSON.stringify(savedNames));
        nameEl.textContent = val;
        input.replaceWith(nameEl);
        editBtn.style.display = '';
      };
      input.addEventListener('blur', save);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
    });

    const nameRow = document.createElement('div');
    nameRow.style.cssText = 'display:flex;align-items:center;gap:2px;min-width:0';
    nameEl.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1';
    nameRow.appendChild(nameEl);
    nameRow.appendChild(editBtn);

    const nameWrap = document.createElement('div');
    nameWrap.className = 'member-name';
    nameWrap.appendChild(nameRow);
    nameWrap.insertAdjacentHTML('beforeend', `<span style="font-size:0.6rem;color:var(--muted)">${trackCount} songs</span>`);

    chip.appendChild(document.createElement('div')).className = 'dot';
    chip.appendChild(nameWrap);
    chip.addEventListener('click', () => {
      if (activeMembers.has(uid)) activeMembers.delete(uid);
      else activeMembers.add(uid);
      chip.classList.toggle('active', activeMembers.has(uid));
    });
    grid.appendChild(chip);
  });
}

function showManualMode() {
  manualMode = true;
  const grid = $('members-grid');
  grid.classList.add('manual');
  grid.innerHTML = `
    <div class="manual-notice">
      Spotify didn't return contributor info for this playlist.
      Add everyone in your group below. Tracks will be split evenly among them.
    </div>
    <div class="manual-add-row">
      <input type="text" id="manualNameInput" placeholder="Name (e.g. Alice)" />
      <button class="btn manual-add-btn" onclick="addManualMember()">+</button>
    </div>
    <div class="members-grid" id="manual-chips"></div>`;
  $('manualNameInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') addManualMember();
  });
}

function addManualMember() {
  const input = $('manualNameInput');
  const name = input.value.trim();
  if (!name) return;
  const id = 'manual_' + (++manualIdCounter);
  manualMembers[id] = name;
  memberMap[id] = name;
  input.value = '';
  input.focus();
  renderManualChips();
}

function removeManualMember(id) {
  delete manualMembers[id];
  delete memberMap[id];
  activeMembers.delete(id);
  renderManualChips();
}

function renderManualChips() {
  const container = $('manual-chips');
  if (!container) return;
  container.innerHTML = '';
  Object.entries(manualMembers).forEach(([id, name]) => {
    const chip = document.createElement('div');
    chip.className = 'member-chip' + (activeMembers.has(id) ? ' active' : '');
    chip.innerHTML = `
      <div class="dot"></div>
      <div class="member-name">${esc(name)}</div>
      <button class="chip-remove" onclick="event.stopPropagation();removeManualMember('${id}')">✕</button>`;
    chip.onclick = () => {
      if (activeMembers.has(id)) activeMembers.delete(id);
      else activeMembers.add(id);
      chip.classList.toggle('active', activeMembers.has(id));
    };
    container.appendChild(chip);
  });
}

function selectAll(val) {
  const keys = manualMode ? Object.keys(manualMembers) : Object.keys(memberMap);
  keys.forEach(id => val ? activeMembers.add(id) : activeMembers.delete(id));
  document.querySelectorAll('.member-chip').forEach(c => c.classList.toggle('active', val));
}

// ---- Build queue ----
function buildQueue() {
  if (manualMode && Object.keys(manualMembers).length === 0) { setStatus('status2', '✗ Add at least one person first.', 'err'); return; }
  if (activeMembers.size === 0) { setStatus('status2', '✗ Select at least one person.', 'err'); return; }

  let filtered;
  if (manualMode) {
    const allIds = [...activeMembers];
    filtered = shuffle(allTracks).map((t, i) => ({ ...t, addedBy: allIds[i % allIds.length] }));
  } else {
    filtered = allTracks.filter(t => activeMembers.has(t.addedBy));
  }

  if (filtered.length === 0) { setStatus('status2', '✗ No tracks found for selected members.', 'err'); return; }

  const equalSelection = $('equalSelection')?.checked;

  // Build per-person pools
  const members = [...activeMembers];
  const pools = {};
  members.forEach(uid => {
    pools[uid] = shuffle(filtered.filter(t => t.addedBy === uid));
  });

  if (equalSelection && equalMode === 'time') {
    // Greedy time scheduler: always pick from whoever has the least
    // accumulated listening time. Falls back to ~3.5 min if duration missing.
    const totalMs = {};
    members.forEach(uid => { totalMs[uid] = 0; });
    queueTracks = [];
    while (members.some(uid => pools[uid].length > 0)) {
      const eligible = shuffle(members.filter(uid => pools[uid].length > 0));
      eligible.sort((a, b) => totalMs[a] - totalMs[b]);
      const uid = eligible[0];
      const track = pools[uid].pop();
      queueTracks.push(track);
      totalMs[uid] += track.duration_ms || 210000;
    }
  } else if (equalSelection) {
    // Round-robin by song count: each person gets one slot per round.
    queueTracks = [];
    while (members.some(uid => pools[uid].length > 0)) {
      const round = shuffle(members.filter(uid => pools[uid].length > 0));
      for (const uid of round) queueTracks.push(pools[uid].pop());
    }
  } else {
    queueTracks = shuffle(members.flatMap(uid => pools[uid]));
  }
  $('q-count').textContent = queueTracks.length;
  $('q-members').textContent = activeMembers.size;

  const rerolling = $('step-queue').classList.contains('active');
  const rerollBtn = $('reroll-btn');

  if (rerolling) {
    if (rerollBtn) {
      rerollBtn.classList.remove('spinning');
      void rerollBtn.offsetWidth; // restart animation if clicked again quickly
      rerollBtn.classList.add('spinning');
    }
    const list = $('track-list');
    list.classList.add('rolling-out');
    setTimeout(() => {
      list.classList.remove('rolling-out');
      renderTrackList();
    }, 190);
  } else {
    renderTrackList();
    $('track-list').scrollTop = 0;
    showStep('step-queue');
  }
}

function renderTrackList() {
  const list = $('track-list');
  list.innerHTML = '';
  list.scrollTop = 0;
  const frag = document.createDocumentFragment();
  queueTracks.forEach((t, i) => {
    const div = document.createElement('div');
    div.className = 'track-item rolling-in';
    div.style.animationDelay = Math.min(i, 12) * 36 + 'ms';
    div.innerHTML = `
      <div class="track-num">${i + 1}</div>
      <div class="track-info">
        <div class="track-name">${esc(t.name)}</div>
        <div class="track-artist">${esc(t.artist)}</div>
      </div>
      <div class="track-added">${esc(memberMap[t.addedBy] || t.addedBy)}</div>`;
    frag.appendChild(div);
  });
  list.appendChild(frag);
}

// ---- Burst animation ----
function triggerBurst(sourceEl, color) {
  const rect = sourceEl.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9998;';
  document.body.appendChild(canvas);
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const ctx = canvas.getContext('2d');

  const particles = Array.from({ length: 22 }, () => {
    const angle = Math.random() * Math.PI * 2;
    const speed = 2.5 + Math.random() * 7;
    return {
      x: cx, y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 1.5,
      r: 5 + Math.random() * 16,
      life: 1,
      decay: 0.018 + Math.random() * 0.012,
    };
  });

  ctx.fillStyle = color;
  function tick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let any = false;
    particles.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.18;
      p.vx *= 0.97;
      p.life -= p.decay;
      if (p.life <= 0) return;
      any = true;
      ctx.globalAlpha = p.life;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
    if (any) requestAnimationFrame(tick);
    else canvas.remove();
  }
  requestAnimationFrame(tick);
}

// ---- Playback ----
async function startPlayback() {
  if (!queueTracks.length) return;
  const playBtn = $('play-btn');
  if (playBtn) { playBtn.disabled = true; $('play-btn-text').textContent = 'Starting…'; }
  setStatus('status3', 'Finding active device…');
  try {
    const devData = await spotifyGet('https://api.spotify.com/v1/me/player/devices');
    const device = devData.devices?.find(d => d.is_active) || devData.devices?.[0];
    if (!device) {
      setStatus('status3', '✗ No active device found. Open Spotify and play something first, then try again.', 'err');
      return;
    }

    setStatus('status3', 'Sending queue to Spotify…');
    // Disable shuffle and repeat-track so Spotify plays exactly what's shown.
    // Must happen before play (shuffle scrambles the uris), but sent one at a time and
    // confirmed first: mobile clients pause if these race the play command.
    for (const endpoint of ['shuffle?state=false', 'repeat?state=off']) {
      await fetch('https://api.spotify.com/v1/me/player/' + endpoint + '&device_id=' + device.id, {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + accessToken },
      }).catch(() => {});
    }
    for (let i = 0; i < 10; i++) {
      const stateRes = await fetch('https://api.spotify.com/v1/me/player', {
        headers: { Authorization: 'Bearer ' + accessToken },
      }).catch(() => null);
      // 204 = no playback state to check; anything unreadable, just proceed
      if (!stateRes || stateRes.status !== 200) break;
      const state = await stateRes.json().catch(() => null);
      if (!state || state.shuffle_state === false) break;
      await new Promise(r => setTimeout(r, 300));
    }

    const MAX_URIS = 500;
    const uris = queueTracks.slice(0, MAX_URIS).map(t => t.uri);
    const res = await fetch('https://api.spotify.com/v1/me/player/play?device_id=' + device.id, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris }),
    });
    if (!res.ok) {
      let errMsg = res.status + ' ' + res.statusText;
      try { const e = await res.json(); errMsg = e?.error?.message || errMsg; } catch (_) {}
      if (res.status === 403) errMsg += ' - your Spotify account may not have playback permission';
      throw new Error(errMsg);
    }

    setStatus('status3', `✓ ${queueTracks.length} tracks sent to "${device.name}"`, 'ok');
    triggerCircleFlash('rgba(50, 220, 100, 0.90)', -2, 1000);
  } catch (e) {
    setStatus('status3', '✗ ' + e.message, 'err');
  } finally {
    if (playBtn) { playBtn.disabled = false; $('play-btn-text').textContent = 'Play on Spotify Now'; }
    const st = $('status3');
    const rect = st.getBoundingClientRect();
    if (rect.bottom > window.innerHeight) {
      window.scrollTo({ top: window.scrollY + rect.bottom - window.innerHeight + 16, behavior: 'smooth' });
    }
  }
}

// ---- Init: handle OAuth callback ----
(async () => {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const error = params.get('error');

  showStep('step-setup');

  if (error) {
    setStatus('status', 'Spotify login failed: ' + error, 'err');
    setTimeout(() => triggerCircleFlash('rgba(220, 50, 50, 0.85)', 2, 1000), 0);
    window.history.replaceState({}, '', window.location.pathname);
    return;
  }

  if (code) {
    window.history.replaceState({}, '', window.location.pathname);
    setStatus('status', 'Connecting to Spotify...');
    try {
      accessToken = await exchangeCode(code);
      await loadPlaylists();
    } catch (e) {
      setStatus('status', '✗ ' + e.message, 'err');
    }
    return;
  }

  if (localStorage.getItem('gqf_refresh_token')) {
    try {
      await refreshAccessToken();
      await loadPlaylists();
    } catch (e) {
      localStorage.removeItem('gqf_refresh_token');
      localStorage.removeItem('gqf_expires_at');
    }
  }
})();

// Floating triangles inside .btn-full buttons
function initButtonBubbles(btn) {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;border-radius:inherit;';
  btn.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  let W = 0, H = 0, ready = false;

  const shapes = Array.from({ length: 9 }, () => ({
    x: 0, y: 0,
    size: 5 + Math.random() * 11,
    vy: -(0.4 + Math.random() * 0.55),
    vx: (Math.random() - 0.5) * 0.28,
    rot: Math.random() * Math.PI * 2,
    rotSpeed: (Math.random() - 0.5) * 0.018,
  }));

  function syncSize() {
    const bw = btn.clientWidth, bh = btn.clientHeight;
    if (bw === 0 || bh === 0) return;
    canvas.width = bw; canvas.height = bh;
    W = bw; H = bh;
    if (!ready) {
      shapes.forEach(s => { s.x = Math.random() * W; s.y = H + Math.random() * H; });
      ready = true;
    }
  }

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(syncSize).observe(btn);
  } else {
    syncSize();
    window.addEventListener('resize', syncSize);
  }

  function tick() {
    if (!ready) { requestAnimationFrame(tick); return; }
    if (document.hidden) { requestAnimationFrame(tick); return; }

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,0.17)';

    shapes.forEach(s => {
      s.vx += (Math.random() - 0.5) * 0.03;
      s.vx *= 0.97;
      s.x += s.vx;
      s.y += s.vy;
      s.rot += s.rotSpeed;

      if (s.y + s.size < 0) { s.x = Math.random() * W; s.y = H + s.size; }
      if (s.x + s.size < 0) s.x = W + s.size;
      if (s.x - s.size > W) s.x = -s.size;

      const cos = Math.cos(s.rot), sin = Math.sin(s.rot), sz = s.size;
      ctx.beginPath();
      ctx.moveTo(s.x + sz * sin,                           s.y - sz * cos);
      ctx.lineTo(s.x + sz * (0.866 * cos - 0.5 * sin),   s.y + sz * (0.866 * sin + 0.5 * cos));
      ctx.lineTo(s.x + sz * (-0.866 * cos - 0.5 * sin),  s.y + sz * (-0.866 * sin + 0.5 * cos));
      ctx.closePath();
      ctx.fill();
    });
    requestAnimationFrame(tick);
  }
  tick();
}

// Floating circle background
(function () {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;transform:translateZ(0);';
  document.body.insertBefore(canvas, document.body.firstChild);
  const ctx = canvas.getContext('2d');

  let W = 0, H = 0;
  let mouseX = -9999, mouseY = -9999;
  let flash = { active: false, color: null, vyBoost: 0, until: 0, fadeTo: 0 };

  window.triggerCircleFlash = function (color, vyBoost, duration, fadeDuration = 600) {
    const now = performance.now();
    flash = { active: true, color, vyBoost, until: now + duration, fadeTo: now + duration + fadeDuration };
  };

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);
  document.addEventListener('mousemove', e => { mouseX = e.clientX; mouseY = e.clientY; });
  document.addEventListener('touchmove', e => {
    mouseX = e.touches[0].clientX; mouseY = e.touches[0].clientY;
  }, { passive: true });

  const COLORS = [
    'rgba(29, 185, 84,  0.45)', // main green
    'rgba(20, 130, 58,  0.50)', // dark green
    'rgba(80, 210, 120, 0.35)', // light green
    'rgba(12,  90, 40,  0.55)', // deep green
    'rgba(140, 140, 140, 0.22)', // mid gray
    'rgba(80,  80,  80,  0.28)', // dark gray
    'rgba(190, 190, 190, 0.18)', // light gray
    'rgba(255, 255, 255, 0.14)', // white
    'rgba(220, 220, 220, 0.16)', // off-white
  ];

  function spawn(atRandom) {
    const r = 14 + Math.random() * 52;
    return {
      x: Math.random() * (W || window.innerWidth),
      y: atRandom ? Math.random() * (H || window.innerHeight) : (H || window.innerHeight) + r + Math.random() * 80,
      r,
      floatVy: -(0.22 + Math.random() * 0.38),
      vx: 0,
      vy: 0,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
    };
  }

  const circles = Array.from({ length: 20 }, () => spawn(true));
  const REPEL_R = 130, REPEL_R2 = REPEL_R * REPEL_R, REPEL_STR = 1.8;

  function resetCircle(c) {
    c.x = Math.random() * W;
    c.y = H + c.r + Math.random() * 80;
    c.floatVy = -(0.22 + Math.random() * 0.38);
    c.vx = 0;
    c.vy = 0;
    c.color = COLORS[Math.floor(Math.random() * COLORS.length)];
  }

  // Pre-allocated per-color buckets - reused every frame to avoid GC pressure
  const colorGroups = new Map(COLORS.map(c => [c, []]));

  function tick() {
    if (document.hidden) return;

    const now = performance.now();
    let flashBlend = 0;
    if (flash.active) {
      if (now < flash.until) {
        flashBlend = 1;
      } else if (now < flash.fadeTo) {
        flashBlend = 1 - (now - flash.until) / (flash.fadeTo - flash.until);
      } else {
        flash.active = false;
      }
    }

    circles.forEach(c => {
      // Mouse / touch push - sqrt only when inside repel radius
      const dx = c.x - mouseX, dy = c.y - mouseY;
      const dist2 = dx * dx + dy * dy;
      if (dist2 < REPEL_R2 && dist2 > 0) {
        const dist = Math.sqrt(dist2);
        const t = (REPEL_R - dist) / REPEL_R;
        c.vx += (dx / dist) * t * t * REPEL_STR;
        c.vy += (dy / dist) * t * t * REPEL_STR;
      }

      c.vx += (Math.random() - 0.5) * 0.025;
      c.vx *= 0.97;
      c.vy = c.vy * 0.97 + c.floatVy * 0.03;

      c.x += c.vx;
      c.y += c.vy + c.floatVy + (flashBlend === 1 ? flash.vyBoost : 0);

      if (c.x + c.r < 0) c.x = W + c.r;
      if (c.x - c.r > W) c.x = -c.r;

      if (c.y + c.r < 0 || c.y - c.r > H) resetCircle(c);
    });

    ctx.clearRect(0, 0, W, H);

    // Batch draws by color: one fill() per color group instead of per circle.
    // moveTo lifts the pen before each arc so no lines connect between circles.
    colorGroups.forEach(arr => { arr.length = 0; });
    circles.forEach(c => colorGroups.get(c.color).push(c));
    colorGroups.forEach((group, color) => {
      if (!group.length) return;
      ctx.beginPath();
      group.forEach(c => { ctx.moveTo(c.x + c.r, c.y); ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2); });
      ctx.fillStyle = color;
      ctx.fill();
    });

    // Flash overlay: single batched path instead of one fill() per circle
    if (flashBlend > 0) {
      ctx.globalAlpha = flashBlend;
      ctx.fillStyle = flash.color;
      ctx.beginPath();
      circles.forEach(c => { ctx.moveTo(c.x + c.r, c.y); ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2); });
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    requestAnimationFrame(tick);
  }

  // Pause when tab is hidden, resume when it comes back
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) requestAnimationFrame(tick);
  });

  tick();
})();

document.querySelectorAll('.btn-full').forEach(initButtonBubbles);

// Cursor-reactive background parallax
(function () {
  const waveBg = document.querySelector('.wave-bg');
  let ticking = false;
  document.addEventListener('mousemove', e => {
    document.documentElement.style.setProperty('--cx', e.clientX + 'px');
    document.documentElement.style.setProperty('--cy', e.clientY + 'px');
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      if (waveBg) {
        const nx = e.clientX / window.innerWidth - 0.5;
        const ny = e.clientY / window.innerHeight - 0.5;
        waveBg.style.transform = `translate(${nx * 28}px, ${ny * 16}px)`;
      }
      ticking = false;
    });
  });
})();
