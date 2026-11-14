// CAL콘티메이커 · 팀별 대표 악보 모음 수집기 (목사님 PC에서 실행)
// 사용:  node collect-scores.mjs 올네이션스            (전체)
//        node collect-scores.mjs 올네이션스 --limit 20  (시험)
// 준비:  같은 폴더의 naver-keys.txt 에 두 줄을 넣는다.
//          NAVER_CLIENT_ID=...
//          NAVER_CLIENT_SECRET=...
// 결과:  바탕화면\<팀> 악보 모음\ 폴더에 악보 파일과 목록(CSV 4개, 자료 안내.txt)
// 규칙:  네이버 블로그·웹문서 검색 → 결과 글을 열어 곡명과 함께 적힌 키 표기를 센다(같은 사이트 1표).
//        가장 많이 나온 키를 고르고, 그 키의 악보 이미지(또는 PDF)를 원본 크기로 받는다.
//        악보 판매·유통 사이트와 로그인이 필요한 카페 글은 쓰지 않는다. 다시 실행하면 끝난 곡은 건너뛴다.
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const team = args.find(a => !a.startsWith('--'));
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const limit = Number(opt('limit', 0)) || Infinity;
const DRY = args.includes('--dry');                      // 파일을 받지 않고 키 판단만 (점검용)
if (!team) { console.log('사용: node collect-scores.mjs <팀이름> [--limit 20]'); process.exit(1); }

// ── 네이버 키 ──
let ID = process.env.NAVER_CLIENT_ID, SECRET = process.env.NAVER_CLIENT_SECRET;
try {
  const txt = await readFile(join(here, 'naver-keys.txt'), 'utf8');
  for (const line of txt.split(/\r?\n/)) { const m = line.match(/^\s*(NAVER_CLIENT_ID|NAVER_CLIENT_SECRET)\s*=\s*(\S+)/); if (m) m[1] === 'NAVER_CLIENT_ID' ? ID = m[2] : SECRET = m[2]; }
} catch {}
if (!ID || !SECRET) { console.log('naver-keys.txt 에 NAVER_CLIENT_ID 와 NAVER_CLIENT_SECRET 을 넣어 주세요.'); process.exit(1); }

// ── 곡 목록 ──
const songsFile = JSON.parse(await readFile(join(here, 'songs.json'), 'utf8'));
const songs = songsFile.teams[team];
if (!songs) { console.log(`songs.json 에 '${team}' 팀이 없습니다. 있는 팀: ${Object.keys(songsFile.teams).join(', ')}`); process.exit(1); }
const outDir = opt('out', join(homedir(), 'Desktop', `${team} 악보 모음`));
await mkdir(outDir, { recursive: true });
const stateFile = join(outDir, '.수집상태.json');
let state = {}; try { state = JSON.parse(await readFile(stateFile, 'utf8')); } catch {}

