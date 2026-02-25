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
const ZIPS_DIR = path.join(CACHE_DIR, 'zips');
const REQUESTS_DIR = path.join(CACHE_DIR, 'requests');

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
const WEB_W = 2048;

const exiftool = new ExifTool({ taskTimeoutMillis: 30000 });

if (!fs.existsSync(PHOTO_DIR)) {
  console.error(`Error: "${PHOTO_DIR}" does not exist.`);
  process.exit(1);
}
fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(ZIPS_DIR, { recursive: true });
fs.mkdirSync(REQUESTS_DIR, { recursive: true });

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

async function ensureCached(srcPath, relPath, width, suffix, quality = 82) {
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
    .jpeg({ quality })
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

  const BOOT = Date.now();
  const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
    .replace('src="app.js"', `src="app.js?v=${BOOT}"`);

  app.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.send(indexHtml);
  });

  app.use(express.static(path.join(__dirname, 'public')));
  let activeDownload = null;
  let downloadSeq = 0;

  app.get('/api/photos', (_req, res) => {
    const list = scanPhotos().map(filename => {
      const stat = fs.statSync(path.join(PHOTO_DIR, filename));
      const previewPath = cached(filename, 'preview');
      const previewSize = fs.existsSync(previewPath) ? fs.statSync(previewPath).size : null;
      const webPath = cached(filename, 'web');
      const webSize = fs.existsSync(webPath) ? fs.statSync(webPath).size : null;
      return { filename, raw: isRaw(filename), size: stat.size, previewSize, webSize };
    });
    res.json(list);
  });

  app.get('/api/speed-test', (req, res) => {
    const requested = parseInt(req.query.bytes || '1048576', 10);
    const bytes = Math.max(65536, Math.min(requested, 5 * 1024 * 1024));
    const payload = Buffer.alloc(bytes, 0x61);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Content-Length', bytes);
    res.end(payload);
  });

  app.get('/api/download-status', (_req, res) => {
    if (!activeDownload) return res.json({ busy: false });
    res.json({
      busy: true,
      id: activeDownload.id,
      mode: activeDownload.mode,
      files: activeDownload.files,
      runningForMs: Date.now() - activeDownload.startedAt,
    });
  });

  app.get(/^\/api\/thumb\//, (req, res) => {
    const rel = decodeURIComponent(req.path.replace(/^\/api\/thumb\//, ''));
    const file = `${rel.replace(/\//g, '_').replace(/\.[^.]+$/, '')}_thumb.jpg`;
    const full = path.join(CACHE_DIR, file);
    if (!fs.existsSync(full)) return res.sendStatus(404);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.type('image/jpeg').sendFile(file, { root: CACHE_DIR });
  });

  app.get(/^\/api\/preview\//, (req, res) => {
    const rel = decodeURIComponent(req.path.replace(/^\/api\/preview\//, ''));
    const file = `${rel.replace(/\//g, '_').replace(/\.[^.]+$/, '')}_preview.jpg`;
    const full = path.join(CACHE_DIR, file);
    if (!fs.existsSync(full)) return res.sendStatus(404);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.type('image/jpeg').sendFile(file, { root: CACHE_DIR });
  });

  app.get(/^\/api\/original\//, (req, res) => {
    const rel = decodeURIComponent(req.path.replace(/^\/api\/original\//, ''));
    const full = path.join(PHOTO_DIR, rel);
    if (!fs.existsSync(full)) return res.sendStatus(404);
    res.download(full, path.basename(rel));
  });

  app.post('/api/download', async (req, res) => {
    const files = req.body.files || [];
    const mode = req.body.mode === 'jpg' ? 'jpg' : 'original';
    if (!files.length) return res.status(400).json({ error: 'No files' });
    if (files.length > 20) return res.status(400).json({ error: 'Max 20 photos per download' });
    if (activeDownload) {
      return res.status(429).json({
        error: 'Server is currently processing another download. Please retry in a moment.',
        retryAfterSec: 5,
      });
    }
    for (const f of files) {
      if (!fs.existsSync(path.join(PHOTO_DIR, f)))
        return res.status(404).json({ error: `Not found: ${f}` });
    }

    const prepared = [];
    let plannedBytes = 0;
    for (const f of files) {
      const fullPath = path.join(PHOTO_DIR, f);
      if (mode === 'jpg') {
        let webPath = cached(f, 'web');
        if (!fs.existsSync(webPath)) {
          await ensureCached(fullPath, f, WEB_W, 'web', 85);
        }
        webPath = cached(f, 'web');
        if (!fs.existsSync(webPath)) return res.status(500).json({ error: `JPG conversion failed: ${f}` });
        prepared.push({ source: webPath, name: `${path.basename(f, path.extname(f))}.jpg` });
        plannedBytes += fs.statSync(webPath).size;
      } else {
        prepared.push({ source: fullPath, name: path.basename(f) });
        plannedBytes += fs.statSync(fullPath).size;
      }
    }

    const job = {
      id: `dl-${++downloadSeq}`,
      mode,
      files: files.length,
      plannedBytes,
      startedAt: Date.now(),
    };
    activeDownload = job;

    const reqTime = new Date().toISOString();
    const reqSafe = reqTime.replace(/[:.]/g, '-').slice(0, 19);
    const zipPath = path.join(ZIPS_DIR, `${job.id}-${reqSafe}.zip`);
    const reqLog = { id: job.id, time: reqTime, mode, files, status: 'building', zipPath };
    const reqLogPath = path.join(REQUESTS_DIR, `${job.id}.json`);
    fs.writeFileSync(reqLogPath, JSON.stringify(reqLog, null, 2));

    console.log(`↓ Download: ${files.length} file(s) requested (${mode}) [${job.id}]`);

    req.setTimeout(0);
    res.setTimeout(0);

    const startedAt = Date.now();
    let finished = false;
    const finish = (status, extra = '') => {
      if (finished) return;
      finished = true;
      const elapsedMs = Date.now() - startedAt;
      console.log(
        `[download] id=${job.id} status=${status} mode=${mode} files=${files.length} ` +
        `planned_mb=${(plannedBytes / 1048576).toFixed(2)} elapsed_ms=${elapsedMs} ${extra}`.trim()
      );
      reqLog.status = status;
      fs.writeFileSync(reqLogPath, JSON.stringify(reqLog, null, 2));
      if (status === 'sent') {
        fs.unlink(zipPath, () => {});
      } else {
        console.log(`  ZIP saved at: ${zipPath}`);
      }
      activeDownload = null;
    };

    // Build ZIP to disk first so it survives a dropped connection
    try {
      await new Promise((resolve, reject) => {
        const archive = archiver('zip', { store: true });
        const out = fs.createWriteStream(zipPath);
        archive.on('error', reject);
        out.on('close', resolve);
        archive.pipe(out);
        for (const item of prepared) {
          archive.append(fs.createReadStream(item.source), { name: item.name });
        }
        archive.finalize();
      });
    } catch (err) {
      console.error(`Archive error: ${err.message}`);
      reqLog.status = 'build_error';
      fs.writeFileSync(reqLogPath, JSON.stringify(reqLog, null, 2));
      activeDownload = null;
      return res.status(500).json({ error: 'Zip failed' });
    }

    const zipSize = fs.statSync(zipPath).size;
    reqLog.zipSize = zipSize;
    reqLog.status = 'ready';
    fs.writeFileSync(reqLogPath, JSON.stringify(reqLog, null, 2));

    const dlDate = reqTime.slice(0, 10);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="photos-${dlDate}-${mode}.zip"`);
    res.setHeader('Content-Length', zipSize);
    res.setHeader('Connection', 'keep-alive');

    const stream = fs.createReadStream(zipPath);
    stream.on('error', (err) => finish('read_error', `err="${err.message}"`));
    res.on('finish', () => finish('sent'));
    res.on('close', () => { if (!finished) finish('client_closed'); });
    stream.pipe(res);
  });

  const server = app.listen(PORT, () => {
    console.log(`\n✦ Gallery live at http://localhost:${PORT}`);
    spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    console.log('✦ Sleep prevention active — Mac will stay awake while serving');
    startTunnel();
  });
  server.timeout = 0;
  server.keepAliveTimeout = 120000;
}

main().catch(err => { console.error(err); process.exit(1); });

const cleanup = async () => { await exiftool.end(); process.exit(0); };
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
