// NewPixel Audio Backend — pengganti roblox-proxy.ps1 untuk VPS (Linux).
// Jalankan: npm install && node server.js  (butuh yt-dlp + ffmpeg di PATH)
// Env: PORT (default 8765), MAX_MB (default 30), MAX_SEC (default 600)
const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');

const execFileAsync = promisify(execFile);
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 8765;
const MAX_MB = Number(process.env.MAX_MB || 30);
const MAX_SEC = Number(process.env.MAX_SEC || 600);
const MAX_BYTES = MAX_MB * 1024 * 1024;

const KNOWN = /(youtube\.com|youtu\.be|youtube-nocookie\.com|soundcloud\.com|bandcamp\.com|vimeo\.com|tiktok\.com|facebook\.com|fb\.watch|instagram\.com|twitter\.com|x\.com|twitch\.tv|mixcloud\.com|audiomack\.com|audius\.co|hearthis\.at|dailymotion\.com|vk\.com|bilibili\.com|nicovideo\.jp)/i;
const DIRECT = /\.(mp3|wav|ogg|m4a|flac|opus|webm)(\?.*)?$/i;

function badUrl(u) {
  if (typeof u !== 'string') return true;
  if (!/^https:\/\/[^"\s<>\\^`{|}]+$/.test(u)) return true;
  if (u.length > 2048) return true;
  if (/^https:\/\/(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(u)) return true;
  return false;
}

function run(cmd, args, timeoutMs) {
  return execFileAsync(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
}

async function ytDuration(url) {
  try {
    const { stdout } = await run('yt-dlp', ['--no-playlist', '--no-warnings', '--print', '%(duration)s', '--skip-download', url], 45000);
    const n = parseInt(String(stdout).trim().split('\n')[0], 10);
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

async function ytTitle(url, fallback) {
  try {
    const { stdout } = await run('yt-dlp', ['--no-playlist', '--no-warnings', '--get-title', url], 30000);
    const t = String(stdout).trim().split('\n')[0];
    if (t) return t.slice(0, 80);
  } catch {}
  return fallback;
}

app.get('/ping', (req, res) => res.json({ ok: true, service: 'newpixel-audio-backend' }));

async function handleAudio(req, res, strictYoutube) {
  const u = String(req.body?.url || '');
  if (strictYoutube) {
    if (!/^https:\/\/((www\.|m\.|music\.)?youtube\.com\/(watch|shorts|embed\/|live\/)|youtu\.be\/)[a-zA-Z0-9\-_?=&%+.,;:@/#]*$/.test(u) || /["\s]/.test(u))
      return res.status(400).json({ error: 'BAD_URL' });
  } else {
    if (badUrl(u)) return res.status(400).json({ error: 'BAD_URL' });
    if (!DIRECT.test(u) && !KNOWN.test(u)) return res.status(400).json({ error: 'UNSUPPORTED' });
    if (DIRECT.test(u)) {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 60000);
        const r = await fetch(u, { headers: { 'User-Agent': 'NewPixelAudioEditor/2.0' }, signal: ctl.signal });
        clearTimeout(t);
        if (!r.ok) return res.status(500).json({ error: 'YTFAIL', detail: 'direct fetch HTTP ' + r.status });
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 1024) return res.status(500).json({ error: 'YTFAIL', detail: 'file audio langsung kosong' });
        if (buf.length > MAX_BYTES) return res.status(413).json({ error: 'TOOBIG' });
        let title = 'audio-link';
        try {
          const uu = new URL(u);
          let seg = uu.pathname.split('/').pop() || '';
          seg = decodeURIComponent(seg).replace(/\.(mp3|wav|ogg|m4a|flac|opus|webm)$/i, '');
          if (seg) title = seg.slice(0, 80);
        } catch {}
        const ext = (path.extname(new URL(u).pathname) || '.mp3').toLowerCase();
        const mime = ext === '.m4a' ? 'audio/mp4' : (['.webm', '.ogg', '.opus'].includes(ext) ? 'audio/ogg' : ext === '.wav' ? 'audio/wav' : ext === '.flac' ? 'audio/flac' : 'audio/mpeg');
        return res.json({ status: 200, title, mime, size: buf.length, audioBase64: buf.toString('base64') });
      } catch (e) {
        return res.status(500).json({ error: 'YTFAIL', detail: String(e.message || e).slice(0, 300) });
      }
    }
  }
  // pre-cek durasi biar pesan TOOLONG benar (kasus video 37 mnt kemarin)
  const dur = await ytDuration(u);
  if (dur > MAX_SEC) return res.status(400).json({ error: 'TOOLONG' });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np-audio-'));
  const tpl = path.join(tmp, '%(id)s.%(ext)s');
  let vid = 'audio-link';
  try {
    let m = u.match(/[?&]v=([a-zA-Z0-9\-_]{6,})/); if (m) vid = 'YT-' + m[1];
    else if ((m = u.match(/youtu\.be\/([a-zA-Z0-9\-_]{6,})/))) vid = 'YT-' + m[1];
    else if ((m = u.match(/soundcloud\.com\/[^/]+\/([^/?#]+)/))) vid = m[1];
  } catch {}
  const attempts = [
    ['-x', '--audio-format', 'mp3', '--audio-quality', '0'],
    ['-f', 'bestaudio'],
    ['-f', 'bestaudio', '--extractor-args', 'youtube:player_client=android'],
    ['-f', 'bestaudio', '--extractor-args', 'youtube:player_client=ios'],
  ];
  let got = null, lastErr = '', lastExit = -1;
  for (const a of attempts) {
    try {
      const { stdout, stderr } = await run('yt-dlp',
        [...a, '--no-playlist', '--match-filter', `duration <= ${MAX_SEC}`, '--no-warnings', '--print', 'after_move:filepath', '-o', tpl, u], 240000);
      const combined = (stdout + '\n' + stderr);
      if (/does not pass filter|match_filter/i.test(combined)) { lastErr = combined.trim(); break; }
      const lines = stdout.split(/\r?\n/).filter(l => /\.(mp3|m4a|webm|ogg|opus|wav|flac)$/i.test(l.trim()));
      let cand = lines.length ? lines[lines.length - 1].trim() : null;
      if ((!cand || !fs.existsSync(cand)) && /^YT-([a-zA-Z0-9\-_]{6,})$/.test(vid)) {
        const id = vid.slice(3);
        const files = fs.readdirSync(tmp).filter(f => f.startsWith(id)).sort();
        if (files.length) cand = path.join(tmp, files[files.length - 1]);
      }
      if (cand && fs.existsSync(cand)) { got = cand; break; }
      if (/ffmpeg|ffprobe/i.test(stderr)) { lastErr = 'NO_FFMPEG'; continue; }
      lastErr = (stdout + '\n' + stderr).trim() || 'NOFILE';
    } catch (e) {
      const msg = String((e.stderr || '') + '\n' + (e.stdout || '') + '\n' + (e.message || '')).trim();
      if (/does not pass filter|match_filter/i.test(msg)) { lastErr = msg; break; }
      if (/timed out|ETIMEDOUT|Timeout/i.test(e.message || '')) { lastErr = 'TIMEOUT'; continue; }
      lastErr = msg.slice(0, 500); lastExit = e.code ?? -1;
    }
  }
  if (/does not pass filter|match_filter/i.test(lastErr)) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return res.status(400).json({ error: 'TOOLONG' });
  }
  if (!got) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (lastErr === 'NO_FFMPEG') return res.status(500).json({ error: 'NO_FFMPEG' });
    if (lastErr === 'TIMEOUT') return res.status(504).json({ error: 'TIMEOUT' });
    return res.status(500).json({ error: 'YTFAIL', detail: (lastErr || 'yt-dlp gagal tanpa pesan').slice(0, 300) });
  }
  try {
    const st = fs.statSync(got);
    if (st.size > MAX_BYTES) return res.status(413).json({ error: 'TOOBIG' });
    const buf = fs.readFileSync(got);
    let title = vid;
    if (/youtube\.com|youtu\.be/i.test(u)) {
      try {
        const r = await fetch('https://www.youtube.com/oembed?url=' + encodeURIComponent(u) + '&format=json', { headers: { 'User-Agent': 'NewPixelAudioEditor/2.0' } });
        if (r.ok) { const oj = await r.json(); if (oj.title) title = String(oj.title).slice(0, 80); }
      } catch {}
    } else title = await ytTitle(u, vid);
    const ext = path.extname(got).toLowerCase();
    const mime = ext === '.m4a' ? 'audio/mp4' : (['.webm', '.ogg', '.opus'].includes(ext) ? 'audio/ogg' : ext === '.wav' ? 'audio/wav' : ext === '.flac' ? 'audio/flac' : 'audio/mpeg');
    return res.json({ status: 200, title, mime, size: buf.length, audioBase64: buf.toString('base64') });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

app.post('/audio', (req, res) => handleAudio(req, res, false));
app.post('/youtube', (req, res) => handleAudio(req, res, true));

// --- Roblox forward (sama kayak proxy ps1, biar upload jalan online) ---
app.post('/upload', async (req, res) => {
  const { key, audioBase64, request, mime, filename } = req.body || {};
  if (!key || !audioBase64 || !request) return res.status(400).json({ error: 'key/request/audioBase64 wajib' });
  try {
    const fd = new FormData();
    fd.append('request', request);
    const blob = new Blob([Buffer.from(audioBase64, 'base64')], { type: mime || 'audio/mpeg' });
    fd.append('fileContent', blob, filename || 'audio.mp3');
    const r = await fetch('https://apis.roblox.com/assets/v1/assets', { method: 'POST', headers: { 'x-api-key': key }, body: fd });
    res.status(r.status).json({ status: r.status, body: await r.text() });
  } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
});
app.post('/status', async (req, res) => {
  const { key, op } = req.body || {};
  if (!key || !op) return res.status(400).json({ error: 'key/op wajib' });
  try {
    const r = await fetch('https://apis.roblox.com/assets/v1/operations/' + op, { headers: { 'x-api-key': key } });
    res.status(r.status).json({ status: r.status, body: await r.text() });
  } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
});
app.post('/forward', async (req, res) => {
  const { key, method, path: p, body } = req.body || {};
  if (!key || !method || !p) return res.status(400).json({ error: 'key/method/path wajib' });
  if (!/^\/[a-zA-Z0-9\-/_.{}:]+$/.test(p)) return res.status(400).json({ error: 'path tidak valid' });
  try {
    const r = await fetch('https://apis.roblox.com' + p, { method, headers: { 'x-api-key': key, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(typeof body === 'string' ? JSON.parse(body) : body) : undefined });
    res.status(r.status).json({ status: r.status, body: await r.text() });
  } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
});
app.post('/fetch', async (req, res) => {
  const u = String(req.body?.url || '');
  if (!/^https:\/\/[a-z0-9\-]+\.roblox\.com\/[a-zA-Z0-9\-/_.?=&%+,;:@]*$/.test(u)) return res.status(400).json({ error: 'hanya URL https://*.roblox.com yang diizinkan' });
  try {
    const r = await fetch(u, { headers: { 'User-Agent': 'NewPixelAudioEditor/2.0', Accept: 'application/json' } });
    res.status(r.status).json({ status: r.status, body: await r.text() });
  } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
});

app.listen(PORT, () => console.log('NewPixel backend jalan di port ' + PORT));
