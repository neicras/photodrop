#!/usr/bin/env node
const express = require('express');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { ExifTool } = require('exiftool-vendored');
const archiver = require('archiver');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const PHOTO_DIR = path.resolve(args[0] || '.');
const PORT = parseInt(process.env.PORT || '3000', 10);
const CACHE_DIR = path.join(PHOTO_DIR, '.photodrop');

const dateArg = args.find(a => a.startsWith('--date='))?.split('=')[1]
  || (args.includes('--date') && args[args.indexOf('--date') + 1])
  || process.env.PHOTODROP_DATE
  || args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
const FILTER_DATE = dateArg ? (() => {
  const [y, m, d] = dateArg.split('-').map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0);
  const end = new Date(y, m - 1, d + 1, 0, 0, 0);
  return { start: start.getTime(), end: end.getTime() };
})() : null;

const RAW_EXTS = new Set([
  '.cr2', '.cr3', '.arw', '.nef', '.raf',
  '.dng', '.rw2', '.orf', '.pef', '.srw',
]);
const IMG_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.tiff', '.tif',
  '.webp', '.heic', '.heif', ...RAW_EXTS,
]);

const THUMB_W = 400;
const PREVIEW_W = 1600;

const exiftool = new ExifTool({ taskTimeoutMillis: 30000 });

if (!fs.existsSync(PHOTO_DIR)) {
  console.error(`Error: "${PHOTO_DIR}" does not exist.`);
  process.exit(1);
}
fs.mkdirSync(CACHE_DIR, { recursive: true });

function scanPhotos() {
  const out = [];
  function walk(dir, prefix = '') {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith('.')) continue;
      const full = path.join(dir, f);
      const rel = prefix ? `${prefix}/${f}` : f;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full, rel);
      else if (IMG_EXTS.has(path.extname(f).toLowerCase())) {
        if (FILTER_DATE) {
          const mtime = stat.mtimeMs;
          if (mtime >= FILTER_DATE.start && mtime < FILTER_DATE.end) out.push(rel);
        } else out.push(rel);
      }
    }
  }
  walk(PHOTO_DIR);
  return out.sort();
}

function isRaw(f) {
  return RAW_EXTS.has(path.extname(f).toLowerCase());
}

