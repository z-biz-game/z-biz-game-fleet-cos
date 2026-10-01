#!/usr/bin/env python3
"""战舰单数 FLEET 的美术资产工厂 —— 一套图标 + 一张纹理 + 一枚铆钉 + 一张社交卡，全部现画。

为什么要有这个文件，而不是找一张现成图放进仓里：这一仓的身份是"零依赖、可复现"
（js/data/lots.js 的 96 个题面由 tools/bake.mjs 现算，位图同理）。手绘 PNG 无法重跑
校验，而这条脚本的输入只有种子 + 尺寸 + 配色三项，`python3 assets/gen/make_art.py`
在任何一台装了 Pillow 的机器上都拿回同名同尺寸的文件（像素级一致依赖字体存在与否，
脚本会把实际用到的字体与每张图的 sha256 前缀打出来，对不上就是字体链变了）。

母题从玩法来：Battleship Solitaire 读的是"图外的数字 + 图内的直线段"，规则口径是
任何两格相邻（含斜角）的船不能共存（js/core/rules.js）。所以图标画两块互不接触的
钢板（横 4 格、竖 3 格）、四角压着行列线索数字；配色逐个抄自 css/game.css 的 :root，
一个新造的颜色都没有。

产出（全是真 PNG，非 0 字节、非 SVG 改名）：
  icons/icon-1024.png  icons/icon-512.png  icons/icon-192.png  icons/icon-96.png
  icons/icon-64.png    icons/favicon-48.png icons/favicon-32.png icons/favicon-16.png
  icons/apple-touch-icon.png (180)  icons/icon-maskable-{512,192}.png
  assets/textures/chart-paper.png  256x256 可平铺海图纹理（画进 canvas 底）
  assets/sprites/hull-plate.png     64x64 钢板铆钉（船坞胶囊的 CSS 底图）
  assets/og/fleet-og-cover.png    1200x630 社交卡

用法: python3 assets/gen/make_art.py [--out <仓根>]
"""
import argparse
import hashlib
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

# 种子写死：换种子等于换资产，那属于设计变更，要跟着改动一起提交。
SEED = 0xF1E37

# css/game.css :root 的实测色，逐个抄。
BG = (15, 19, 25)          # --bg #0f1319
BG2 = (21, 27, 36)         # --bg-2 #151b24
PANEL = (23, 29, 39)       # --panel #171d27
INK = (230, 233, 239)      # --ink #e6e9ef
DIM = (143, 152, 168)      # --ink-dim #8f98a8
BRASS = (216, 161, 60)     # --brass #d8a13c
STEEL = (159, 171, 185)    # --steel #9fabb9
STEEL_HI = (201, 214, 229)  # .dock .hull i 渐变上端
STEEL_LO = (92, 107, 125)   # 同上端
CYAN = (120, 220, 255)     # --cyan #78dcff
HULL_INK = (12, 18, 26)    # view.js 舷窗色

CJK_CHAIN = [
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/System/Library/Fonts/STHeiti Light.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
]
MONO_CHAIN = [
    '/System/Library/Fonts/Menlo.ttc',
    '/System/Library/Fonts/SFNSMono.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
]
FONTS_USED = set()


def rgba(c, a):
    return (c[0], c[1], c[2], a)


def mix_col(a, b, t):
    """实色插值：需要"淡"的地方直接算成暗色，而不是靠 alpha（PIL 的 alpha 描边不可靠）。"""
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def load_font(px, chain):
    """字体不进仓（这一仓零依赖），按链找系统里在的那支；全都没有就退回 PIL 自带。"""
    for path in chain:
        if not os.path.exists(path):
            continue
        try:
            f = ImageFont.truetype(path, px)
        except Exception:
            continue
        FONTS_USED.add(os.path.basename(path))
        return f
    try:
        f = ImageFont.load_default(px)
        FONTS_USED.add('PIL:load_default')
        return f
    except Exception:
        FONTS_USED.add('PIL:default')
        return ImageFont.load_default()


def has_cjk(text, chain):
    """确认选中的字体真画得出中文：缺字会静默画成豆腐块，那不如不打字。"""
    for path in chain:
        if not os.path.exists(path):
            continue
        try:
            f = ImageFont.truetype(path, 40)
        except Exception:
            continue
        if any(f.getmask(ch).getbbox() for ch in text):
            return True
    return False


