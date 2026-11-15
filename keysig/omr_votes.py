"""이미지 검색으로 찾은 악보 이미지의 조표를 읽어 '자주 쓰는 키' 후보를 만든다.

사용: python keysig/omr_votes.py pilot|team|keyless [최대곡수] [시작위치] [팀]
 - pilot: 공식 키를 아는 곡으로 정확도를 잰다.
 - team: songs.json 의 팀 곡 전체(팀 이름은 넷째 인자).
 - keyless: 키 없는 곡 전체.
원칙: 이미지는 메모리·임시 파일에서 판독한 뒤 바로 지운다(어디에도 저장하지 않음).
     악보 판매 사이트 미리보기도 키만 읽고 파일은 남기지 않는다.
     채택 규칙: 조표 판독 결과와 악보 위 첫 코드가 같을 때만 그 이미지의 출처(사이트)에 1표.
"""
import json
import os
import re
import sys
import tempfile
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import Counter

sys.path.insert(0, os.path.dirname(__file__))
import keysig  # noqa: E402
import difflib  # noqa: E402
_reader = None


def title_ok(path, nt):
    """악보 윗부분 글자를 읽어 곡 제목이 있는지 본다(글자 인식 오차를 감안해 70% 이상 일치)."""
    global _reader
    import cv2
    if _reader is None:
        import easyocr
        _reader = easyocr.Reader(['ko', 'en'], gpu=False, verbose=False)
    img = keysig.load(path)
    if img is None:
        return False
    h, w = img.shape[:2]
    top = img[:max(80, int(h * 0.2))]
    if w > 1400:
        top = cv2.resize(top, None, fx=1400 / w, fy=1400 / w)
    txt = norm(' '.join(x[1] for x in _reader.readtext(top)))
    if not txt:
        return False
    if nt in txt:
        return True
    m = difflib.SequenceMatcher(None, nt, txt).get_matching_blocks()
    return sum(b.size for b in m) >= max(3, 0.7 * len(nt))


mode = sys.argv[1] if len(sys.argv) > 1 else 'pilot'
limit = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else 10 ** 9
offset = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else 0
team = sys.argv[4] if len(sys.argv) > 4 else ''
NID, NSEC, KAKAO = os.environ.get('NAVER_CLIENT_ID'), os.environ.get('NAVER_CLIENT_SECRET'), os.environ.get('KAKAO_REST_KEY')

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36'
SHIFTED = re.compile(r'[+-]\s*\d+\s*(키|key)|키\s*(업|다운)|(반|한)\s*키\s*(업|다운|올|내)|남자\s*키|여자\s*키|남키|여키|낮은\s*키|높은\s*키|low\s*key|high\s*key|transpose', re.I)
MULTI = re.compile(r'12\s*(key|키|코드|chord)|모든\s*키|키별|전조', re.I)
REL = {'Am': 'C', 'Em': 'G', 'Bm': 'D', 'F#m': 'A', 'C#m': 'E', 'G#m': 'B', 'Dm': 'F', 'Gm': 'Bb', 'Cm': 'Eb', 'Fm': 'Ab', 'Bbm': 'Db', 'Ebm': 'Gb', 'D#m': 'F#', 'A#m': 'C#'}
FLAT = {'A#': 'Bb', 'D#': 'Eb', 'G#': 'Ab', 'C#': 'Db', 'F#': 'Gb'}
calls = 0


def strip(s):
    return re.sub(r'<[^>]+>', '', s or '').replace('&quot;', '"').replace('&amp;', '&').replace('&#39;', "'")


def norm(s):
    return re.sub(r"[\s\-_.,·:;'\"“”‘’()\[\]{}!?~/|]+", '', unicodedata.normalize('NFC', strip(s))).lower()


def same_major(a, b):
    a, b = REL.get(a, a), REL.get(b, b)
    return FLAT.get(a, a) == FLAT.get(b, b)


def get_json(url, headers):
    global calls
    for attempt in range(3):
        calls += 1
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=15) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(1.5 * (attempt + 1))
                continue
            return {}
        except Exception:
            time.sleep(1)
    return {}


def image_search(q):
    out = []
    if NID:
        d = get_json(f'https://naverapihub.apigw.ntruss.com/search/v1/image?display=40&query={urllib.parse.quote(q)}',
                     {'X-NCP-APIGW-API-KEY-ID': NID, 'X-NCP-APIGW-API-KEY': NSEC})
        out += [{'title': strip(i.get('title')), 'img': i.get('link'), 'page': i.get('link')} for i in d.get('items', [])]
    if KAKAO:   # 제목이 없는 결과는 악보 위 제목 글자 인식으로 곡을 확인한다
        d = get_json(f'https://dapi.kakao.com/v2/search/image?size=40&query={urllib.parse.quote(q)}', {'Authorization': f'KakaoAK {KAKAO}'})
        out += [{'title': strip(i.get('display_sitename', '') + ' ' + (i.get('doc_url') or '')), 'img': i.get('image_url'), 'page': i.get('doc_url')} for i in d.get('documents', [])]
    return out


