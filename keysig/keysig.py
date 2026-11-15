"""악보 이미지의 조표(첫머리 샵·플랫 개수)로 키를 읽는다.

사용: python keysig.py 이미지 [이미지...]   → 줄마다 "파일\t키\t근거" (판독 못 하면 키 자리에 '-')
방식: 오선(5줄)을 찾고, 높은음자리표 뒤에서 오선 안쪽에 일정한 간격으로 놓인 샵/플랫 기호를 센다.
     여러 단의 결과가 일치할 때만 키를 정한다. 장조 기준(같은 조표의 단조는 따로 판단).
"""
import sys
import cv2
import numpy as np

MODE = 'pos'
SHARP_KEYS = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#']
FLAT_KEYS = ['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb']


def load(path):
    data = np.fromfile(path, dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_UNCHANGED)
    if img is None:
        cap = cv2.VideoCapture(path)  # gif
        ok, img = cap.read()
        if not ok:
            return None
    if img.ndim == 3 and img.shape[2] == 4:  # 투명 배경 → 흰색
        a = img[:, :, 3:4].astype(np.float32) / 255
        img = (img[:, :, :3] * a + 255 * (1 - a)).astype(np.uint8)
    if img.ndim == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return img


def find_staves(ink):
    h, w = ink.shape
    # 줄마다 가장 긴 가로 잉크 구간
    longest = np.zeros(h, dtype=np.int32)
    starts = np.zeros(h, dtype=np.int32)
    for y in range(h):
        row = ink[y]
        if row.sum() < w * 0.15:
            continue
        d = np.diff(np.concatenate(([0], row.astype(np.int8), [0])))
        s = np.where(d == 1)[0]
        e = np.where(d == -1)[0]
        if len(s):
            i = np.argmax(e - s)
            longest[y] = e[i] - s[i]
            starts[y] = s[i]
    rows = np.where(longest > w * 0.3)[0]
    lines = []
    for y in rows:
        if lines and y - lines[-1][-1] <= 1:
            lines[-1].append(y)
        else:
            lines.append([y])
    centers = [(np.mean(l), int(np.min(starts[l])), max(1, len(l))) for l in lines]
    staves = []
    i = 0
    while i + 4 < len(centers):
        ys = [c[0] for c in centers[i:i + 5]]
        gaps = np.diff(ys)
        g = np.median(gaps)
        if g >= 4 and np.all(np.abs(gaps - g) <= max(1.5, g * 0.2)):
            staves.append({'top': ys[0], 'bottom': ys[4], 's': g, 'x0': min(c[1] for c in centers[i:i + 5]),
                           'thick': int(round(np.median([c[2] for c in centers[i:i + 5]])))})
            i += 5
        else:
            i += 1
    return staves


