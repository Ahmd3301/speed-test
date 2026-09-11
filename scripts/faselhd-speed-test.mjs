#!/usr/bin/env node
/**
 * faselhd-speed-test.mjs
 * اختبار سرعة تحميل جودة 1080p من سيرفر fasel-hd (scdns.io) بأقصى سرعة.
 *
 * الفكرة:
 *  1) استخراج رابط الـ Master عبر exFaselHD1234.js (أو تمرير --master مباشرة)
 *  2) اختيار variant الـ 1080p (أعلى BANDWIDTH / RESOLUTION=1920x1080)
 *  3) اختبار Sequential (اتصال واحد) مقابل Parallel (متوازي) على نفس العينة
 *  4) اختبار كامل اختياري + remux إلى MP4 بدون re-encode (‎-c copy فقط)
 *
 * يعتمد على Node 20+‎ فقط (native fetch) — بدون مكتبات خارجية.
 * يقارن أيضاً مع N_m3u8DL-RE و ffmpeg إن وُجدا (يتم استدعاؤهما من الـ workflow).
 *
 * Usage:
 *   node scripts/faselhd-speed-test.mjs --url "https://www.fasel-hd.co/?p=271259" \
 *     --threads 16 --sample 20 --full --out ./speed-results
 *   node scripts/faselhd-speed-test.mjs --master "https://.../master.m3u8" --sample 20
 */

import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return def;
}
function hasFlag(name) { return process.argv.includes(name); }

const PAGE_URL = arg('--url', 'https://www.fasel-hd.co/?p=271259');
const MASTER_DIRECT = arg('--master', null);
const THREADS = parseInt(arg('--threads', '16'), 10);
const SAMPLE_N = parseInt(arg('--sample', '20'), 10);
const DO_FULL = hasFlag('--full');
const OUT_DIR = resolve(arg('--out', './speed-results'));
const EXTRACTOR = arg('--extractor', './exFaselHD1234.js');

mkdirSync(OUT_DIR, { recursive: true });

// ---------- helpers ----------
async function fetchText(url, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*', Referer: 'https://www.fasel-hd.co/' }, signal: ctrl.signal, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.slice(0, 120)}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

async function fetchBytesTimed(url, timeoutMs = 60000) {
  const t0 = process.hrtime.bigint();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.fasel-hd.co/' }, signal: ctrl.signal, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const ttfbMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const buf = Buffer.from(await r.arrayBuffer());
    const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
    return { bytes: buf.length, ttfbMs, totalMs, buf };
  } finally { clearTimeout(t); }
}

function parseMaster(masterText, masterUrl) {
  const variants = [];
  const re = /#EXT-X-STREAM-INF:([^\n]+)\n([^\n]+)/g;
  let m;
  while ((m = re.exec(masterText)) !== null) {
    const attrs = m[1];
    let uri = m[2].trim();
    try { uri = new URL(uri, masterUrl).href; } catch {}
    const bw = /BANDWIDTH=(\d+)/.exec(attrs)?.[1];
    const res = /RESOLUTION=(\d+x\d+)/.exec(attrs)?.[1];
    variants.push({ bandwidth: bw ? parseInt(bw, 10) : 0, resolution: res || 'unknown', uri, attrs });
  }
  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return variants;
}

function parseMediaPlaylist(text, playlistUrl) {
  const isEncrypted = /#EXT-X-KEY:/.test(text);
  const keyLine = /#EXT-X-KEY:[^\n]+/.exec(text)?.[0] || null;
  const isFmp4 = text.includes('.m4s') || /#EXT-X-MAP:/.test(text);
  const container = isFmp4 ? 'fmp4' : 'mpegts';
  const durations = [...text.matchAll(/#EXTINF:([0-9.]+)/g)].map(x => parseFloat(x[1]));
  const totalDuration = durations.reduce((a, b) => a + b, 0);
  const segments = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    try { segments.push(new URL(s, playlistUrl).href); } catch { segments.push(s); }
  }
  return { isEncrypted, keyLine, container, totalDuration, segments, count: segments.length };
}

function extractMasterViaScript(pageUrl) {
  const r = spawnSync('node', [EXTRACTOR, pageUrl], { encoding: 'utf8', timeout: 60000 });
  const out = (r.stdout || '') + '\n' + (r.stderr || '');
  const link = /Link:\s*(https?:\S+\.m3u8\S*)/.exec(out)?.[1]?.trim();
  const name = /Name:\s*(.+)/.exec(out)?.[1]?.trim() || '';
  const ep = /Episode:\s*(\S+)/.exec(out)?.[1]?.trim() || '';
  if (!link) throw new Error('Failed to extract master link. Output:\n' + out.slice(0, 2000));
  return { link, name, ep, raw: out };
}

// Simple concurrency pool preserving order
async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let idx = 0, active = 0, maxActive = 0, errors = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      active++; maxActive = Math.max(maxActive, active);
      try { results[i] = { ok: true, value: await fn(items[i], i) }; }
      catch (e) { errors++; results[i] = { ok: false, error: String(e?.message || e) }; }
      active--;
    }
  });
  await Promise.all(workers);
  return { results, maxActive, errors };
}

