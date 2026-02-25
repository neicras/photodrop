let photos = [];
const selected = new Set();
let lbIdx = -1;

const $ = (s) => document.getElementById(s);

async function init() {
  const res = await fetch('/api/photos');
  photos = await res.json();
  $('loading').style.display = 'none';
  $('meta').textContent = `${photos.length} photos`;
  renderGrid();
  bindEvents();
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
      `<button class="check">✓</button>` +
      `<div class="fname">${esc(p.filename)}${p.raw ? ' · RAW' : ''}</div>`;
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
  $('barClear').addEventListener('click', clearSel);
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
  syncUI();
}

function clearSel() {
  selected.clear();
  syncUI();
}

function syncUI() {
  document.querySelectorAll('.cell').forEach((el, i) => {
    el.classList.toggle('on', selected.has(photos[i].filename));
  });

  const n = selected.size;
  $('barCount').textContent = n;
  $('bar').classList.toggle('show', n > 0);
  $('selAllBtn').textContent = n === photos.length ? 'Deselect All' : 'Select All';

  let bytes = 0;
  for (const f of selected) {
    const p = photos.find(x => x.filename === f);
    if (p) bytes += p.size;
  }
  $('barSize').textContent = bytes ? ` · ${fmtSize(bytes)}` : '';

  if (lbIdx >= 0) syncLbBtn();
}

function openLb(idx) {
  lbIdx = idx;
  const p = photos[idx];
  $('lbImg').src = `/api/preview/${enc(p.filename)}`;
  $('lbName').textContent = `${p.filename} · ${fmtSize(p.size)}`;
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
  btn.textContent = on ? '✦ Selected' : '✦ Select';
  btn.classList.toggle('picked', on);
}

function dlSingle() {
  if (lbIdx < 0) return;
  window.open(`/api/original/${enc(photos[lbIdx].filename)}`, '_blank');
}

async function downloadSel() {
  if (!selected.size) return;
  const btn = $('barDl');
  btn.textContent = 'Preparing...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: Array.from(selected) }),
    });
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
    btn.textContent = '↓ Download Selected';
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

function enc(s) { return encodeURIComponent(s); }
function esc(s) { return s.replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(1) + ' GB';
}

init();
