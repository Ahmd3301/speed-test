const https = require('https');
const http = require('http');
const vm = require('vm');
const readline = require('readline');

process.on('uncaughtException', (e) => { console.error('Error: ' + (e.message || e)); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('Error: ' + (e.message || e)); process.exit(1); });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });

function fetchUrl(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const agent = url.startsWith('https') ? httpsAgent : httpAgent;
    const req = mod.get(url, {
      agent,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'ar,en-US;q=0.7' }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let loc = res.headers.location;
        if (loc.startsWith('/')) { const p = new URL(url); loc = p.protocol + '//' + p.host + loc; }
        res.resume();
        return resolve(fetchUrl(loc, retries));
      }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (retries > 0 && (d.includes('Just a moment') || d.includes('cf-browser-verification'))) {
          setTimeout(() => resolve(fetchUrl(url, retries - 1)), 2000 + Math.random() * 3000);
        } else resolve(d);
      });
    });
    req.on('error', (e) => reject(e));
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function cleanName(name) {
  let n = name
    .replace(/&#\d+;/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/مسلسل\s*/g, '')
    .replace(/فيلم\s*/g, '')
    .replace(/ الموسم\s*\S+/g, '')
    .replace(/[–\-]\s*الحلقة\s*\d+/g, '')
    .replace(/الحلقة\s*\d+/g, '')
    .replace(/مترجم/g, '')
    .replace(/[–\-]\s*فاصل إعلاني.*$/i, '')
    .replace(/فاصل إعلاني.*$/i, '')
    .replace(/&#8211;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return n;
}

function parseName(html) {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return cleanName(h1[1]);
  const h3 = html.match(/<div class="h3"[^>]*>([\s\S]*?)<\/div>/i);
  if (h3) return cleanName(h3[1]);
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) return cleanName(title[1]);
  return 'Unknown';
}

// NEW: Extract episode number from Arabic text like "الحلقة 1" or "الحلقة 01"
function parseEpisodeNumber(html) {
  const m = html.match(/الحلقة\s*(\d+)/i);
  if (m) return String(m[1]).padStart(2, '0');
  return null;
}

function parsePlayerUrls(html) {
  const urls = [];
  let rx = /player_iframe\.location\.href\s*=\s*'([^']+)'/g;
  let m;
  while ((m = rx.exec(html)) !== null) urls.push(decodeURIComponent(m[1]));
  rx = /(?:data-src|src)\s*=\s*"([^"]*video_player[^"]*)"/g;
  while ((m = rx.exec(html)) !== null) urls.push(decodeURIComponent(m[1]));
  return [...new Set(urls)];
}

function parseEpisodeLinks(html) {
  const links = [];
  let rx = /<a\s+href="([^"]*\/episodes\/[^"]*)"[^>]*>\s*الحلقة\s*\d+\s*<\/a>/gi;
  let m;
  while ((m = rx.exec(html)) !== null) links.push(m[1]);
  if (links.length > 0) return links;
  const rx2 = /<a\s+href="([^"]*\/asian-episodes\/[^"]*)"[^>]*>\s*الحلقة\s*\d+\s*<\/a>/gi;
  while ((m = rx2.exec(html)) !== null) links.push(m[1]);
  if (links.length > 0) return links;
  const epAllMatch = html.match(/<div class="epAll"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
  if (epAllMatch) {
    let rx3 = /<a\s+href="([^"]+)"[^>]*>/g;
    while ((m = rx3.exec(epAllMatch[1])) !== null) links.push(m[1]);
  }
  return links;
}

function parseSeasonList(html) {
  const seasons = [];
  const nums = [];
  let rx = /<div class="title">موسم\s*(\d+)<\/div>/g;
  let m;
  while ((m = rx.exec(html)) !== null) nums.push(parseInt(m[1]));
  const posts = [];
  rx = /onclick="window\.location\.href\s*=\s*'\/\?p=(\d+)'/g;
  while ((m = rx.exec(html)) !== null) posts.push(m[1]);
  for (let i = 0; i < Math.min(nums.length, posts.length); i++) {
    seasons.push({ num: nums[i], postId: posts[i] });
  }
  return seasons;
}