# --------------------------------------------------------------------------- 确定性噪声
class Lcg:
    """自己的随机源：不用 `random`，同一脚本在不同 Python 版本下也必须给出同一张图。"""

    def __init__(self, seed=SEED):
        self.s = seed & 0xFFFFFFFF

    def unit(self):
        self.s = (1664525 * self.s + 1013904223) & 0xFFFFFFFF
        return (self.s >> 8) / 16777216.0


def smooth(t):
    return t * t * (3 - 2 * t)


def tile_noise(size, period, octaves=4, seed=SEED):
    """可平铺的多倍频值噪声（0..1）。格点落在 period x period 的环面上（索引取模），
    所以四边无缝；每层振幅减半、周期翻倍，海图纸那种粗细颗粒就是这么叠出来的。"""
    rng = Lcg(seed)
    out = [[0.0] * size for _ in range(size)]
    p = period
    amp = 1.0
    amp_sum = 0.0
    for _ in range(octaves):
        lattice = {}
        for gy in range(p):
            for gx in range(p):
                lattice[(gx, gy)] = rng.unit()
        scale = size / p
        for y in range(size):
            fy = y / scale
            fl = math.floor(fy)
            gy0 = int(fl) % p
            gy1 = (gy0 + 1) % p
            ty = smooth(fy - fl)
            row = out[y]
            for x in range(size):
                fx = x / scale
                fxl = math.floor(fx)
                gx0 = int(fxl) % p
                gx1 = (gx0 + 1) % p
                tx = smooth(fx - fxl)
                top = lattice[(gx0, gy0)] + (lattice[(gx1, gy0)] - lattice[(gx0, gy0)]) * tx
                bot = lattice[(gx0, gy1)] + (lattice[(gx1, gy1)] - lattice[(gx0, gy1)]) * tx
                row[x] += amp * (top + (bot - top) * ty)
        amp_sum += amp
        amp *= 0.5
        p = min(p * 2, size)
    for y in range(size):
        row = out[y]
        for x in range(size):
            row[x] /= amp_sum
    return out


# --------------------------------------------------------------------------- 画刷
def vert_gradient(w, h, top, mid, bottom):
    img = Image.new('RGB', (max(1, int(round(w))), max(1, int(round(h)))), top)
    d = ImageDraw.Draw(img)
    n = img.size[1]
    for i in range(n):
        t = i / max(1, n - 1)
        if t < 0.45:
            k = t / 0.45
            col = tuple(int(top[j] + (mid[j] - top[j]) * k) for j in range(3))
        else:
            k = (t - 0.45) / 0.55
            col = tuple(int(mid[j] + (bottom[j] - mid[j]) * k) for j in range(3))
        d.line([(0, i), (img.size[0], i)], fill=col)
    return img


def paste_plate(img, cx, cy, w, h, studs=0, axis='h', round_k=0.42, line_k=0.06):
    """一块船身：竖向钢色渐变 + 深色描边 + 每格一个舷窗。js/view.js 的 plate() 画的就是
    这个形状，图标与游戏内因此共用一个母题。舷窗按船身方向均分（横船排 x、竖船排 y）。"""
    w = max(2.0, w)
    h = max(2.0, h)
    grad = vert_gradient(w, h, STEEL_HI, STEEL, STEEL_LO)
    mask = Image.new('L', grad.size, 0)
    rad = min(grad.size[0], grad.size[1]) * round_k
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, grad.size[0] - 1, grad.size[1] - 1], radius=rad, fill=255)
    img.paste(grad, (int(round(cx - w / 2)), int(round(cy - h / 2))), mask)
    d = ImageDraw.Draw(img)
    box = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]
    d.rounded_rectangle(box, radius=rad, outline=HULL_INK, width=max(1, int(h * line_k)))
    for k in range(studs):
        rr = max(1.0, min(w, h) * 0.12)
        if axis == 'h':
            sx, sy = box[0] + w * (k + 0.5) / studs, cy
        else:
            sx, sy = cx, box[1] + h * (k + 0.5) / studs
        d.ellipse([sx - rr, sy - rr, sx + rr, sy + rr], fill=HULL_INK)


def composite(img, paint):
    """在一张同尺寸 RGBA 叠层上画半透明装饰，再 alpha_composite 回主体。

    必须绕这一道：PIL 的 `draw.line(fill=(r,g,b,a))` 画在 RGB 底上时**丢掉 a**（画成实心），
    画在 RGBA 底上时又是**直接替换**而不是混合。于是"极淡网格"会画成刺眼的钢色实线，
    纹理的接缝自检也会读出 78 这种不可能的数（底噪只有 18 级）。
    """
    layer = Image.new('RGBA', img.size, (0, 0, 0, 0))
    paint(ImageDraw.Draw(layer))
    return Image.alpha_composite(img.convert('RGBA'), layer)


