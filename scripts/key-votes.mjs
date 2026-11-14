// '자주 쓰는 키'(참고 키) 후보 수집 — 카카오 다음 검색 API(블로그·카페·웹문서·동영상).
// 사용: KAKAO_REST_KEY 환경변수 + node scripts/key-mining/key-votes.mjs pilot|full [최대곡수] [시작위치]
// - pilot: 공식 키를 이미 아는 곡에 같은 규칙을 적용해 일치율을 잰다(기준 85%).
// - full: 키가 없는 곡의 후보를 만든다. 결과는 검토용 JSON이며 곡 목록에 자동 반영하지 않는다.
// 원칙: 검색 결과 원문은 저장하지 않고, 규칙으로 뽑은 키와 표 수, 근거 글 주소만 남긴다. AI·LLM에 보내지 않는다.
// 규칙: 글 제목에 곡명이 정확히 들어 있고 키 표기가 하나뿐인 글만 1표. 같은 블로그·카페·채널은 1표.
//       2표 이상이고 전체의 2/3 이상이 같은 키여야 채택.
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const [mode = 'pilot', limitArg, offsetArg] = process.argv.slice(2);
// naver / naver-pilot: 카카오 대신 NAVER API HUB(블로그·카페·웹문서) 검색을 쓴다.
const NAVER = mode.startsWith('naver') || mode.startsWith('page') || mode.startsWith('image');
const KAKAO = process.env.KAKAO_REST_KEY;
if (!NAVER && !KAKAO) { console.error('KAKAO_REST_KEY 가 없습니다.'); process.exit(1); }
if (NAVER && !(process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET)) { console.error('NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 가 없습니다.'); process.exit(1); }
const catalog = JSON.parse(await readFile('targets.json', 'utf8')).works;