def site_of(u):
    try:
        x = urllib.parse.urlparse(u)
        host = re.sub(r'^(www|m)\.', '', x.netloc)
        first = (x.path.strip('/').split('/') or [''])[0]
        if host.endswith('blog.naver.com') or 'tistory' in host or 'pstatic.net' in host or 'kakaocdn' in host or 'daumcdn' in host:
            return host + '/' + first
        return host
    except Exception:
        return u


def download(url, referer):
    try:
        req = urllib.request.Request(url, headers={'User-Agent': UA, 'Referer': referer or url})
        with urllib.request.urlopen(req, timeout=20) as r:
            data = r.read(8_000_001)
        return data if 20_000 < len(data) <= 8_000_000 else None
    except Exception:
        return None


def song_votes(title, nt):
    votes, evidence, tried = Counter(), [], set()
    cands = []
    for q in (f'{title} 악보', f'{title} 코드 악보'):
        for it in image_search(q):
            if not it['img'] or it['img'] in tried:
                continue
            text = it['title']
            # 네이버 이미지 결과는 제목에 곡명이 있어야 한다. 카카오는 제목이 없어 출처 주소로만 거른다.
            if it['page'] == it['img'] and nt not in norm(text):   # 네이버 결과: 제목에 곡명
                continue
            if SHIFTED.search(text) or MULTI.search(text):
                continue
            tried.add(it['img'])
            cands.append(it)
    seen_sites = set()
    for it in cands[:24]:
        site = site_of(it['page'] or it['img'])
        if site in seen_sites:
            continue
        data = download(it['img'], it['page'])
        if not data:
            continue
        with tempfile.NamedTemporaryFile(suffix='.img', delete=False) as f:
            f.write(data)
            path = f.name
        try:
            key, chord = None, None
            if title_ok(path, nt):
                key, why = keysig.read_key(path)
                chord = keysig.first_chord(path) if key else None
        except Exception:
            key, chord = None, None
        finally:
            os.unlink(path)               # 판독 뒤 바로 지운다
        if key and chord and same_major(key, chord):
            k = chord if chord.endswith('m') and REL.get(chord) and same_major(REL[chord], key) else key
            k = {'Gb': 'F#', 'Cb': 'B', 'C#': 'Db'}.get(k, k)
            votes[k] += 1
            seen_sites.add(site)
            evidence.append({'key': k, 'kind': 'omr', 'url': it['page'] or it['img']})
        if len(seen_sites) >= 6:
            break
    return votes, evidence


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    works = json.load(open(os.path.join(root, 'targets.json'), encoding='utf-8'))['works']
    if mode == 'pilot':
        targets = [w for w in works if w.get('genre') != '찬송가' and any(a.get('keyEvidence') and a.get('key') for a in w['arrangements'])]
    elif mode == 'team':
        songs = json.load(open(os.path.join(root, 'score-collector', 'songs.json'), encoding='utf-8'))['teams'][team]
        ids = {s['id'] for s in songs}
        targets = [w for w in works if w['id'] in ids]
    else:
        targets = [w for w in works if not w.get('commonKey') and not any(a.get('keyEvidence') for a in w['arrangements'])]
    targets = targets[offset:offset + limit]
    os.makedirs('key-mining-out', exist_ok=True)
    rows, ok, decided = [], 0, 0
    for i, w in enumerate(targets):
        title = w['title']
        nt = norm(title)
        votes, ev = song_votes(title, nt)
        known = '/'.join(sorted({a['key'] for a in w['arrangements'] if a.get('keyEvidence') and a.get('key')})) if mode == 'pilot' else ''
        top = votes.most_common(1)[0] if votes else None
        total = sum(votes.values())
        pick = top[0] if top and top[1] >= 2 and top[1] / total >= 2 / 3 else '-'
        artist = (w['arrangements'][0].get('artist') if w['arrangements'] else '') or ''
        evs = ' '.join(f"{e['key']}@omr:{e['url']}" for e in ev[:8])
        if votes:
            print(f"ROW\t{w.get('genre', '')}\t{title}\t{artist}\tknown={known}\tvotes={json.dumps(dict(votes))}\tpick={pick}\t{evs}", flush=True)
        best = top[0] if top else ''
        if mode == 'pilot' and best:
            decided += 1
            ok += any(same_major(best, k) for k in known.split('/'))
        rows.append({'id': w['id'], 'title': title, 'votes': dict(votes), 'evidence': ev})
    json.dump(rows, open(f'key-mining-out/omr-{mode}-{offset}.json', 'w'), ensure_ascii=False)
    summary = {'mode': mode, 'searched': len(targets), 'calls': calls, 'decided': decided}
    if mode == 'pilot':
        summary['precision'] = round(ok / max(1, decided), 3)
        summary['coverage'] = round(decided / max(1, len(targets)), 3)
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    main()
