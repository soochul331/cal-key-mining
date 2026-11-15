// 코드(키)별 찬양 모음 글에서 곡 목록을 읽어 '자주 쓰는 키' 후보를 만든다.
// 사용: node scripts/listkeys.mjs <키들(쉼표)> [검색 쪽수]
//   예) node scripts/listkeys.mjs D,E 3
// 방식: "D코드 찬양 모음" 같은 검색 → 글 제목에 키가 하나만 적힌 글을 연다 → 본문 줄 가운데 앱 곡 제목과
//       똑같은 줄(번호·기호 정리 후)을 찾는다 → 한 글에서 3곡 이상 맞으면 '키별 목록 글'로 보고 그 사이트에 1표.
//       출력: HIT 줄(곡ID, 키, 사이트, 주소). 원문은 저장하지 않는다.
import { readFile, mkdir, writeFile } from 'node:fs/promises';

const keysArg = (process.argv[2] || 'D').split(',');
const pagesPerQuery = Number(process.argv[3] || 3);
const ID = process.env.NAVER_CLIENT_ID, SECRET = process.env.NAVER_CLIENT_SECRET, KAKAO = process.env.KAKAO_REST_KEY;
const works = JSON.parse(await readFile('targets.json', 'utf8')).works;

const strip = s => (s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const decodeHtml = s => s.replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
const norm = s => strip(s).normalize('NFC').replace(/\([^)]*\)/g, '').replace(/[\s\-_.,·:;'"“”‘’()[\]{}!?~/|♬♪★☆♡♥*#]+/g, '').toLowerCase();

// 곡 제목 색인(제목·별칭). 너무 짧거나 흔한 제목은 오탐이 많아 4글자 이상만.
const idx = new Map();
for (const w of works) for (const t of [w.title, ...(w.aliases || [])]) {
  if (/^새찬송가/.test(t)) continue;
  const n = norm(t); if (n.length < 4) continue;
  idx.set(n, [...new Set([...(idx.get(n) || []), w.id])]);
}

const KEY = '([A-G])(#|b|♭|♯)?(m(?!a))?';
const keyRe = new RegExp(`(?<![A-Za-z가-힣])${KEY}\\s*(?:코드|키|key|Key|KEY|장조)(?![A-Za-z])|(?:key|Key|KEY)\\s*[:=]?\\s*${KEY}(?![A-Za-z])|[\\[(]${KEY}[\\])]`, 'g');
const MULTI = /12\s*(key|키|코드)|모든\s*키|키별|전조|코드별|키\s*변환/i;
const SHIFTED = /[+-]\s*\d+\s*(키|key)|키\s*(업|다운)|남자\s*키|여자\s*키|transpose/i;
const SALE = /akbotong|akbobada|musicday|mymusic5|mapianist|musicscore|soundleader|akbonara|copydrum|musicnotes|praisecharts|musictok/i;
function canon(l, acc, minor) {
  let k = l + (acc === '#' || acc === '♯' ? '#' : acc === 'b' || acc === '♭' ? 'b' : '');
  const flat = { 'A#': 'Bb', 'D#': 'Eb', 'G#': 'Ab', 'C#': 'Db', 'F#': 'Gb', Cb: 'B', Fb: 'E', 'E#': 'F', 'B#': 'C' };
  const minorSpell = { 'A#': 'Bb', 'D#': 'Eb', Db: 'C#', Gb: 'F#', Ab: 'G#' };
  if (minor) return `${minorSpell[k] || k}m`;
  return flat[k] || k;
}
function keysIn(text) {
  const found = new Set();
  for (const m of text.matchAll(keyRe)) { const g = m.slice(1); for (let i = 0; i < g.length; i += 3) if (g[i]) { found.add(canon(g[i], g[i + 1], g[i + 2])); break; } }
  return [...found];
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let calls = 0;
async function naver(kind, q, start) {
  for (let a = 0; a < 3; a++) {
    calls++;
    try {
      const res = await fetch(`https://naverapihub.apigw.ntruss.com/search/v1/${kind}?display=100&start=${start}&query=${encodeURIComponent(q)}`, { headers: { 'X-NCP-APIGW-API-KEY-ID': ID, 'X-NCP-APIGW-API-KEY': SECRET } });
      if (res.status === 429) { await sleep(1500 * (a + 1)); continue; }
      if (!res.ok) return [];
      return ((await res.json()).items || []).map(i => ({ title: strip(i.title), url: i.link }));
    } catch { await sleep(1000); }
  }
  return [];
}
async function kakao(kind, q, page) {
  if (!KAKAO) return [];
  for (let a = 0; a < 3; a++) {
    calls++;
    try {
      const res = await fetch(`https://dapi.kakao.com/v2/search/${kind}?size=50&page=${page}&query=${encodeURIComponent(q)}`, { headers: { Authorization: `KakaoAK ${KAKAO}` } });
      if (res.status === 429) { await sleep(2000 * (a + 1)); continue; }
      if (!res.ok) return [];
      return ((await res.json()).documents || []).map(d => ({ title: strip(d.title), url: d.url }));
    } catch { await sleep(1000); }
  }
  return [];
}
function mobileUrl(u) {
  try { const x = new URL(u);
    if (/(^|\.)blog\.naver\.com$/.test(x.host)) { const m = x.pathname.match(/^\/([^/]+)\/(\d+)/); const id = x.searchParams.get('blogId'), no = x.searchParams.get('logNo'); if (m) return `https://m.blog.naver.com/${m[1]}/${m[2]}`; if (id && no) return `https://m.blog.naver.com/${id}/${no}`; }
    return u; } catch { return u; }
}
const siteOf = u => { try { const x = new URL(u); if (/blog\.naver\.com$/.test(x.host)) return 'naver:' + (x.pathname.split('/')[1] || x.searchParams.get('blogId')); return x.host.replace(/^(www|m)\./, ''); } catch { return u; } };
async function fetchPage(u) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(mobileUrl(u), { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36', 'Accept-Language': 'ko-KR,ko' } });
    if (!res.ok) return ''; const buf = Buffer.from(await res.arrayBuffer()); if (buf.length > 4e6) return '';
    const head = buf.subarray(0, 3000).toString('latin1');
    return new TextDecoder(/charset=["']?(euc-kr|ks_c_5601|cp949)/i.test(head) ? 'euc-kr' : 'utf-8').decode(buf);
  } catch { return ''; } finally { clearTimeout(t); }
}

const hits = []; const seenUrl = new Set(); let pagesOpened = 0, listPages = 0;
for (const label of keysArg) {
  const K = keysIn(`${label}코드`)[0];   // 앱 표기(F#→Gb 등)
  const queries = [`${label}코드 찬양`, `${label}코드 찬양 모음`, `${label}코드 찬양 악보 모음`, `${label}키 찬양 모음`, `${label}코드 찬양 리스트`, `${label}코드 찬양 콘티`];
  const cands = [];
  for (const q of queries) {
    for (let p = 0; p < pagesPerQuery; p++) {
      for (const kind of ['blog', 'webkr']) cands.push(...await naver(kind, q, 1 + p * 100));
      for (const kind of ['blog', 'web']) cands.push(...await kakao(kind, q, p + 1));
    }
  }
  let n = 0;
  for (const c of cands) {
    if (!c.url || seenUrl.has(c.url) || SALE.test(c.url) || /cafe\.(naver|daum)/.test(c.url)) continue;
    const ks = keysIn(c.title);
    if (ks.length !== 1 || ks[0] !== K || MULTI.test(c.title) || SHIFTED.test(c.title)) continue;
    seenUrl.add(c.url);
    const html = await fetchPage(c.url); pagesOpened++; await sleep(150);
    if (!html) continue;
    const body = decodeHtml(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|span|h\d|td|tr)>/gi, '\n').replace(/<[^>]+>/g, ' '));
    const found = new Map();
    for (const raw of body.split('\n')) {
      let line = raw.trim(); if (!line || line.length > 60) continue;
      const lk = keysIn(line); if (lk.length && !(lk.length === 1 && lk[0] === K)) continue;     // 다른 키가 적힌 줄은 건너뜀
      line = line.replace(/^\s*(\d{1,3}|[①-⑳])\s*[.)\]:-]?\s*/, '').replace(new RegExp(`\\s*[\\[(]?${label.replace('#', '\\#')}\\s*(코드|키)?[\\])]?\\s*$`), '');
      const ids = idx.get(norm(line)); if (ids && ids.length === 1) found.set(ids[0], line);
    }
    if (found.size < 3) continue;
    listPages++; n++;
    const site = siteOf(c.url);
    for (const id of found.keys()) hits.push({ id, key: K, site, url: c.url });
  }
  console.log(`KEY ${K}: 후보 글 ${cands.length}, 목록 글 ${n}`);
}
for (const h of hits) console.log(`HIT\t${h.id}\t${h.key}\t${h.site}\t${h.url}`);
await mkdir('key-mining-out', { recursive: true });
await writeFile(`key-mining-out/listkeys-${keysArg.join('_').replace(/#/g, 's')}.json`, JSON.stringify(hits));
console.log(JSON.stringify({ keys: keysArg, calls, pagesOpened, listPages, hits: hits.length, songs: new Set(hits.map(h => h.id)).size }));