// ── 키 판독 규칙 (앱 수집기와 같은 규칙) ──
const strip = s => (s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const decodeHtml = s => s.replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
const norm = s => strip(s).normalize('NFC').replace(/[\s\-_.,·:;'"“”‘’()[\]{}!?~/|]+/g, '').toLowerCase();
const KEY = '([A-G])(#|b|♭|♯)?(m(?!a))?';
const keyRe = new RegExp(`(?<![A-Za-z가-힣])${KEY}\\s*(?:코드|키|key|Key|KEY|장조|조)(?![A-Za-z])|(?:key|Key|KEY)\\s*[:=]?\\s*${KEY}(?![A-Za-z])|[\\[(]${KEY}[\\])]|_${KEY}(?=\\.|_\\d|$)`, 'g');
const MULTI = /12\s*(key|키|코드|chord)|모든\s*키|키별|전조|(?<![A-Za-z])[A-G][#b♭♯]?(?:\s*[,/·&+]\s*|\s+)[A-G][#b♭♯]?(?![A-Za-z])/i;
const SHIFTED = /[+-]\s*\d+\s*(키|key)|키\s*(업|다운)|(반|한)\s*키\s*(업|다운|올|내)|남자\s*키|여자\s*키|남키|여키|낮은\s*키|높은\s*키|low\s*key|high\s*key|transpose/i;
const SALE = /akbotong|akbobada|musicday|mymusic5|mapianist|musicscore|soundleader|akbonara|copydrum|musicnotes|praisecharts|musictok|akbo\.|sheetmusic/i;
function canon(l, acc, minor) {
  let k = l + (acc === '#' || acc === '♯' ? '#' : acc === 'b' || acc === '♭' ? 'b' : '');
  const flat = { 'A#': 'Bb', 'D#': 'Eb', 'G#': 'Ab', 'C#': 'Db', 'F#': 'Gb', Cb: 'B', Fb: 'E', 'E#': 'F', 'B#': 'C' };
  const minorSpell = { 'A#': 'Bb', 'D#': 'Eb', Db: 'C#', Gb: 'F#', Ab: 'G#', Cb: 'B', Fb: 'E', 'E#': 'F', 'B#': 'C' };
  if (minor) { if (minorSpell[k]) k = minorSpell[k]; return `${k}m`; }
  return flat[k] || k;
}
function keysIn(text) {
  const found = new Set();
  for (const m of text.matchAll(keyRe)) { const g = m.slice(1); for (let i = 0; i < g.length; i += 3) if (g[i]) { found.add(canon(g[i], g[i + 1], g[i + 2])); break; } }
  return [...found];
}

// ── 네트워크 ──
const sleep = ms => new Promise(r => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
let calls = 0;
async function naver(kind, query) {
  const path = { blog: 'blog', web: 'webkr' }[kind];
  for (let a = 0; a < 3; a++) {
    calls++;
    try {
      const res = await fetch(`https://naverapihub.apigw.ntruss.com/search/v1/${path}?display=50&query=${encodeURIComponent(query)}`, { headers: { 'X-NCP-APIGW-API-KEY-ID': ID, 'X-NCP-APIGW-API-KEY': SECRET } });
      if (res.status === 429) { await sleep(1500 * (a + 1)); continue; }
      if (!res.ok) { console.log(`  네이버 검색 오류 ${res.status} ${(await res.text()).slice(0, 120)}`); return []; }
      return ((await res.json()).items || []).map(it => ({ title: strip(it.title), url: it.link, description: strip(it.description), blog: it.bloggerlink }));
    } catch (e) { await sleep(1000); }
  }
  return [];
}
function mobileUrl(u) {
  try { const x = new URL(u);
    if (/(^|\.)blog\.naver\.com$/.test(x.host)) { const m = x.pathname.match(/^\/([^/]+)\/(\d+)/); const id = x.searchParams.get('blogId'), no = x.searchParams.get('logNo'); if (m) return `https://m.blog.naver.com/${m[1]}/${m[2]}`; if (id && no) return `https://m.blog.naver.com/${id}/${no}`; }
    return u; } catch { return u; }
}
async function get(url, { referer, binary = false, timeout = 15000 } = {}) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko', ...(referer ? { Referer: referer } : {}) } });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (binary) return { buf, type: res.headers.get('content-type') || '' };
    if (buf.length > 4e6) return null;
    const head = buf.subarray(0, 3000).toString('latin1');
    return new TextDecoder(/charset=["']?(euc-kr|ks_c_5601|cp949)/i.test(head) ? 'euc-kr' : 'utf-8').decode(buf);
  } catch { return null; } finally { clearTimeout(t); }
}
const siteOf = u => { try { const x = new URL(u); if (/blog\.naver\.com$/.test(x.host)) return 'naver:' + (x.pathname.split('/')[1] || x.searchParams.get('blogId')); return x.host.replace(/^(www|m)\./, ''); } catch { return u; } };

// ── 글 분석: 키 신호와 악보 후보 ──
function pageInfo(html, base) {
  const sig = [];
  const pick = re => { for (const m of html.matchAll(re)) sig.push(decodeHtml(strip(m[1]))); };
  pick(/<title[^>]*>([\s\S]*?)<\/title>/gi);
  pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/gi);
  pick(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi);
  pick(/<img[^>]+alt=["']([^"']{2,200})["']/gi);
  const body = decodeHtml(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|span)>/gi, '\n').replace(/<[^>]+>/g, ' '));
  for (const l of body.split('\n')) { const s = l.trim(); if (s.length >= 3 && s.length <= 140) sig.push(s); }
  // 악보 후보: 본문 이미지 원본 주소와 PDF 링크
  const files = [];
  const add = (u, name) => { try { const abs = new URL(decodeHtml(u), base).href; if (!files.some(f => f.url === abs)) files.push({ url: abs, name }); } catch {} };
  for (const m of html.matchAll(/<img[^>]*>/gi)) {
    const tag = m[0];
    const src = (tag.match(/data-lazy-src=["']([^"']+)/i) || tag.match(/data-src=["']([^"']+)/i) || tag.match(/data-url=["']([^"']+)/i) || tag.match(/\ssrc=["']([^"']+)/i) || [])[1];
    if (!src || /^data:/.test(src)) continue;
    if (!/postfiles\.pstatic\.net|blogfiles\.pstatic\.net|mblogthumb-phinf\.pstatic\.net|kakaocdn\.net\/dn|daumcdn\.net\/cfile|tistory\.com\/attach|\/upload|\/wp-content\/uploads|\/files?\//i.test(src)) continue;
    if (/profile|emoticon|sticker|icon|logo|banner|btn_|thumb_\d+x\d+/i.test(src)) continue;
    const alt = (tag.match(/alt=["']([^"']*)/i) || [])[1] || '';
    add(src, alt);
  }
  for (const m of html.matchAll(/href=["']([^"']+\.pdf(\?[^"']*)?)["']/gi)) add(m[1], 'pdf');
  return { sig, files };
}
function originalUrl(u) {
  try { const x = new URL(u);
    if (/pstatic\.net$/.test(x.host)) { x.host = x.host.replace('mblogthumb-phinf', 'blogfiles'); x.searchParams.set('type', 'w966'); return x.href.replace('blogfiles.pstatic.net', 'postfiles.pstatic.net'); }
    if (/kakaocdn\.net$/.test(x.host) && x.searchParams.get('fname')) return decodeURIComponent(x.searchParams.get('fname'));
    if (/daumcdn\.net$/.test(x.host) && x.searchParams.get('fname')) return decodeURIComponent(x.searchParams.get('fname'));
    return u; } catch { return u; }
}
function imageSize(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  if (buf[0] === 0x47 && buf[1] === 0x49) return [buf.readUInt16LE(6), buf.readUInt16LE(8)];
  if (buf[0] === 0xff && buf[1] === 0xd8) { let i = 2; while (i < buf.length - 9) { if (buf[i] !== 0xff) { i++; continue; } const mk = buf[i + 1]; const len = buf.readUInt16BE(i + 2); if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)]; i += 2 + len; } }
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') { const c = buf.subarray(12, 16).toString(); if (c === 'VP8X') return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)]; if (c === 'VP8 ') return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff]; if (c === 'VP8L') { const b = buf.readUInt32LE(21); return [1 + (b & 0x3fff), 1 + ((b >> 14) & 0x3fff)]; } }
  return null;
}
const extOf = (type, buf) => buf.subarray(0, 4).toString() === '%PDF' ? 'pdf' : buf[0] === 0x89 ? 'png' : buf[0] === 0x47 ? 'gif' : buf.subarray(8, 12).toString() === 'WEBP' ? 'webp' : buf[0] === 0xff ? 'jpg' : null;
const safe = s => s.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

// ── 곡 하나 처리 ──
async function processSong(song) {
  const names = [song.title, ...(song.aliases || []).filter(a => !/^새찬송가/.test(a))].slice(0, 3);
  const nts = names.map(norm).filter(n => n.length >= 2);
  const results = new Map();               // site → url (첫 번째 글)
  for (const name of names.slice(0, 2)) {
    for (const q of [`${name} 악보`, `${name} ${team} 코드`]) for (const kind of ['blog', 'web']) for (const d of await naver(kind, q)) {
      if (!d.url || SALE.test(d.url) || /cafe\.(naver|daum)\.net|cafe\.naver\.com|youtube|instagram|facebook/.test(d.url)) continue;
      if (!nts.some(n => norm(d.title + ' ' + d.description).includes(n))) continue;
      const site = siteOf(d.url); if (!results.has(site) && results.size < 14) results.set(site, { url: d.url, title: d.title });
    }
  }
  const votes = {}; const pages = [];
  for (const [site, r] of results) {
    const url = mobileUrl(r.url); const html = await get(url); await sleep(250);
    if (!html) { pages.push({ site, url: r.url, title: r.title, status: '열기 실패' }); continue; }
    const { sig, files } = pageInfo(html, url);
    const ks = new Set();
    for (const s of sig) { if (!nts.some(n => norm(s).includes(n)) || MULTI.test(s) || SHIFTED.test(s)) continue; for (const k of keysIn(s)) ks.add(k); }
    for (const f of files) { const fn = decodeURIComponent((f.url.split('/').pop() || '').split('?')[0]); if (nts.some(n => norm(fn).includes(n)) && !MULTI.test(fn) && !SHIFTED.test(fn)) for (const k of keysIn(fn)) ks.add(k); }
    const key = ks.size === 1 ? [...ks][0] : null;
    pages.push({ site, url: r.url, pageUrl: url, title: r.title, key, files, status: key ? '키 확인' : ks.size > 1 ? '키 여러 개' : '키 표기 없음' });
    if (key) votes[key] = (votes[key] || 0) + 1;
  }
  const ranked = Object.entries(votes).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { song, votes, pages, reason: results.size ? '키가 적힌 무료 악보 글을 찾지 못함' : '검색 결과 없음' };
  const top = ranked[0][1]; const tied = ranked.filter(([, v]) => v === top).map(([k]) => k);
  // 동점이면 실제로 악보 파일을 받을 수 있는 키 → 그래도 같으면 가나다(알파벳)순
  const order = [...tied].sort();
  for (const key of order) {
    for (const p of pages.filter(p => p.key === key && p.files.length)) {
      if (DRY) return { song, votes, pages, key, tied, reasonPick: tied.length > 1 ? '동률: 받을 수 있는 키 중 알파벳순' : '독립 출처에서 가장 많이 확인된 키', saved: [], source: p.url };
      const saved = [];
      for (const f of p.files.slice(0, 8)) {
        const got = await get(originalUrl(f.url), { referer: p.pageUrl, binary: true, timeout: 30000 }) || await get(f.url, { referer: p.pageUrl, binary: true, timeout: 30000 });
        await sleep(200);
        if (!got || got.buf.length < 30000) continue;
        const ext = extOf(got.type, got.buf); if (!ext) continue;
        if (ext !== 'pdf') { const sz = imageSize(got.buf); if (sz && (sz[0] < 500 || sz[1] < 500)) continue; }
        const sha = createHash('sha256').update(got.buf).digest('hex');
        if (saved.some(s => s.sha === sha)) continue;
        saved.push({ buf: got.buf, ext, sha, url: f.url });
        if (saved.length >= 4) break;
      }
      if (!saved.length) continue;
      const base = `${safe(song.title)}_${key}`;
      const files = [];
      for (let i = 0; i < saved.length; i++) {
        const name = saved.length > 1 ? `${base}_${String(i + 1).padStart(2, '0')}.${saved[i].ext}` : `${base}.${saved[i].ext}`;
        await writeFile(join(outDir, name), saved[i].buf);
        files.push({ name, bytes: saved[i].buf.length, sha: saved[i].sha });
      }
      return { song, votes, pages, key, tied, reasonPick: tied.length > 1 ? '확인 출처 수 동률: 원본 파일을 받을 수 있는 키 중 알파벳순' : '독립 출처에서 가장 많이 확인된 키', saved: files, source: p.url };
    }
  }
  return { song, votes, pages, reason: '키는 확인했으나 받을 수 있는 원본 악보 파일이 없음' };
}

// ── 목록 파일 ──
const csv = rows => '﻿' + rows.map(r => r.map(v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\r\n') + '\r\n';
async function writeLists() {
  const done = Object.values(state);
  const ok = done.filter(r => r.saved?.length || (DRY && r.key));
  await writeFile(join(outDir, '곡별 목록과 키 선택 근거.csv'), csv([['곡명', '선택키', '파일수', '파일명', '키별독립출처수_게시물기재기준', '선택사유', '실물검토메모', '출처'],
    ...ok.map(r => [r.title, r.key, r.saved?.length || 0, (r.saved || []).map(f => f.name).join(' | '), JSON.stringify(r.votes), r.reasonPick, '', r.source])]));
  await writeFile(join(outDir, '미수집 곡과 사유.csv'), csv([['곡명', '사유', '확인된키_게시물기재기준', '유료또는구독참고링크'], ...done.filter(r => !ok.includes(r)).map(r => [r.title, r.reason, JSON.stringify(r.votes || {}), ''])]));
  await writeFile(join(outDir, '파일 검증 목록.csv'), csv([['곡명', '선택키', '파일명', '바이트', 'SHA256', '출처'], ...ok.flatMap(r => (r.saved || []).map(f => [r.title, r.key, f.name, f.bytes, f.sha, r.source]))]));
  await writeFile(join(outDir, '조사한 출처 목록.csv'), csv([['URL', '페이지제목', '확인상태', '확인키_게시물기재기준', '연결후보곡'], ...done.flatMap(r => (r.pages || []).map(p => [p.url, p.title, p.status, p.key || '', r.title]))]));
  const files = ok.reduce((a, r) => a + (r.saved?.length || 0), 0), bytes = ok.reduce((a, r) => a + (r.saved || []).reduce((b, f) => b + f.bytes, 0), 0);
  await writeFile(join(outDir, '자료 안내.txt'), `﻿${team} 대표 악보 모음\r\n정리일: ${new Date().toISOString().slice(0, 10)}\r\n\r\n수집 결과: ${ok.length}곡 / 악보 파일 ${files}개 / ${bytes.toLocaleString()}바이트 (대상 ${songs.length}곡 중 ${done.length}곡 조사)\r\n\r\n조사 범위\r\n- CAL콘티메이커 곡 목록의 ${team} 곡(한글·영문 제목과 별칭)\r\n- 네이버 블로그·웹문서 검색에서 찾은 공개 악보 글. 인터넷 전체를 망라했다는 뜻은 아닙니다.\r\n- 악보 판매·유통 사이트, 로그인이 필요한 카페 글은 제외했습니다.\r\n\r\n키 선택\r\n- 실제로 열어 본 글에서 곡명과 함께 적힌 키 표기를 집계했습니다. 한 사이트(블로그)의 같은 곡은 한 번만 셌습니다.\r\n- 키 변환본(키업·여자키 등)과 여러 키가 함께 적힌 글은 세지 않았습니다.\r\n- 가장 많이 확인된 키를 고르고, 동률이면 원본 파일을 받을 수 있는 키 중 알파벳순으로 골랐습니다.\r\n- 파일 이름의 키는 게시물 표기 기준입니다. 실물 조표와 다른 경우 검토 메모에 남깁니다.\r\n\r\n이용 안내\r\n- 이 폴더의 악보는 개인 확인용입니다. 저작권은 각 곡의 저작권자에게 있으며, 다시 게시하거나 배포하지 않습니다.\r\n`);
}

// ── 실행 ──
const todo = songs.filter(s => !state[s.id]).slice(0, limit);
console.log(`${team}: 전체 ${songs.length}곡, 이미 끝남 ${Object.keys(state).length}곡, 이번 ${todo.length}곡 → ${outDir}`);
let n = 0;
for (const song of todo) {
  n++;
  let r;
  try { r = await processSong(song); } catch (e) { r = { song, reason: '처리 오류: ' + e.message }; }
  state[song.id] = { title: song.title, key: r.key, votes: r.votes || {}, reasonPick: r.reasonPick, reason: r.reason, saved: r.saved, source: r.source, pages: (r.pages || []).map(p => ({ url: p.url, title: p.title, status: p.status, key: p.key })) };
  console.log(`[${n}/${todo.length}] ${song.title} → ${r.saved?.length ? `${r.key} · 파일 ${r.saved.length}개` : r.key && DRY ? `${r.key} (점검)` : r.reason}`);
  await writeFile(stateFile, JSON.stringify(state));
  if (n % 10 === 0) await writeLists();
}
await writeLists();
const ok = Object.values(state).filter(r => r.saved?.length).length;
console.log(`\n끝: ${ok}곡 받음 / 조사 ${Object.keys(state).length}곡 / 검색 ${calls}회. 폴더: ${outDir}`);