const fmtMB = b => (b / 1024 / 1024).toFixed(2);
const fmtMbps = bps => (bps / 1e6).toFixed(1);

async function main() {
  const startedAll = Date.now();
  console.log(`[1/6] Extract master … (page=${PAGE_URL})`);
  let masterUrl = MASTER_DIRECT, pageMeta = {};
  if (!masterUrl) {
    const ex = extractMasterViaScript(PAGE_URL);
    masterUrl = ex.link; pageMeta = { name: ex.name, episode: ex.ep };
    console.log(`      Name: ${ex.name} | Episode: ${ex.ep}`);
  }
  console.log(`      Master: ${masterUrl.slice(0, 110)}…`);

  console.log('[2/6] Fetch link + select 1080p (master or direct media) …');
  const linkText = await fetchText(masterUrl);
  let variants = parseMaster(linkText, masterUrl);
  let v1080;
  if (variants.length) {
    console.log('      Link is MASTER playlist:');
    variants.forEach(v => console.log(`        - ${v.resolution} bw=${v.bandwidth} :: ${v.uri.slice(0, 90)}…`));
    v1080 = variants.find(v => v.resolution === '1920x1080') || variants[0];
  } else {
    // الرابط بلايلست media مباشرة (بدون Master) — استخدمها كما هي
    const guess = /hd(\d{3,4})b|[^0-9](\d{3,4})p|sd(\d{3})b/i.exec(masterUrl);
    const q = guess ? (guess[1] || guess[2] || guess[3]) : null;
    const resMap = { '1080': '1920x1080', '720': '1280x720', '360': '640x360' };
    v1080 = { bandwidth: 0, resolution: resMap[q] || 'direct', uri: masterUrl };
    variants = [{ ...v1080 }];
    console.log(`      Link is DIRECT media playlist (no master), guessed ${v1080.resolution}`);
  }
  console.log(`      Selected 1080p: ${v1080.resolution} bw=${v1080.bandwidth}`);

  console.log('[3/6] Fetch 1080p media playlist …');
  const mediaText = await fetchText(v1080.uri);
  const media = parseMediaPlaylist(mediaText, v1080.uri);
  console.log(`      segments=${media.count} duration=${media.totalDuration.toFixed(1)}s encrypted=${media.isEncrypted} container=${media.container}`);
  if (media.isEncrypted) console.log(`      KEY: ${media.keyLine}`);
  if (media.count === 0) throw new Error('Empty media playlist');

  // Warm-up: single segment baseline (single connection)
  console.log('[4/6] Test A — single segment, single connection (baseline) …');
  const firstSeg = media.segments[0];
  const a = await fetchBytesTimed(firstSeg);
  const aSpeedMbps = (a.bytes * 8) / (a.totalMs / 1000) / 1e6;
  console.log(`      RESULT_NET_SINGLE_SEGMENT=${fmtMB(a.bytes)} MB in ${a.totalMs.toFixed(0)}ms (TTFB ${a.ttfbMs.toFixed(0)}ms) = ${fmtMbps(a.bytes * 8 / (a.totalMs / 1000))} Mbps`);
  writeFileSync(join(OUT_DIR, 'single_segment.bin'), a.buf);

  // Test B — sequential sample
  const sample = media.segments.slice(0, Math.min(SAMPLE_N, media.count));
  console.log(`[5/6] Test B — sequential download of ${sample.length} segments (1 connection) …`);
  let seqBytes = 0;
  const tSeq0 = process.hrtime.bigint();
  let seqFail = 0;
  for (const u of sample) {
    try { const r = await fetchBytesTimed(u); seqBytes += r.bytes; }
    catch { seqFail++; }
  }
  const seqMs = Number(process.hrtime.bigint() - tSeq0) / 1e6;
  const seqMbps = seqMs > 0 ? (seqBytes * 8) / (seqMs / 1000) / 1e6 : 0;
  console.log(`      RESULT_SEQ=${fmtMB(seqBytes)} MB in ${(seqMs / 1000).toFixed(2)}s = ${seqMbps.toFixed(1)} Mbps (${(seqBytes / Math.max(seqMs / 1000, 0.01) / 1024 / 1024).toFixed(2)} MB/s, fails=${seqFail})`);

  // Test C — parallel sample (same segments)
  console.log(`[6/6] Test C — parallel download of same ${sample.length} segments (threads=${THREADS}) …`);
  const tPar0 = process.hrtime.bigint();
  const { results, maxActive, errors } = await mapPool(sample, THREADS, async (u) => (await fetchBytesTimed(u)).bytes);
  const parMs = Number(process.hrtime.bigint() - tPar0) / 1e6;
  const parBytes = results.filter(r => r.ok).reduce((s, r) => s + r.value, 0);
  const parMbps = parMs > 0 ? (parBytes * 8) / (parMs / 1000) / 1e6 : 0;
  const speedup = seqMs > 0 ? seqMs / Math.max(parMs, 1) : 0;
  const effThreads = Math.min(THREADS, sample.length);
  const efficiency = (speedup / effThreads) * 100;
  console.log(`      RESULT_PAR=${fmtMB(parBytes)} MB in ${(parMs / 1000).toFixed(2)}s = ${parMbps.toFixed(1)} Mbps (${(parBytes / Math.max(parMs / 1000, 0.01) / 1024 / 1024).toFixed(2)} MB/s, maxConcurrency=${maxActive}, fails=${errors})`);
  console.log(`      RESULT_SPEEDUP=${speedup.toFixed(2)}x with ${THREADS} threads (efficiency ${efficiency.toFixed(1)}%)`);

  // Verdicts
  let throttleVerdict, parallelVerdict;
  if (speedup >= effThreads * 0.7) { throttleVerdict = 'NO_THROTTLE: linear scaling — server allows full parallel throughput'; }
  else if (speedup >= Math.min(2, effThreads * 0.5)) { throttleVerdict = 'PARTIAL: parallel helps but sub-linear — possible per-connection or aggregate soft-limit'; }
  else { throttleVerdict = 'THROTTLED_OR_SATURATED: parallel barely helps — single pipe already saturates runner network or server caps aggregate'; }
  parallelVerdict = errors === 0 && speedup > 1.2
    ? 'PARALLEL_SUPPORTED: segments are independent static files, parallel range-safe (each .ts URL independent, no session)'
    : 'PARALLEL_LIMITED: check 429/5xx or token expiry — rerun with lower threads';

  // Optional full download + remux measurement (parallel, then binary concat for .ts)
  let full = null;
  if (DO_FULL) {
    console.log(`[+] Full 1080p download: ${media.count} segments with ${THREADS} threads …`);
    const tF0 = process.hrtime.bigint();
    const fr = await mapPool(media.segments, THREADS, async (u) => await fetchBytesTimed(u));
    const fMs = Number(process.hrtime.bigint() - tF0) / 1e6;
    const okParts = [];
    let fBytes = 0, fFail = 0;
    fr.results.forEach((r, i) => {
      if (r.ok) { fBytes += r.value.bytes; okParts.push({ i, buf: r.value.buf }); }
      else fFail++;
    });
    const fMbps = (fBytes * 8) / (fMs / 1000) / 1e6;
    console.log(`      RESULT_FULL=${fmtMB(fBytes)} MB in ${(fMs / 1000).toFixed(1)}s = ${fMbps.toFixed(1)} Mbps (fails=${fFail}/${media.count})`);
    // merge in order (binary concat valid for MPEG-TS)
    okParts.sort((x, y) => x.i - y.i);
    const mergedPath = join(OUT_DIR, 'full_1080p_merged.ts');
    if (media.container === 'mpegts' && !media.isEncrypted) {
      const { writeFileSync: w, createWriteStream } = await import('node:fs');
      const ws = createWriteStream(mergedPath);
      for (const p of okParts) ws.write(p.buf);
      ws.end();
      await new Promise(res => ws.on('finish', res));
      console.log(`      merged -> ${mergedPath} (${fmtMB(fBytes)} MB)`);
    } else {
      console.log('      NOTE: container is fmp4 or encrypted — binary concat skipped, use N_m3u8DL-RE/ffmpeg for merge');
    }
    // remux timing if ffmpeg exists
    let remux = null;
    const ff = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 15000 });
    if (ff.status === 0 && existsSync(mergedPath)) {
      const mp4Path = join(OUT_DIR, 'full_1080p.mp4');
      const tR0 = process.hrtime.bigint();
      const rr = spawnSync('ffmpeg', ['-y', '-i', mergedPath, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', mp4Path],
        { encoding: 'utf8', timeout: 600000 });
      const rMs = Number(process.hrtime.bigint() - tR0) / 1e6;
      const ok = rr.status === 0 && existsSync(mp4Path);
      const mp4Size = ok ? statSync(mp4Path).size : 0;
      console.log(`      RESULT_REMUX=${ok ? 'OK' : 'FAIL'} in ${(rMs / 1000).toFixed(1)}s (${fmtMB(mp4Size)} MB) — -c copy, no re-encode`);
      if (!ok) console.log('      ffmpeg stderr: ' + (rr.stderr || '').slice(-1500));
      remux = { ok, ms: rMs, mp4Size, mp4Path: ok ? mp4Path : null };
    } else {
      console.log('      ffmpeg not found or no merged file — remux skipped (workflow installs ffmpeg)');
    }
    full = { segments: media.count, failed: fFail, bytes: fBytes, ms: fMs, mbps: fMbps, remux };
  }

  const result = {
    tool: 'faselhd-speed-test.mjs (Node native fetch)',
    date_utc: new Date().toISOString(),
    page_url: PAGE_URL,
    page_meta: pageMeta,
    master_url: masterUrl,
    variants: variants.map(v => ({ resolution: v.resolution, bandwidth: v.bandwidth })),
    selected_1080p: { resolution: v1080.resolution, bandwidth: v1080.bandwidth, playlist: v1080.uri },
    media: { count: media.count, duration_s: +media.totalDuration.toFixed(2), encrypted: media.isEncrypted, container: media.container },
    test_single_segment: { bytes: a.bytes, ms: +a.totalMs.toFixed(1), ttfb_ms: +a.ttfbMs.toFixed(1), mbps: +((a.bytes * 8) / (a.totalMs / 1000) / 1e6).toFixed(1) },
    test_sequential: { segments: sample.length, bytes: seqBytes, ms: +seqMs.toFixed(1), mbps: +seqMbps.toFixed(1), fails: seqFail },
    test_parallel: { segments: sample.length, threads: THREADS, bytes: parBytes, ms: +parMs.toFixed(1), mbps: +parMbps.toFixed(1), max_concurrency: maxActive, fails: errors, speedup_vs_sequential: +speedup.toFixed(2) },
    verdicts: { throttle: throttleVerdict, parallel: parallelVerdict },
    full,
    total_wall_ms: Date.now() - startedAll,
  };
  writeFileSync(join(OUT_DIR, 'results.json'), JSON.stringify(result, null, 2));
  console.log('\n===== SUMMARY =====');
  console.log(`1080p playlist: ${media.count} segs, ${media.totalDuration.toFixed(0)}s, ${media.container}, encrypted=${media.isEncrypted}`);
  console.log(`Sequential(${sample.length} segs): ${seqMbps.toFixed(1)} Mbps | Parallel(x${THREADS}): ${parMbps.toFixed(1)} Mbps | Speedup: ${speedup.toFixed(2)}x`);
  console.log(`Verdict: ${throttleVerdict}`);
  console.log(`Verdict: ${parallelVerdict}`);
  console.log(`Results JSON: ${join(OUT_DIR, 'results.json')}`);
}

main().catch(e => { console.error('FATAL: ' + (e.stack || e.message)); process.exit(1); });
