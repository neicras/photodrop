let photos = [];
const selected = new Set();
let lbIdx = -1;
let measuredMbps = null;
let lastSpeedAt = 0;
let galleryKey = '';

const $ = (s) => document.getElementById(s);

async function init() {
  const res = await fetch('/api/photos');
  photos = await res.json();
  galleryKey = 'pd_' + photos.length + '_' + photos.slice(0, 3).map(p => p.filename).join('|');

  restoreSession();

  $('loading').style.display = 'none';
  $('meta').textContent = `${photos.length} photos`;
  renderGrid();
  bindEvents();
  setTimeout(testSpeed, 3000);
  setInterval(testSpeed, 60000);
}

function restoreSession() {
  try {
    const stored = sessionStorage.getItem(galleryKey);
    if (!stored) return;
    const data = JSON.parse(stored);
    const validFiles = new Set(photos.map(p => p.filename));
    if (Array.isArray(data.sel)) {
      for (const f of data.sel) {
        if (validFiles.has(f) && selected.size < MAX_SEL) selected.add(f);
      }
    }
    if (data.mode && $('barMode')) {
      $('barMode').value = data.mode;
    }
  } catch {}
}

function saveSession() {
  try {
    sessionStorage.setItem(galleryKey, JSON.stringify({
      sel: Array.from(selected),
      mode: $('barMode').value,
    }));
  } catch {}
}

function renderGrid() {
  const grid = $('grid');
  grid.innerHTML = '';
  photos.forEach((p, i) => {
    const el = document.createElement('div');
    el.className = 'cell' + (selected.has(p.filename) ? ' on' : '');
    el.dataset.idx = i;
    el.innerHTML =
      `<img data-src="/api/thumb/${enc(p.filename)}" alt="" loading="lazy">` +
      `<button class="check">\u2713</button>` +
      `<div class="fname">${esc(p.filename)}${p.raw ? ' \u00b7 RAW' : ''}</div>`;
    grid.appendChild(el);
    observer.observe(el.querySelector('img'));
  });
}

const observer = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) {
      e.target.src = e.target.dataset.src;
      observer.unobserve(e.target);
    }
  }
}, { rootMargin: '300px' });

function bindEvents() {
  $('grid').addEventListener('click', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    if (e.target.closest('.check')) {
      toggle(photos[cell.dataset.idx].filename);
    } else {
      openLb(+cell.dataset.idx);
    }
  });

  $('selAllBtn').addEventListener('click', toggleAll);
  $('barMode').addEventListener('change', () => { saveSession(); syncUI(); });
  $('barDl').addEventListener('click', downloadSel);
  $('lbClose').addEventListener('click', closeLb);
  $('lbPrev').addEventListener('click', () => navLb(-1));
  $('lbNext').addEventListener('click', () => navLb(1));
  $('lbSelBtn').addEventListener('click', toggleLbSel);
  $('lbDlBtn').addEventListener('click', dlSingle);

  document.addEventListener('keydown', onKey);
}

const MAX_SEL = 20;

function toggle(filename) {
  if (!selected.has(filename) && selected.size >= MAX_SEL) {
    alert(`Max ${MAX_SEL} photos per download. Deselect some first.`);
    return;
  }
  selected.has(filename) ? selected.delete(filename) : selected.add(filename);
  saveSession();
  syncUI();
}

function toggleAll() {
  if (selected.size > 0) {
    selected.clear();
  } else {
    for (const p of photos) {
      if (selected.size >= MAX_SEL) break;
      selected.add(p.filename);
    }
    if (photos.length > MAX_SEL) alert(`Selected first ${MAX_SEL} of ${photos.length}. Download in batches.`);
  }
  saveSession();
  syncUI();
}