const strip = s => (s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const norm = s => strip(s).normalize('NFC').replace(/[\s\-_.,·:;'"“”‘’()[\]{}!?~/|]+/g, '').toLowerCase();
const KEY = '([A-G])(#|b|♭|♯)?(m(?!a))?';
const keyRe = new RegExp(`(?<![A-Za-z가-힣])${KEY}\\s*(?:코드|키|key|Key|KEY|장조|조)(?![A-Za-z])|(?:key|Key|KEY)\\s*[:=]?\\s*${KEY}(?![A-Za-z])|[\\[(]${KEY}[\\])]`, 'g');
const MULTI = /12\s*(key|키|코드|chord)|모든\s*키|키별|전조|(?<![A-Za-z])[A-G][#b♭♯]?(?:\s*[,/·&+]\s*|\s+)[A-G][#b♭♯]?(?![A-Za-z])/i;
function canon(l, acc, minor) {
  let k = l + (acc === '#' || acc === '♯' ? '#' : acc === 'b' || acc === '♭' ? 'b' : '');
  const flat = { 'A#': 'Bb', 'D#': 'Eb', 'G#': 'Ab', 'C#': 'Db', 'F#': 'Gb', Cb: 'B', Fb: 'E', 'E#': 'F', 'B#': 'C' };
  const minorSpell = { 'A#': 'Bb', 'D#': 'Eb', Db: 'C#', Gb: 'F#', Ab: 'G#', Cb: 'B', Fb: 'E', 'E#': 'F', 'B#': 'C' };   // 앱 단조 표기: C#m F#m G#m Ebm Bbm
  if (minor) { if (minorSpell[k]) k = minorSpell[k]; return `${k}m`; }
  if (flat[k]) k = flat[k];
  return k;
}
function keysIn(text) {
  const found = new Set();
  for (const m of text.matchAll(keyRe)) { const g = m.slice(1); const t = g[0] ? g.slice(0, 3) : g[3] ? g.slice(3, 6) : g.slice(6, 9); if (t[0]) found.add(canon(...t)); }
  return [...found];
}
const SALE = /akbotong|akbobada|musicday|mymusic5|mapianist|musicscore|soundleader|akbonara|copydrum|musicnotes|praisecharts/i;
const sameKey = (a, b) => a === b || ({ Gb: 'F#', 'F#': 'Gb', Db: 'C#', 'C#': 'Db' })[a] === b;

let calls = 0;
const NAVER_PATH = { blog: 'blog', cafe: 'cafearticle', web: 'webkr', image: 'image' };
async function naver(kind, query) {
  const url = `https://naverapihub.apigw.ntruss.com/search/v1/${NAVER_PATH[kind]}?display=100&query=${encodeURIComponent(query)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    calls++;
    const res = await fetch(url, { headers: { 'X-NCP-APIGW-API-KEY-ID': process.env.NAVER_CLIENT_ID, 'X-NCP-APIGW-API-KEY': process.env.NAVER_CLIENT_SECRET } });
    if (res.status === 429) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
    if (!res.ok) { const body = (await res.text()).slice(0, 160); throw new Error(`naver ${kind} ${res.status} ${body}`); }
    // 카카오 결과와 같은 모양(title, url, blogname, cafename)으로 맞춘다.
    return ((await res.json()).items || []).map(it => ({ title: it.title, url: it.link, blogname: it.bloggername, cafename: it.cafename, description: it.description }));
  }
  return [];
}
async function kakao(kind, query) {
  if (NAVER) { if (kind === 'vclip') return []; return naver(kind, query); }
  const size = kind === 'vclip' ? 30 : 50;
  const url = `https://dapi.kakao.com/v2/search/${kind}?size=${size}&query=${encodeURIComponent(query)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    calls++;
    const res = await fetch(url, { headers: { Authorization: `KakaoAK ${KAKAO}` } });
    if (res.status === 429) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
    if (!res.ok) { const body = (await res.text()).slice(0, 160); throw new Error(`kakao ${kind} ${res.status} ${body}`); }
    return (await res.json()).documents || [];
  }
  return [];
}
const sourceOf = (kind, d) => kind === 'blog' ? `blog:${d.blogname || new URL(d.url).host}` : kind === 'cafe' ? `cafe:${d.cafename || d.url}` : kind === 'vclip' ? `video:${d.author || d.url}` : `web:${(() => { try { const u = new URL(d.url); return u.host + u.pathname.split('/').slice(0, 2).join('/'); } catch { return d.url; } })()}`;
const hymnNo = w => (JSON.stringify(w.aliases || []) + w.title).match(/(\d{1,3})장/)?.[1];

async function votesFor(work) {
  const title = work.title.trim(); const nt = norm(title);
  if (nt.length < 2) return { votes: {}, evidence: [] };
  const no = work.genre === '찬송가' ? hymnNo(work) : null;
  const artist = (work.arrangements[0]?.artist || '').replace(/\(.*?\)|\[.*?\]/g, '').replace(/새찬송가\d*\s*반주|다니엘 새찬송가|찬송가 \d+장/, '').trim().split(/\s+/)[0] || '';
  const base = no ? `새찬송가 ${no}장 ${title}` : `${title} 악보 코드`;
  // extra(2차): 다른 표현으로 더 찾아 표를 보탠다. 같은 출처는 여전히 1표.
  // video / video-pilot: 동영상(유튜브 등) 제목만 본다. 찬양팀·인도자 영상 제목의 키 표기를 채널당 1표로 센다.
  if (mode.startsWith('video')) return videoVotes(work, title, nt, no);
  if (mode.startsWith('page')) return pageVotes(work, title, nt, artist);
  if (mode.startsWith('image')) return imageVotes(work, title, nt, artist);
  const plan = mode === 'extra' || mode === 'naver'
    ? [[base, ['blog', 'cafe', 'web', 'vclip']], [no ? `찬송가 ${no}장 ${title} 코드` : `${title} ${artist} 코드`.trim(), ['blog', 'cafe', 'vclip']], [no ? `${no}장 ${title} 반주 MR` : `${title} MR 키`, ['blog', 'cafe', 'vclip']]]
    : [[base, ['blog', 'cafe', 'web', 'vclip']]];
  const seen = new Set(); const votes = {}; const evidence = [];
  for (const [q, kinds] of plan) for (const kind of kinds) {
    for (const d of await kakao(kind, q)) {
      const t = strip(d.title);
      if (SALE.test(d.url || '')) continue;   // 악보 판매·유통 사이트는 근거로 쓰지 않는다
      if (!norm(t).includes(nt)) continue;
      if (no && !new RegExp(`(?<!\\d)${no}\\s*장`).test(t)) continue;   // 찬송가는 장 번호까지 일치
      if (MULTI.test(t)) continue;
      const ks = keysIn(t); if (ks.length !== 1) continue;
      const src = sourceOf(kind, d); if (seen.has(src)) continue; seen.add(src);
      const k = ks[0]; votes[k] = (votes[k] || 0) + 1;
      evidence.push({ key: k, kind, url: d.url });
    }
  }
  return { votes, evidence };
}
// 원키가 아닌 표기(키업·여자키·반키 등)는 버린다.
const SHIFTED = /[+-]\s*\d+\s*(키|key)|키\s*(업|다운)|(반|한)\s*키\s*(업|다운|올|내)|남자\s*키|여자\s*키|남키|여키|낮은\s*키|높은\s*키|low\s*key|high\s*key|transpose/i;
async function videoVotes(work, title, nt, no) {
  const qs = no ? [`찬송가 ${no}장 ${title} key`, `${no}장 ${title} 키`] : [`${title} key`, `${title} 키 찬양`, `${title} 찬양 코드`];
  const seen = new Set(); const votes = {}; const evidence = [];
  for (const q of qs) for (const d of await kakao('vclip', q)) {
    const t = strip(d.title);
    if (!norm(t).includes(nt)) continue;
    if (no && !new RegExp(`(?<!\\d)${no}\\s*장`).test(t)) continue;
    if (MULTI.test(t) || SHIFTED.test(t)) continue;
    const ks = keysIn(t); if (ks.length !== 1) continue;
    const src = sourceOf('vclip', d); if (seen.has(src)) continue; seen.add(src);
    const k = ks[0]; votes[k] = (votes[k] || 0) + 1;
    evidence.push({ key: k, kind: 'vclip', url: d.url });
  }
  return { votes, evidence };
}

// page / page-pilot: 검색 결과 글을 직접 열어 곡명이 들어 있는 제목·소제목·이미지 설명·본문 줄의 키 표기를 읽는다.
// 한 글에서 키가 하나로만 나오면 그 글의 사이트(블로그·호스트)에 1표. 원문은 저장하지 않고 키와 주소만 남긴다.
const decodeHtml = s => s.replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
function mobileUrl(u) {
  try { const x = new URL(u);
    if (/(^|\.)blog\.naver\.com$/.test(x.host)) { const m = x.pathname.match(/^\/([^/]+)\/(\d+)/); const id = x.searchParams.get('blogId'), no = x.searchParams.get('logNo'); if (m) return `https://m.blog.naver.com/${m[1]}/${m[2]}`; if (id && no) return `https://m.blog.naver.com/${id}/${no}`; }
    return u; } catch { return u; }
}
async function fetchPage(u) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 9000);
  try { const res = await fetch(mobileUrl(u), { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36', 'Accept-Language': 'ko-KR,ko' } });
    if (!res.ok) return ''; const buf = Buffer.from(await res.arrayBuffer()); if (buf.length > 3e6) return '';
    const head = buf.subarray(0, 2000).toString('latin1'); const cs = /charset=["']?(euc-kr|ks_c_5601|cp949)/i.test(head) ? 'euc-kr' : 'utf-8';
    return new TextDecoder(cs).decode(buf);
  } catch { return ''; } finally { clearTimeout(t); }
}
function pageSignals(html) {
  const out = [];
  const pick = (re, i = 1) => { for (const m of html.matchAll(re)) out.push(decodeHtml(strip(m[i]))); };
  pick(/<title[^>]*>([\s\S]*?)<\/title>/gi);
  pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/gi);
  pick(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi);
  pick(/<img[^>]+alt=["']([^"']{2,200})["']/gi);
  for (const m of html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) { try { out.push(decodeURIComponent(m[1].split('?')[0].split('/').pop()).replace(/\.(jpe?g|png|gif|webp)$/i, '')); } catch {} }
  const body = decodeHtml(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|span)>/gi, '\n').replace(/<[^>]+>/g, ' '));
  for (const line of body.split('\n')) { const l = line.trim(); if (l.length >= 3 && l.length <= 140) out.push(l); }
  return out;
}
async function pageVotes(work, title, nt, artist) {
  const qs = [`${title} 악보`, `${title} ${artist} 코드`.trim()];
  const urls = new Map();
  for (const q of qs) for (const kind of ['blog', 'web']) for (const d of await naver(kind, q)) {
    const t = strip(d.title) + ' ' + strip(d.description || '');
    if (!d.url || SALE.test(d.url) || /cafe\.(naver|daum)/.test(d.url)) continue;
    if (!norm(t).includes(nt)) continue;
    const src = sourceOf(kind, d); if (!urls.has(src) && urls.size < 10) urls.set(src, d.url);
  }
  const votes = {}; const evidence = [];
  for (const [src, url] of urls) {
    const html = await fetchPage(url); if (!html) continue;
    const ks = new Set();
    for (const sig of pageSignals(html)) { if (!norm(sig).includes(nt) || MULTI.test(sig) || SHIFTED.test(sig)) continue; for (const k of keysIn(sig)) ks.add(k); }
    if (ks.size !== 1) continue;
    const k = [...ks][0]; votes[k] = (votes[k] || 0) + 1; evidence.push({ key: k, kind: 'page', url });
  }
  return { votes, evidence };
}
// image / image-pilot: 네이버 이미지 검색 결과 제목의 키 표기를 센다(같은 원본 사이트는 1표).
async function imageVotes(work, title, nt, artist) {
  const seen = new Set(); const votes = {}; const evidence = [];
  for (const q of [`${title} 악보`, `${title} ${artist} 악보 코드`.trim()]) for (const d of await naver('image', q)) {
    const t = strip(d.title);
    if (!d.url || SALE.test(d.url) || !norm(t).includes(nt) || MULTI.test(t) || SHIFTED.test(t)) continue;
    const ks = keysIn(t); if (ks.length !== 1) continue;
    let src; try { const u = new URL(d.url); src = 'img:' + u.host + '/' + (u.pathname.split('/')[1] || ''); } catch { continue; }
    if (seen.has(src)) continue; seen.add(src);
    const k = ks[0]; votes[k] = (votes[k] || 0) + 1; evidence.push({ key: k, kind: 'image', url: d.url });
  }
  return { votes, evidence };
}
function decide(votes) {
  const total = Object.values(votes).reduce((a, b) => a + b, 0);
  const [best, n] = Object.entries(votes).sort((a, b) => b[1] - a[1])[0] || [];
  return best && n >= 2 && n / total >= 2 / 3 ? { key: best, votes: n, total } : null;
}

const verified = catalog.filter(w => w.arrangements.some(a => a.key && a.keyEvidence));
let targets = mode.endsWith('pilot') ? verified : catalog.filter(w => !w.arrangements.some(a => a.key));
if (mode === 'video') { let done = {}; try { done = JSON.parse(await readFile('ops/common-keys.json', 'utf8')).entries; } catch {} targets = catalog.filter(w => !w.arrangements.some(a => a.key && a.keyEvidence) && !w.commonKey && !done[w.id]); }
if (mode === 'naver' || mode === 'page' || mode === 'image') { let done = {}; try { done = JSON.parse(await readFile('ops/common-keys.json', 'utf8')).entries; } catch {} targets = catalog.filter(w => !w.arrangements.some(a => a.key && a.keyEvidence) && !w.commonKey && !done[w.id]); }
if (mode === 'extra') {
  let done = {}; try { done = JSON.parse(await readFile('ops/common-keys.json', 'utf8')).entries; } catch {}
  const priority = JSON.parse(await readFile('scripts/key-mining/priority.json', 'utf8')).ids;
  const rank = new Map(priority.map((id, i) => [id, i]));
  targets = targets.filter(w => !done[w.id]).sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
}
const offset = Number(offsetArg) || 0; const limit = Number(limitArg) || targets.length;
const out = [];
for (const work of targets.slice(offset, offset + limit)) {
  try {
    const { votes, evidence } = await votesFor(work);
    out.push({ id: work.id, title: work.title, genre: work.genre, artist: work.arrangements[0]?.artist, votes, decision: decide(votes), known: work.arrangements.filter(a => a.key && a.keyEvidence).map(a => a.key), evidence: evidence.slice(0, 8) });
  } catch (e) { out.push({ id: work.id, title: work.title, error: String(e.message) }); if (/40[13]/.test(e.message)) break; }
  await new Promise(r => setTimeout(r, 80));
}
const decided = out.filter(r => r.decision);
const summary = { provider: NAVER ? 'naver-api-hub' : 'kakao-daum', mode, offset, searched: out.length, calls, decided: decided.length, coverage: +(decided.length / Math.max(1, out.length)).toFixed(3) };
if (mode.endsWith('pilot')) {
  const correct = decided.filter(r => r.known.some(k => sameKey(k, r.decision.key)));
  Object.assign(summary, { correct: correct.length, precision: +(correct.length / Math.max(1, decided.length)).toFixed(3), mismatches: decided.filter(r => !correct.includes(r)).map(r => ({ title: r.title, known: r.known, got: r.decision, evidence: r.evidence })) });
}
await mkdir('key-mining-out', { recursive: true });
await writeFile(`key-mining-out/${mode}-${offset}-results.json`, JSON.stringify({ summary, results: out }, null, 2));
console.log(JSON.stringify(summary, null, 2));
const errs = out.filter(r => r.error); if (errs.length) console.log('ERRORS', errs.length, errs.slice(0, 3).map(r => r.error).join(' | '));
// 실행 기록에서 바로 검토할 수 있도록 곡별 한 줄 요약(검색 결과 원문 없이 키·표 수·근거 주소만)
for (const r of out) if (r.votes && Object.keys(r.votes).length) console.log(`ROW\t${r.genre}\t${r.title}\t${r.artist || ''}\tknown=${(r.known || []).join('/')}\tvotes=${JSON.stringify(r.votes)}\tpick=${r.decision ? r.decision.key : '-'}\t${r.evidence.map(e => `${e.key}@${e.kind}:${e.url}`).join(' ')}`);