function decodeM3u8(playerHtml, playerUrl) {
  const scriptRx = /<script[^>]*>([\s\S]*?)<\/script>/g;
  let decoder = null;
  let sm;
  while ((sm = scriptRx.exec(playerHtml)) !== null) {
    const s = sm[1];
    if (s.length > 5000 && !s.includes('ChmaorrCfoz') && (s.includes('!![]') || s.includes('function _0x'))) {
      decoder = s;
      break;
    }
  }
  if (!decoder) return null;

  let captured = '';
  const sandbox = {
    document: {
      write: (...args) => { captured += args.join(''); },
      writeln: (...args) => { captured += args.join('') + '\n'; },
      getElementById: (id) => id === 'video' ? { canPlayType: () => '', set src(v) { captured += '<video src="' + v + '">'; }, get src() { return ''; } } : null,
      createElement: (tag) => tag === 'video' ? { canPlayType: () => '', set src(v) { captured += '<video src="' + v + '">'; }, get src() { return ''; } } : { setAttribute: () => {}, appendChild: () => {}, addEventListener: () => {}, get src() { return ''; }, set src(v) { captured += '<e src="' + v + '">'; } },
      createTextNode: () => ({}),
      querySelectorAll: () => [],
      querySelector: () => null,
      body: { appendChild: () => {} },
      head: { appendChild: () => {} },
    },
    window: {
      location: { href: playerUrl, hostname: new URL(playerUrl).hostname, search: '' },
      addEventListener: () => {},
      setTimeout: (fn) => { try { fn(); } catch(e) {} },
      setInterval: () => ({}),
      Hls: { isSupported: () => false, Events: {} },
      navigator: { userAgent: UA },
      console: { log: () => {}, error: () => {}, warn: () => {} },
      atob: (s) => Buffer.from(s, 'base64').toString('binary'),
      btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    },
    location: { href: playerUrl, hostname: new URL(playerUrl).hostname, search: '' },
    navigator: { userAgent: UA },
    setTimeout: (fn) => { try { fn(); } catch(e) {} },
    console: { log: () => {}, error: () => {}, warn: () => {} },
  };

  try {
    vm.runInContext(decoder, vm.createContext(sandbox), { timeout: 5000 });
  } catch (e) {}

  const urls = [];
  let rx = /data-url="([^"]*\.m3u8[^"]*)"/g;
  let m;
  while ((m = rx.exec(captured)) !== null) urls.push(m[1]);
  rx = /<video[^>]*src="([^"]*\.m3u8[^"]*)"/g;
  while ((m = rx.exec(captured)) !== null) urls.push(m[1]);
  rx = /loadSource\s*\(\s*['"]([^'"]*\.m3u8[^'"]*)['"]/gi;
  while ((m = rx.exec(captured)) !== null) urls.push(m[1]);
  return [...new Set(urls)];
}

async function resolveEpisode(epUrl) {
  try {
    const html = await fetchUrl(epUrl);
    const playerUrls = parsePlayerUrls(html);
    if (playerUrls.length === 0) return null;
    const playerHtml = await fetchUrl(playerUrls[0]);
    const urls = decodeM3u8(playerHtml, playerUrls[0]);
    return (urls && urls.length > 0) ? urls[0] : null;
  } catch (e) { return null; }
}

async function showUrls(label, epUrl) {
  const url = await resolveEpisode(epUrl);
  if (url) {
    console.log('Link ' + label + ': ' + url);
  } else {
    console.log('Link ' + label + ': ERROR');
  }
}

(async () => {
  try {
  const url = process.argv[2];
  if (!url) {
    console.log('Usage: node exFaselHD.cjs <URL>');
    process.exit(1);
  }

  // ============================================================
  // Direct Link Mode: when the URL contains ?p= or &p= (single post page)
  // Extract name, episode number, and master m3u8 link, then exit immediately.
  // ============================================================
  const isPostUrl = /[?&]p=\d+/.test(url);

  if (isPostUrl) {
    const html = await fetchUrl(url);
    const name = parseName(html);
    const episode = parseEpisodeNumber(html);
    const playerUrls = parsePlayerUrls(html);

    if (playerUrls.length === 0) {
      console.log('Name: ' + name);
      if (episode) console.log('Episode: ' + episode);
      console.log('Link: ERROR (no player found)');
      process.exit(1);
    }

    const firstPlayerUrl = playerUrls[0];
    const playerHtml = await fetchUrl(firstPlayerUrl);
    const m3u8Urls = decodeM3u8(playerHtml, firstPlayerUrl);

    console.log('Name: ' + name);
    if (episode) console.log('Episode: ' + episode);

    if (m3u8Urls && m3u8Urls.length > 0) {
      console.log('Link: ' + m3u8Urls[0]);
    } else {
      console.log('Link: ERROR (no m3u8 found)');
    }

    process.exit(0);
  }
  // ============================================================

  const html = await fetchUrl(url);

  const parsedUrl = new URL(url);
  const baseHost = parsedUrl.hostname;

  const name = parseName(html);
  const seasonList = parseSeasonList(html);
  const epLinks = parseEpisodeLinks(html);
  const playerUrls = parsePlayerUrls(html);
  const hasSeasonsInUrl = url.includes('/seasons/');
  const pageType = (hasSeasonsInUrl && seasonList.length > 0) || seasonList.length > 1 ? 'seasons' : (epLinks.length > 0 ? 'series' : 'movie');

  console.log('Name:');
  console.log(name);

  if (pageType === 'seasons') {
    const allEps = [];
    const seasonCounts = {};

    const promises = seasonList.map(async (s) => {
      let eps = [];
      if (s.postId) {
        try {
          const sh = await fetchUrl(`https://${baseHost}/?p=${s.postId}`);
          eps = parseEpisodeLinks(sh);
        } catch (e) { console.error('Error: ' + e.message); }
      }
      return { s, eps };
    });

    const results = await Promise.all(promises);

    for (const r of results.sort((a, b) => a.s.num - b.s.num)) {
      seasonCounts[r.s.num] = r.eps.length;
      const sKey = 'S' + String(r.s.num).padStart(2, '0');
      for (let i = 0; i < r.eps.length; i++) {
        allEps.push({ url: r.eps[i], season: r.s.num, episode: i + 1, label: sKey + 'Eps' + String(i + 1).padStart(2, '0') });
      }
    }

    const seasonLabel = seasonList.map(s => 'S' + String(s.num).padStart(2, '0') + '{' + (seasonCounts[s.num] || 0) + '}').join(', ');
    console.log('seasons: ' + seasonList.length + ' (' + seasonLabel + ', )');
    console.log('Eps: ' + allEps.length);
    if (allEps.length > 0) {
      await showUrls(allEps[0].label, allEps[0].url);
    }

    if (process.stdin.isTTY) {
      const ri = readline.createInterface({ input: process.stdin, output: process.stdout });
      (function loop() {
        ri.question('Enter the number of any episode to reveal the link> ', async (ans) => {
          const n = parseInt(ans);
          if (isNaN(n) || n < 1 || n > allEps.length) { ri.close(); return; }
          await showUrls(allEps[n - 1].label, allEps[n - 1].url);
          loop();
        });
      })();
    } else {
      let _d = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', c => _d += c);
      process.stdin.on('end', async () => {
        const lines = _d.trim().split('\n');
        for (const line of lines) {
          const n = parseInt(line.trim());
          if (isNaN(n) || n < 1 || n > allEps.length) break;
          await showUrls(allEps[n - 1].label, allEps[n - 1].url);
        }
      });
    }

  } else if (pageType === 'series') {
    console.log('Eps: ' + epLinks.length);
    if (epLinks.length > 0) {
      await showUrls('Eps01', epLinks[0]);
    }
    if (process.stdin.isTTY) {
      const ri = readline.createInterface({ input: process.stdin, output: process.stdout });
      (function loop() {
        ri.question('Enter the number of any episode to reveal the link> ', async (ans) => {
          const n = parseInt(ans);
          if (isNaN(n) || n < 1 || n > epLinks.length) { ri.close(); return; }
          const label = 'Eps' + String(n).padStart(2, '0');
          await showUrls(label, epLinks[n - 1]);
          loop();
        });
      })();
    } else {
      let _d = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', c => _d += c);
      process.stdin.on('end', async () => {
        const lines = _d.trim().split('\n');
        for (const line of lines) {
          const n = parseInt(line.trim());
          if (isNaN(n) || n < 1 || n > epLinks.length) break;
          const label = 'Eps' + String(n).padStart(2, '0');
          await showUrls(label, epLinks[n - 1]);
        }
      });
    }

  } else {
    const firstUrl = playerUrls.length > 0 ? playerUrls[0] : url;
    const playerHtml = await fetchUrl(firstUrl);
    const urls = decodeM3u8(playerHtml, firstUrl);
    console.log('Link:');
    console.log((urls && urls.length > 0) ? urls[0] : 'ERROR');
  }
  } catch (e) {
    console.error('Error: ' + e.message);
    process.exit(1);
  }
})();