function syncUI() {
  document.querySelectorAll('.cell').forEach((el, i) => {
    el.classList.toggle('on', selected.has(photos[i].filename));
  });

  const n = selected.size;
  $('barCount').textContent = n;
  $('bar').classList.toggle('show', n > 0);

  const btn = $('selAllBtn');
  if (n > 0) {
    btn.textContent = `Clear (${n})`;
    btn.classList.add('btn-primary');
  } else {
    btn.textContent = 'Select All';
    btn.classList.remove('btn-primary');
  }

  const mode = $('barMode').value;
  let bytes = 0;
  for (const f of selected) {
    const p = photos.find(x => x.filename === f);
    if (!p) continue;
    if (mode === 'jpg') bytes += p.webSize || 200 * 1024;
    else bytes += p.size;
  }
  $('barSize').textContent = bytes ? ` \u00b7 ${fmtSize(bytes)}` : '';
  $('barMeta').textContent = formatMeta(bytes);

  if (lbIdx >= 0) syncLbBtn();
}

function openLb(idx) {
  lbIdx = idx;
  const p = photos[idx];
  $('lbImg').src = `/api/preview/${enc(p.filename)}`;
  $('lbName').textContent = `${p.filename} \u00b7 ${fmtSize(p.size)}`;
  $('lb').classList.add('open');
  document.body.style.overflow = 'hidden';
  syncLbBtn();
}

function closeLb() {
  $('lb').classList.remove('open');
  document.body.style.overflow = '';
  lbIdx = -1;
}

function navLb(dir) {
  const next = lbIdx + dir;
  if (next < 0 || next >= photos.length) return;
  openLb(next);
}

function toggleLbSel() {
  if (lbIdx < 0) return;
  toggle(photos[lbIdx].filename);
}

function syncLbBtn() {
  const btn = $('lbSelBtn');
  const on = selected.has(photos[lbIdx]?.filename);
  btn.textContent = on ? '\u2726 Selected' : '\u2726 Select';
  btn.classList.toggle('picked', on);
}

function dlSingle() {
  if (lbIdx < 0) return;
  window.open(`/api/original/${enc(photos[lbIdx].filename)}`, '_blank');
}

async function downloadSel() {
  if (!selected.size) return;
  const mode = $('barMode').value;
  const btn = $('barDl');
  btn.textContent = 'Preparing...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: Array.from(selected), mode }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Download failed' }));
      if (res.status === 429 && err.retryAfterSec) {
        alert(`${err.error}\nPlease retry in about ${err.retryAfterSec}s.`);
      } else {
        alert(err.error || `Download failed (${res.status})`);
      }
      return;
    }
    if (!res.headers.get('Content-Type')?.includes('zip')) {
      const err = await res.json().catch(() => ({ error: 'Unexpected response while downloading' }));
      alert(err.error || `Download failed (${res.status})`);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = res.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1] || 'photos.zip';
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('Download failed: ' + err.message);
  } finally {
    btn.textContent = '\u2193 Download';
    btn.disabled = false;
  }
}

function onKey(e) {
  if (lbIdx < 0) return;
  switch (e.key) {
    case 'ArrowLeft': navLb(-1); break;
    case 'ArrowRight': navLb(1); break;
    case 'Escape': closeLb(); break;
    case ' ':
      e.preventDefault();
      toggleLbSel();
      break;
  }
}

function formatMeta(bytes) {
  const netText = measuredMbps
    ? `Network: ${measuredMbps.toFixed(1)} Mbps`
    : 'Network: \u2014';
  if (!bytes || !measuredMbps) return `${netText} \u00b7 ETA: \u2014`;
  const seconds = (bytes * 8) / (measuredMbps * 1000 * 1000);
  const eta = seconds < 60
    ? `${Math.max(1, Math.round(seconds))}s`
    : `${Math.round(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${netText} \u00b7 ETA: ~${eta}`;
}

async function testSpeed() {
  const now = Date.now();
  if (now - lastSpeedAt < 5000) return;
  lastSpeedAt = now;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const bytes = 512 * 1024;
    const start = performance.now();
    const res = await fetch(`/api/speed-test?bytes=${bytes}&t=${Date.now()}`, { cache: 'no-store', signal: ac.signal });
    const blob = await res.blob();
    const elapsedSec = (performance.now() - start) / 1000;
    const bps = (blob.size * 8) / elapsedSec;
    measuredMbps = bps / 1_000_000;
  } catch {
    measuredMbps = null;
  } finally {
    clearTimeout(timer);
  }
  syncUI();
}

function enc(s) { return encodeURIComponent(s); }
function esc(s) { return s.replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(1) + ' GB';
}

init();