def draw_board_layer(d, ox, oy, span, divisions=8, alpha_grid=16):
    """极淡的海图经纬线：把整幅棋盘 `divisions` 等分，对应 js/core/board.js 的棋盘格。"""
    gap = span / divisions
    for k in range(1, divisions):
        g = k * gap
        d.line([(ox + g, oy), (ox + g, oy + span)], fill=rgba(STEEL, alpha_grid))
        d.line([(ox, oy + g), (ox + span, oy + g)], fill=rgba(STEEL, alpha_grid))
    d.rectangle([ox, oy, ox + span, oy + span], outline=rgba(STEEL, alpha_grid * 2))


# --------------------------------------------------------------------------- 图标母题
def draw_icon(size, maskable=False):
    """海军蓝底 + 极淡经纬线 + 两块互不接触的钢板 + 角上线索数字。"""
    s = size
    img = Image.new('RGBA', (s, s), BG + (255,))
    d = ImageDraw.Draw(img)
    for y in range(s):
        t = y / max(1, s - 1)
        col = tuple(int(BG[j] + (BG2[j] - BG[j]) * (1 - t)) for j in range(3))
        d.line([(0, y), (s, y)], fill=col + (255,))

    # maskable 会被系统裁成圆/盾，构图收进 80% 安全区。
    inset = 0.20 if maskable else 0.14
    span = s * (1 - 2 * inset)
    ox = oy = s * inset
    cell = span / 8.0
    fine = size >= 96  # 16/32/48 上数字与舷窗只会糊成脏点，只留两块板的轮廓
    lw = max(1, int(s / 220))

    def back(od):
        draw_board_layer(od, ox, oy, span, 8, alpha_grid=26 if fine else 16)
        if fine:
            # 斜角禁入：两块板之间那条铜色对角虚线就是"斜角也不行"这条规则本身。
            rr = cell * 0.16
            for k in range(1, 5):
                cxp = ox + (5.0 + 0.35) * cell
                cyp = oy + (0.5 + k * 0.72) * cell
                od.line([cxp - rr, cyp - rr, cxp + rr, cyp + rr],
                        fill=rgba(BRASS, 120), width=lw)

    img = composite(img, back)

    pad = cell * 0.14
    paste_plate(img, ox + 3.5 * cell, oy + 0.5 * cell, 4 * cell - pad * 2, cell - pad * 2,
                studs=4 if fine else 0)
    paste_plate(img, ox + 6.5 * cell, oy + 4.0 * cell, cell - pad * 2, 3 * cell - pad * 2,
                studs=3 if fine else 0, axis='v')

    if fine:
        def front(od):
            font = load_font(max(8, int(s * 0.115)), MONO_CHAIN)
            # 列线索压在上边、行线索挂在下边左侧：读题的方向就是 js/view.js 的方向。
            for k, txt in enumerate('4213'):
                od.text((ox + (k + 1.5) * cell, oy - cell * 0.62), txt, font=font,
                        fill=rgba(BRASS, 230), anchor='mm')
            for k, txt in enumerate('213'):
                od.text((ox - cell * 0.62, oy + (k + 2.5) * cell), txt, font=font,
                        fill=rgba(CYAN, 215), anchor='mm')

        img = composite(img, front)

    if maskable:
        return img
    alpha = Image.new('L', (s, s), 0)
    ImageDraw.Draw(alpha).rounded_rectangle([0, 0, s - 1, s - 1], radius=s * 0.225, fill=255)
    out = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    out.paste(img, (0, 0), alpha)
    return out