function cached(relPath, suffix) {
  const base = relPath.replace(/\//g, '_').replace(/\.[^.]+$/, '');
  return path.join(CACHE_DIR, `${base}_${suffix}.jpg`);
}

async function extractRawBuffer(srcPath) {
  const tmp = path.join(CACHE_DIR, `_raw_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
  try {
    await exiftool.extractPreview(srcPath, tmp);
    const buf = await fs.promises.readFile(tmp);
    await fs.promises.unlink(tmp).catch(() => {});
    return buf;
  } catch {
    try {
      await exiftool.extractJpgFromRaw(srcPath, tmp);
      const buf = await fs.promises.readFile(tmp);
      await fs.promises.unlink(tmp).catch(() => {});
      return buf;
    } catch {
      return null;
    }
  }
}

async function ensureCached(srcPath, relPath, width, suffix) {
  const dest = cached(relPath, suffix);
  if (fs.existsSync(dest)) return dest;

  let buf;
  if (isRaw(relPath)) {
    buf = await extractRawBuffer(srcPath);
    if (!buf) return null;
  } else {
    buf = await fs.promises.readFile(srcPath);
  }

  await sharp(buf)
    .resize(width, null, { withoutEnlargement: true })
    .rotate()
    .jpeg({ quality: 82 })
    .toFile(dest);

  return dest;
}

async function generateAll(photos) {
  let done = 0;
  const total = photos.length;
  const failed = [];
  process.stdout.write(`Generating thumbnails... 0/${total}`);

  for (const f of photos) {
    try {
      const src = path.join(PHOTO_DIR, f);
      await ensureCached(src, f, THUMB_W, 'thumb');
      await ensureCached(src, f, PREVIEW_W, 'preview');
    } catch (err) {
      failed.push(f);
      process.stderr.write(`\n  skip: ${f} (${err.message})`);
    }
    done++;
    process.stdout.write(`\rGenerating thumbnails... ${done}/${total}`);
  }
  process.stdout.write('\n');
  if (failed.length) console.log(`  ${failed.length} file(s) skipped`);
}

function startTunnel() {
  const configPath = path.join(__dirname, 'cloudflared.yml');
  const useCustom = fs.existsSync(configPath);
  const args = useCustom
    ? ['tunnel', '--config', configPath, 'run']
    : ['tunnel', '--url', `http://localhost:${PORT}`];

  if (useCustom) console.log(`\n✦  Share: https://photodrop.ericsan.io\n`);

  const proc = spawn('cloudflared', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let found = useCustom;
  const onData = (data) => {
    const m = data.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !found) {
      found = true;
      console.log(`\n✦  Share: ${m[0]}\n`);
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('error', () => {
    console.log(`\ncloudflared not installed. Run manually:`);
    if (useCustom) console.log(`  cloudflared tunnel --config ${configPath} run`);
    else console.log(`  cloudflared tunnel --url http://localhost:${PORT}`);
    console.log('');
  });
}

async function main() {
  const photos = scanPhotos();
  if (!photos.length) {
    console.error(`No photos in ${PHOTO_DIR}`);
    process.exit(1);
  }
  const filterNote = FILTER_DATE ? ` (${dateArg} only)` : '';
  console.log(`\n✦ PhotoDrop — ${photos.length} photos${filterNote} in ${PHOTO_DIR}\n`);
  await generateAll(photos);

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/photos', (_req, res) => {
    const list = scanPhotos().map(filename => {
      const stat = fs.statSync(path.join(PHOTO_DIR, filename));
      return { filename, raw: isRaw(filename), size: stat.size };
    });
    res.json(list);
  });

  app.get(/^\/api\/thumb\//, (req, res) => {
    const rel = decodeURIComponent(req.path.replace(/^\/api\/thumb\//, ''));
    const file = `${rel.replace(/\//g, '_').replace(/\.[^.]+$/, '')}_thumb.jpg`;
    const full = path.join(CACHE_DIR, file);
    if (!fs.existsSync(full)) return res.sendStatus(404);
    res.type('image/jpeg').sendFile(file, { root: CACHE_DIR });
  });

  app.get(/^\/api\/preview\//, (req, res) => {
    const rel = decodeURIComponent(req.path.replace(/^\/api\/preview\//, ''));
    const file = `${rel.replace(/\//g, '_').replace(/\.[^.]+$/, '')}_preview.jpg`;
    const full = path.join(CACHE_DIR, file);
    if (!fs.existsSync(full)) return res.sendStatus(404);
    res.type('image/jpeg').sendFile(file, { root: CACHE_DIR });
  });

  app.get(/^\/api\/original\//, (req, res) => {
    const rel = decodeURIComponent(req.path.replace(/^\/api\/original\//, ''));
    const full = path.join(PHOTO_DIR, rel);
    if (!fs.existsSync(full)) return res.sendStatus(404);
    res.download(full, path.basename(rel));
  });

  app.post('/api/download', (req, res) => {
    const files = req.body.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files' });
    if (files.length > 20) return res.status(400).json({ error: 'Max 20 photos per download' });
    for (const f of files) {
      if (!fs.existsSync(path.join(PHOTO_DIR, f)))
        return res.status(404).json({ error: `Not found: ${f}` });
    }
    const ts = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="photos-${ts}.zip"`);

    const archive = archiver('zip', { store: true });
    archive.on('error', (err) => {
      console.error(`Archive error: ${err.message}`);
      if (!res.headersSent) res.status(500).json({ error: 'Zip failed' });
    });
    archive.pipe(res);
    for (const f of files) archive.file(path.join(PHOTO_DIR, f), { name: path.basename(f) });
    archive.finalize();

    console.log(`↓ Download: ${files.length} file(s) requested`);
  });

  app.listen(PORT, () => {
    console.log(`\n✦ Gallery live at http://localhost:${PORT}`);
    startTunnel();
  });
}

main().catch(err => { console.error(err); process.exit(1); });

const cleanup = async () => { await exiftool.end(); process.exit(0); };
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