def classify(comp, s):
    """잉크 덩어리 하나가 샵(#)인지 플랫(b)인지. 아니면 None."""
    h, w = comp.shape
    if not (1.7 * s <= h <= 3.8 * s and 0.45 * s <= w <= 1.7 * s):
        return None
    upper = comp[: h // 2].sum()
    lower = comp[h // 2:].sum()
    ratio = upper / max(1, lower)
    cols = comp.sum(axis=0) / h
    tall_cols = cols > 0.55          # 세로획
    # 세로획 개수(연속 구간)
    d = np.diff(np.concatenate(([0], tall_cols.astype(np.int8), [0])))
    strokes = int((d == 1).sum())
    if strokes >= 2 and 0.7 <= ratio <= 1.45 and w >= 0.7 * s:
        return '#'
    if strokes >= 1 and ratio < 0.75 and w <= 1.3 * s:
        return 'b'
    return None


def read_staff(ink, st):
    s, top, bottom = st['s'], st['top'], st['bottom']
    y0 = int(max(0, top - 2.8 * s))
    y1 = int(min(ink.shape[0], bottom + 2.2 * s))
    x0 = max(0, st['x0'] - 2)
    x1 = int(min(ink.shape[1], x0 + 14 * s))
    band = ink[y0:y1, x0:x1].copy()
    raw = band.copy()
    # 오선 지우기: 줄 위치에서 세로 잉크 길이가 줄 두께 정도인 부분만 지운다(기호가 지나가는 곳은 남김)
    th = max(1, st['thick'])
    line_ys = [int(round(top + k * s - y0)) for k in range(5)]
    H = band.shape[0]
    for ly in line_ys:
        a0, a1 = max(0, ly - th - 1), min(H, ly + th + 2)
        for x in range(band.shape[1]):
            col = band[:, x]
            if not col[a0:a1].any():
                continue
            # 줄 근처에서 시작하는 세로 잉크 구간의 위·아래 끝
            ys = np.where(col[a0:a1])[0] + a0
            u = ys[0]
            while u > 0 and col[u - 1]:
                u -= 1
            d = ys[-1]
            while d < H - 1 and col[d + 1]:
                d += 1
            if d - u + 1 <= th + 2:
                band[u:d + 1, x] = 0
    n, lab, stats, _ = cv2.connectedComponentsWithStats(band, 8)
    boxes = [stats[i] for i in range(1, n) if stats[i][4] >= max(6, s * s * 0.04)]
    # 가로로 겹치는 조각 합치기
    boxes.sort(key=lambda b: b[0])
    groups = []
    for b in boxes:
        x, y, w, h, a = b
        thin = groups and (w < 0.35 * s or groups[-1][1] - groups[-1][0] < 0.35 * s)
        vov = groups and min(y + h, groups[-1][3]) - max(y, groups[-1][2]) > 0
        if groups and (x <= groups[-1][1] - 0.15 * w or (thin and vov and x - groups[-1][1] <= 0.3 * s)):
            g = groups[-1]
            g[1] = max(g[1], x + w); g[2] = min(g[2], y); g[3] = max(g[3], y + h)
        else:
            groups.append([x, x + w, y, y + h])
    # 높은음자리표: 첫 번째 큰 덩어리(높이 5s 이상)
    clef = None
    for i, g in enumerate(groups[:4]):
        if (g[3] - g[2]) >= 5.0 * s and g[0] < 4 * s:
            clef = i
            break
    if clef is None:
        return None
    if MODE == 'pos':
        g = groups[clef]
        return read_staff_pos(band, st, y0, min(g[1], g[0] + 3.0 * s))   # 기호가 붙어 한 덩어리가 된 경우 자리표 폭으로 자름
    kind, count, last_x = None, 0, groups[clef][1]
    staff_top_l = top - y0
    staff_bot_l = bottom - y0
    for g in groups[clef + 1:]:
        gx0, gx1, gy0, gy1 = g
        if gx0 - last_x > 2.2 * s:
            break
        cy = (gy0 + gy1) / 2
        if not (staff_top_l - 0.9 * s <= cy <= staff_bot_l + 0.4 * s):
            break
        comp = band[gy0:gy1, gx0:gx1] > 0
        c = classify(comp, s)
        if c is None:
            break
        if kind and c != kind:
            break
        kind = c
        count += 1
        last_x = gx1
        if count == 7:
            break
    return (kind or '', count)


# ── 위치 기반 판독: 조표 기호는 정해진 줄·칸에 놓인다(샵 F C G D A E B, 플랫 B E A D G C F) ──
SHARP_POS = [0, 3, -1, 2, 5, 1, 4]      # 맨 윗줄(F5)에서 반 칸 단위로 아래로
FLAT_POS = [4, 1, 5, 2, 6, 3, 7]


def make_templates(s, bold=1.0):
    s = float(s)
    W = int(round(1.6 * s)) | 1
    H = int(round(3.4 * s)) | 1
    cx, cy = W // 2, H // 2
    lw = max(1, int(round(0.11 * s * bold)))
    sh = np.zeros((H, W), np.uint8)
    for dx in (-0.28, 0.28):
        x = int(round(cx + dx * s))
        cv2.line(sh, (x, int(cy - 1.3 * s)), (x, int(cy + 1.3 * s)), 255, lw)
    bw = max(2, int(round(0.33 * s * bold)))
    for dy in (-0.42, 0.42):
        y = cy + dy * s
        cv2.line(sh, (int(cx - 0.55 * s), int(y + 0.18 * s)), (int(cx + 0.55 * s), int(y - 0.18 * s)), 255, bw)
    fl = np.zeros((H, W), np.uint8)
    x = int(round(cx - 0.3 * s))
    cv2.line(fl, (x, int(cy - 1.75 * s)), (x, int(cy + 0.5 * s)), 255, lw + 1)
    cv2.ellipse(fl, (int(cx + 0.02 * s), int(cy + 0.1 * s)), (int(0.34 * s), int(0.4 * s)), -30, -150, 120, 255, max(2, int(0.18 * s * bold)))
    blur = lambda t: cv2.GaussianBlur(t, (0, 0), max(0.6, 0.08 * s))
    return blur(sh), blur(fl), cx, cy


def read_staff_pos(raw01, st, y_off, clef_right):
    """오선을 지우지 않은 원본 잉크에서, 오선까지 그려 넣은 기호 틀로 정해진 자리를 차례로 맞춰 본다."""
    s, top = st['s'], st['top'] - y_off
    th = max(1, st['thick'])
    img = cv2.GaussianBlur((raw01 * 255).astype(np.uint8), (0, 0), max(0.6, 0.08 * s))
    T = [make_templates(s, b) for b in (1.0, 1.6)]
    cx, cy = T[0][2], T[0][3]
    best = {}
    for kind, syms, pos in (('#', [t[0] for t in T], SHARP_POS), ('b', [t[1] for t in T], FLAT_POS)):
        xs, scores = [], []
        x_prev = clef_right - 0.6 * s
        for i, p in enumerate(pos):
            yc = top + p * s / 2
            tpl = syms[0]
            lo = x_prev + (0.45 * s if i else 0)
            hi = x_prev + (1.9 * s if i else 4.8 * s)
            y0 = int(round(yc - cy - 0.25 * s)); y1 = int(round(yc - cy + 0.25 * s)) + tpl.shape[0]
            x0 = int(max(0, lo - cx)); x1 = int(min(img.shape[1], hi - cx + tpl.shape[1]))
            y0 = max(0, y0); y1 = min(img.shape[0], y1)
            if x1 - x0 < tpl.shape[1] or y1 - y0 < tpl.shape[0]:
                break
            res = np.maximum.reduce([cv2.matchTemplate(img[y0:y1, x0:x1], t, cv2.TM_CCOEFF_NORMED) for t in syms])
            j = np.unravel_index(np.argmax(res), res.shape)
            sc = float(res[j])
            if sc < THRESH:
                break
            x_prev = x0 + j[1] + cx
            xs.append(x_prev); scores.append(sc)
        best[kind] = (len(xs), float(np.mean(scores)) if scores else 0.0)
    (ns, ss), (nf, sf) = best['#'], best['b']
    LAST.append(best)
    if ns == 0 and nf == 0:
        return ('', 0)
    if ns > nf or (ns == nf and ss >= sf):
        return ('#', ns)
    return ('b', nf)


THRESH = 0.42
LAST = []


def read_key(path):
    img = load(path)
    if img is None:
        return None, '이미지 열기 실패'
    h, w = img.shape
    _, ink0 = cv2.threshold(img, 0, 1, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    st0 = find_staves(ink0)
    scale = 18.0 / float(np.median([x['s'] for x in st0])) if st0 else (1800 / w if w < 1200 or w > 2600 else 1.0)
    if abs(scale - 1.0) > 0.08:
        img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA)
    _, ink = cv2.threshold(img, 0, 1, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    staves = find_staves(ink)
    if not staves:
        return None, '오선 못 찾음'
    results = []
    for st in staves[:6]:
        r = read_staff(ink, st)
        if r is not None:
            results.append(r)
    if not results:
        return None, '높은음자리표 못 찾음'
    # 가장 많이 나온 판독. 2단 이상 판독되면 과반이 같아야 한다.
    from collections import Counter
    c = Counter(results)
    (kind, count), n = c.most_common(1)[0]
    if len(results) >= 2 and n < max(2, (len(results) + 1) // 2):
        return None, f'단마다 다름 {dict(c)}'
    key = SHARP_KEYS[count] if kind == '#' else FLAT_KEYS[count] if kind == 'b' else 'C'
    return key, f'{kind or "0"}{count} ({n}/{len(results)}단)'


if __name__ == '__main__':
    for p in sys.argv[1:]:
        try:
            k, why = read_key(p)
        except Exception as e:  # 한 파일 오류가 전체를 멈추지 않게
            k, why = None, f'오류 {e}'
        print(f'{p}\t{k or "-"}\t{why}', flush=True)


# ── 첫 코드 읽기(악보 위 코드 이름) : 조표 판독을 확인하는 데 쓴다 ──
def first_chord(path):
    try:
        import pytesseract
    except ImportError:
        return None
    img = load(path)
    if img is None:
        return None
    _, ink0 = cv2.threshold(img, 0, 1, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    st0 = find_staves(ink0)
    if not st0:
        return None
    sc = 26.0 / float(np.median([x['s'] for x in st0]))
    img = cv2.resize(img, None, fx=sc, fy=sc, interpolation=cv2.INTER_CUBIC)
    _, ink = cv2.threshold(img, 0, 1, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    staves = find_staves(ink)
    import re
    for st in staves[:2]:
        s = st['s']
        y0, y1 = int(max(0, st['top'] - 3.2 * s)), int(st['top'] - 0.3 * s)
        x0, x1 = int(st['x0'] + 3 * s), int(min(img.shape[1], st['x0'] + 30 * s))
        if y1 <= y0 or x1 <= x0:
            continue
        crop = img[y0:y1, x0:x1]
        txt = pytesseract.image_to_string(crop, config='--psm 7 -c tessedit_char_whitelist=ABCDEFG#bm7susadj/0123456789()')
        m = re.search(r'(?<![A-Za-z])([A-G])(#|b)?(m(?!a))?', txt)
        if m:
            return m.group(1) + (m.group(2) or '') + (m.group(3) or '')
    return None