# --------------------------------------------------------------------------- 纹理 / 铆钉 / 社交卡
def make_chart_paper(size=256):
    """可平铺海图纸：噪声颗粒 + 等深线 + 分度痕。view.js 以 createPattern 平铺它，
    所以四边必须严格接得上（脚本末尾自检一条 seam 差值）。"""
    noise = tile_noise(size, 8, octaves=4)
    # 颗粒压在 --bg 与略亮的海图色之间：太窄等于铺一张纯色，太亮会抢走船身的对比。
    top = (34, 43, 56)
    px = bytearray(size * size * 4)
    for y in range(size):
        row = noise[y]
        for x in range(size):
            v = row[x]
            i = (y * size + x) * 4
            px[i] = BG[0] + int((top[0] - BG[0]) * v)
            px[i + 1] = BG[1] + int((top[1] - BG[1]) * v)
            px[i + 2] = BG[2] + int((top[2] - BG[2]) * v)
            px[i + 3] = 255
    img = Image.frombytes('RGBA', (size, size), bytes(px))

    def paint(d):
        # 等深线：三组正弦曲线，频率取整数倍于 2π/边长，所以跨边界处首尾相接。
        for k, (amp, freq, phase) in enumerate([(16, 1, 0.0), (28, 2, 0.7), (11, 3, 1.9)]):
            pts = []
            for x in range(0, size + 1):
                t = x / size * 2 * math.pi
                y = size * (k + 1) / 4.0 + amp * math.sin(freq * t + phase)
                pts.append((x, y))
            d.line(pts, fill=rgba(STEEL, 18))
        # 分度痕：每 32px 一道，海图的角尺；左右上下都画，平铺后才接得上。
        for x in range(0, size, 32):
            d.line([(x, 0), (x, 5)], fill=rgba(DIM, 30))
            d.line([(x, size - 5), (x, size - 1)], fill=rgba(DIM, 30))
        for y in range(0, size, 32):
            d.line([(0, y), (5, y)], fill=rgba(DIM, 26))
            d.line([(size - 5, y), (size - 1, y)], fill=rgba(DIM, 26))

    return composite(img, paint).filter(ImageFilter.GaussianBlur(0.35))


def seam_gap(img, size):
    """平铺自检：返回（左右接缝均色差，相邻列均色差）。相邻两列本来就有颗粒差，
    所以判读看的是比值——接缝差明显大于列差，就是接不上缝。"""
    px = img.convert('RGB').load()

    def col_diff(a, b):
        acc = 0
        for y in range(size):
            pa = px[a, y]
            pb = px[b, y]
            acc += abs(pa[0] - pb[0]) + abs(pa[1] - pb[1]) + abs(pa[2] - pb[2])
        return round(acc / (size * 3), 3)

    return col_diff(size - 1, 0), col_diff(1, 0)


def make_hull_stud(size=64):
    """船坞胶囊里那一格钢板（CSS 底图）：钢色渐变 + 描边 + 一颗舷窗，透明底。"""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    grad = vert_gradient(size, size, STEEL_HI, STEEL, STEEL_LO).convert('RGBA')
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([1, 1, size - 2, size - 2], radius=size * 0.2, fill=255)
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([1, 1, size - 2, size - 2], radius=size * 0.2,
                        outline=HULL_INK, width=2)
    rr = size * 0.15
    d.ellipse([size / 2 - rr, size / 2 - rr, size / 2 + rr, size / 2 + rr],
              fill=HULL_INK, outline=mix_col(STEEL_HI, HULL_INK, 0.45), width=1)
    return img


def fit_font(d, text, chain, want_px, max_w, floor_px=12):
    """按可用宽度逐级降字号，直到这行字真放得下：社交卡上顶出边界或压字的排版
    不是"差不多"，是缺陷。"""
    px = want_px
    while px > floor_px:
        f = load_font(px, chain)
        try:
            w = d.textlength(text, font=f)
        except Exception:
            w = px * len(text)
        if w <= max_w:
            return f
        px -= 2
    return load_font(floor_px, chain)


def make_og():
    """1200x630 社交卡：左侧母题图标，右侧标题 + 一句话玩法 + 三个实测口径。
    底纹就是把 assets/textures/chart-paper.png 原尺寸平铺，跟游戏内同一条路径。"""
    W, H = 1200, 630
    paper = make_chart_paper(256).convert('RGB')
    img = Image.new('RGB', (W, H), BG)
    for ty in range(0, H, 256):
        for tx in range(0, W, 256):
            img.paste(paper, (tx, ty))
    img = Image.blend(Image.new('RGB', (W, H), BG), img, 0.42).convert('RGBA')

    def paint(od):
        for k in range(1, 13):
            od.line([(k * W / 12, 0), (k * W / 12, H)], fill=rgba(STEEL, 14))
            od.line([(0, k * H / 9), (W, k * H / 9)], fill=rgba(STEEL, 14))
        od.rounded_rectangle([18, 18, W - 19, H - 19], radius=22, outline=rgba(BRASS, 130), width=3)

    img = composite(img, paint)
    icon = draw_icon(340)
    img.paste(icon, (84, (H - 340) // 2), icon)
    d = ImageDraw.Draw(img)

    # 中文能不能画由字体链决定；不能就整卡换成 ASCII 文案，不许出现豆腐块。
    cjk_ok = has_cjk('战舰单数', CJK_CHAIN)
    chain = CJK_CHAIN if cjk_ok else MONO_CHAIN
    x0 = 500
    maxw = W - 92 - x0
    colw = 196

    d.text((x0, 92), '战舰单数' if cjk_ok else 'FLEET',
           font=fit_font(d, '战舰单数' if cjk_ok else 'FLEET', chain, 104, maxw), fill=INK)
    d.text((x0 + 4, 232), 'FLEET · BATTLESHIP SOLITAIRE' if not cjk_ok
           else 'F L E E T   ·   战 舰 单 数',
           font=fit_font(d, 'FLEET · BATTLESHIP SOLITAIRE', chain, 26, maxw), fill=DIM)
    body = ['按行列线索把一支舰队摆进图里，', '任何两格相邻（含斜角）的船',
            '不能共存 —— 这就是全部规则。'] if cjk_ok else \
           ['Place the fleet so that no two', 'ships touch, not even on the',
            'diagonal. That is the whole rule.']
    for i, ln in enumerate(body):
        d.text((x0, 286 + i * 54), ln, font=fit_font(d, ln, chain, 38, maxw), fill=INK)
    d.line([(x0, 462), (W - 92, 462)], fill=mix_col(BRASS, BG, 0.35), width=2)
    stats = [('96', '题面 · 唯一解实测', BRASS), ('2 路', '求解器 / 枚举表对账', CYAN),
             ('0-2', '假设层数 = 难度', STEEL)] if cjk_ok else \
            [('96', 'charts, unique', BRASS), ('2', 'routes agree', CYAN),
             ('0-2', 'assumption depth', STEEL)]
    for i, (val, label, col) in enumerate(stats):
        cx = x0 + i * colw
        d.text((cx, 486), val, font=fit_font(d, val, chain, 46, colw - 12), fill=col)
        d.text((cx, 552), label, font=fit_font(d, label, chain, 21, colw - 12), fill=DIM)
    foot = '浏览器原生 · 零依赖 · 存档只在本机' if cjk_ok else 'Native browser build · zero deps'
    d.text((x0, 584), foot, font=fit_font(d, foot, chain, 22, maxw), fill=mix_col(DIM, BG, 0.3))
    return img


# --------------------------------------------------------------------------- 出货
ICON_PLAN = [
    ('icons/icon-1024.png', 1024, False),
    ('icons/icon-512.png', 512, False),
    ('icons/icon-maskable-512.png', 512, True),
    ('icons/icon-192.png', 192, False),
    ('icons/icon-maskable-192.png', 192, True),
    ('icons/apple-touch-icon.png', 180, False),
    ('icons/favicon-96.png', 96, False),
    ('icons/favicon-48.png', 48, False),
    ('icons/favicon-32.png', 32, False),
    ('icons/favicon-16.png', 16, False),
]


def save(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, 'PNG', optimize=True)
    with open(path, 'rb') as fh:
        digest = hashlib.sha256(fh.read()).hexdigest()[:12]
    with Image.open(path) as check:
        w, h = check.size
        mode = check.mode
        size = os.path.getsize(path)
    if size == 0:
        raise SystemExit('FATAL 0 字节: %s' % path)
    print('%-36s %-9s %4dx%-4d %8d B  sha256:%s' % (os.path.relpath(path, ROOT_OUT), mode, w, h, size, digest))
    return path


def main():
    global ROOT_OUT
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))
    args = ap.parse_args()
    ROOT_OUT = args.out
    written = []
    for rel, n, maskable in ICON_PLAN:
        written.append(save(draw_icon(n, maskable), os.path.join(ROOT_OUT, rel)))
    paper = make_chart_paper(256)
    written.append(save(paper, os.path.join(ROOT_OUT, 'assets/textures/chart-paper.png')))
    seam, step = seam_gap(paper, 256)
    print('  平铺自检 接缝差=%s 相邻列差=%s 比值=%s ⇒ %s'
          % (seam, step, round(seam / max(step, 1e-6), 2),
             '无缝' if seam <= step * 1.5 else '接不上缝'))
    written.append(save(make_hull_stud(64), os.path.join(ROOT_OUT, 'assets/sprites/hull-plate.png')))
    written.append(save(make_og(), os.path.join(ROOT_OUT, 'assets/og/fleet-og-cover.png')))
    print('fonts:', ', '.join(sorted(FONTS_USED)) or '(none)')
    print('files:', len(written))
    return 0


if __name__ == '__main__':
    sys.exit(main())
