"""Draw the fictional shops' product illustrations and marks as SVG files.

Run: python3 make_art.py <shops_src_dir>
Everything here is original vector art made for the demo.
"""
import math
import random
import sys
from pathlib import Path

W, H = 240, 180


def svg(body, w=W, h=H, extra=""):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" {extra}>{body}</svg>\n'


def speckles(cx, cy, rx, ry, n, color, seed):
    rnd = random.Random(seed)
    out = []
    for _ in range(n):
        a = rnd.random() * math.tau
        r = math.sqrt(rnd.random())
        x = cx + math.cos(a) * rx * r
        y = cy + math.sin(a) * ry * r
        out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{rnd.uniform(0.6, 1.4):.1f}" fill="{color}"/>')
    return "".join(out)


def glow(cx, cy, r, color="#F0B94B", opacity=0.55):
    gid = f"g{int(cx)}{int(cy)}{int(r)}"
    return (f'<defs><radialGradient id="{gid}"><stop offset="0" stop-color="{color}" stop-opacity="{opacity}"/>'
            f'<stop offset="1" stop-color="{color}" stop-opacity="0"/></radialGradient></defs>'
            f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="url(#{gid})"/>')


def brackenlight(out: Path):
    lamp = (glow(120, 92, 70) +
            '<path d="M86 38 L154 38 L170 84 L70 84 Z" fill="#E8DDC6" stroke="#C9B996" stroke-width="2"/>'
            '<path d="M80 52 L160 52" stroke="#D5C7A8" stroke-width="1.5"/><path d="M76 66 L164 66" stroke="#D5C7A8" stroke-width="1.5"/>'
            '<rect x="117" y="84" width="6" height="12" fill="#6B6F78"/>'
            '<path d="M120 96 C92 96 84 118 88 136 C92 156 104 162 120 162 C136 162 148 156 152 136 C156 118 148 96 120 96 Z" fill="#9AA1A8"/>'
            + speckles(120, 130, 26, 26, 38, "#6E757D", 1) +
            '<ellipse cx="120" cy="164" rx="36" ry="4" fill="#1E2A47" opacity="0.12"/>')
    pendant = ('<path d="M120 0 L120 54" stroke="#3B3F4A" stroke-width="2"/>' + glow(120, 112, 66) +
               '<path d="M60 112 C60 76 88 56 120 56 C152 56 180 76 180 112 Z" fill="#5E7A4F"/>'
               '<path d="M66 112 C66 82 90 64 120 64 C150 64 174 82 174 112" fill="none" stroke="#7E9A6D" stroke-width="2"/>'
               '<ellipse cx="120" cy="112" rx="60" ry="8" fill="#3F5534"/><circle cx="120" cy="116" r="12" fill="#FCE7A8"/>')
    shade = ('<path d="M64 40 L176 40 L196 140 L44 140 Z" fill="#E8DDC6" stroke="#C9B996" stroke-width="2"/>'
             + "".join(f'<path d="M{64 - i * 4} {40 + i * 20} L{176 + i * 4} {40 + i * 20}" stroke="#D8CBAE" stroke-width="1.2"/>' for i in range(1, 5)) +
             '<ellipse cx="120" cy="140" rx="76" ry="8" fill="#D2C3A2"/><circle cx="120" cy="90" r="9" fill="none" stroke="#8C8F99" stroke-width="2"/>')
    def mug(x, seed):
        return (f'<path d="M{x} 70 L{x + 56} 70 L{x + 52} 146 C{x + 52} 152 {x + 4} 152 {x + 4} 146 Z" fill="#E9E3D8" stroke="#CFC5B3" stroke-width="2"/>'
                f'<path d="M{x + 56} 84 C{x + 78} 84 {x + 78} 122 {x + 54} 122" fill="none" stroke="#CFC5B3" stroke-width="8" stroke-linecap="round"/>'
                + speckles(x + 28, 108, 22, 34, 30, "#7C6A55", seed) + f'<ellipse cx="{x + 28}" cy="70" rx="28" ry="5" fill="#D9D0C1"/>')
    mugs = mug(40, 2) + mug(126, 3)
    vase = ('<path d="M112 20 L128 20 L128 50 C128 64 160 74 160 112 C160 146 144 162 120 162 C96 162 80 146 80 112 C80 74 112 64 112 50 Z" fill="#24366B"/>'
            '<path d="M84 128 C96 140 144 140 156 128 C156 148 142 162 120 162 C98 162 84 148 84 128 Z" fill="#3B5AA3" opacity="0.85"/>'
            '<path d="M100 70 C92 86 90 104 94 122" stroke="#5C78C0" stroke-width="3" fill="none" opacity="0.6"/>')
    candle = ('<path d="M120 22 C126 32 128 40 120 48 C112 40 114 32 120 22 Z" fill="#F0B94B"/>' + glow(120, 40, 34, opacity=0.4) +
              '<rect x="108" y="48" width="24" height="56" rx="3" fill="#F7F1E3" stroke="#E2D6BC"/>'
              '<path d="M84 104 L156 104 L148 120 L92 120 Z" fill="#B8892E"/>'
              '<rect x="112" y="120" width="16" height="20" fill="#A47A26"/><ellipse cx="120" cy="150" rx="40" ry="10" fill="#B8892E"/>'
              '<path d="M98 112 L142 112" stroke="#7E5A15" stroke-width="1.4" stroke-dasharray="3 2"/>')
    files = {"lamp-ash-glaze": lamp, "pendant-moss": pendant, "shade-linen-l": shade, "mugs-speckle-2": mugs, "vase-night": vase, "candle-brass-engraved": candle}
    for name, body in files.items():
        (out / f"{name}.svg").write_text(svg(body))
    mark = ('<rect width="40" height="40" rx="9" fill="#F0B94B"/><path d="M12 9 L28 9 L32 21 L8 21 Z" fill="#1E2A47"/>'
            '<path d="M20 21 L20 27" stroke="#1E2A47" stroke-width="2.4"/><ellipse cx="20" cy="30" rx="7" ry="3.6" fill="#1E2A47"/>')
    (out / "mark.svg").write_text(svg(mark, 40, 40))
    (out / "favicon.svg").write_text(svg(mark, 40, 40))
    hero = (glow(110, 120, 120, opacity=0.5) + glow(300, 90, 90, opacity=0.45) +
            '<path d="M60 70 L160 70 L176 128 L44 128 Z" fill="#E8DDC6"/><rect x="106" y="128" width="8" height="18" fill="#9AA1A8"/>'
            '<path d="M110 146 C80 146 74 172 78 190 C82 210 96 216 110 216 C124 216 138 210 142 190 C146 172 140 146 110 146 Z" fill="#9AA1A8"/>'
            '<path d="M300 0 L300 50" stroke="#C9C3B4" stroke-width="2"/><path d="M246 104 C246 72 270 52 300 52 C330 52 354 72 354 104 Z" fill="#5E7A4F"/>'
            '<ellipse cx="300" cy="104" rx="54" ry="7" fill="#3F5534"/><circle cx="300" cy="108" r="10" fill="#FCE7A8"/>'
            '<path d="M228 236 L372 236" stroke="#3A4466" stroke-width="2"/>')
    (out / "hero.svg").write_text(svg(hero, 420, 240))


def coppice(out: Path):
    def wheel(cx, cy, r, spokes=28, tyre="#22292C", rim="#AEB8BC"):
        parts = [f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="{tyre}" stroke-width="{r * 0.12:.1f}"/>',
                 f'<circle cx="{cx}" cy="{cy}" r="{r * 0.9:.1f}" fill="none" stroke="{rim}" stroke-width="{r * 0.05:.1f}"/>']
        for i in range(spokes):
            a = i / spokes * math.tau
            hub_a = a + (0.25 if i % 2 else -0.25)
            x1, y1 = cx + math.cos(hub_a) * r * 0.1, cy + math.sin(hub_a) * r * 0.1
            x2, y2 = cx + math.cos(a) * r * 0.88, cy + math.sin(a) * r * 0.88
            parts.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="#7F8C91" stroke-width="1"/>')
        parts.append(f'<circle cx="{cx}" cy="{cy}" r="{r * 0.12:.1f}" fill="#5B676C"/><circle cx="{cx}" cy="{cy}" r="{r * 0.05:.1f}" fill="#F2C230"/>')
        return "".join(parts)
    wheelset = wheel(84, 92, 66) + wheel(166, 92, 66)
    tyre = ('<circle cx="120" cy="90" r="64" fill="none" stroke="#22292C" stroke-width="22"/>'
            + "".join(f'<line x1="{120 + math.cos(i / 36 * math.tau) * 56:.1f}" y1="{90 + math.sin(i / 36 * math.tau) * 56:.1f}" x2="{120 + math.cos(i / 36 * math.tau) * 72:.1f}" y2="{90 + math.sin(i / 36 * math.tau) * 72:.1f}" stroke="#3B4549" stroke-width="2"/>' for i in range(36)) +
            '<circle cx="120" cy="90" r="50" fill="none" stroke="#F2C230" stroke-width="2" opacity="0.8"/>')
    spiral = []
    for i in range(0, 540, 6):
        a = math.radians(i)
        r = 18 + i / 540 * 46
        spiral.append(f"{120 + math.cos(a) * r:.1f},{90 + math.sin(a) * r * 0.62:.1f}")
    cables = (f'<polyline points="{" ".join(spiral)}" fill="none" stroke="#2D3A40" stroke-width="5" stroke-linecap="round"/>'
              '<rect x="172" y="104" width="22" height="8" rx="2" fill="#AEB8BC"/><rect x="40" y="62" width="22" height="8" rx="2" fill="#AEB8BC"/>')
    links = "".join(f'<rect x="{20 + i * 34}" y="{80 + (6 if i % 2 else -6)}" width="40" height="22" rx="11" fill="none" stroke="#7F8C91" stroke-width="6"/>' for i in range(6))
    chain = links + "".join(f'<circle cx="{31 + i * 34}" cy="{91 + (6 if i % 2 else -6)}" r="3.5" fill="#3B4549"/>' for i in range(6))
    saddle = ('<path d="M30 92 C40 70 110 64 180 74 C204 78 214 86 214 94 C214 104 196 108 170 108 C150 108 128 116 100 120 C70 124 40 118 32 108 C28 102 28 96 30 92 Z" fill="#8A5A2B"/>'
              '<path d="M40 96 C70 104 120 100 170 92" stroke="#A9743F" stroke-width="2" fill="none"/>'
              '<path d="M90 120 L120 150 L150 116" stroke="#5B676C" stroke-width="5" fill="none" stroke-linecap="round"/>'
              + "".join(f'<circle cx="{60 + i * 22}" cy="{100 - i * 2}" r="1.8" fill="#5E3A16"/>' for i in range(6)))
    files = {"wheelset-custom": wheelset, "tyre-32": tyre, "cables-cut": cables, "chain-11": chain, "saddle-leather": saddle}
    for name, body in files.items():
        (out / f"{name}.svg").write_text(svg(body))
    mark = ('<rect width="40" height="40" rx="4" fill="#F2C230"/>'
            '<circle cx="20" cy="20" r="12" fill="none" stroke="#23353D" stroke-width="3"/><circle cx="20" cy="20" r="2.6" fill="#23353D"/>'
            + "".join(f'<line x1="20" y1="20" x2="{20 + math.cos(i / 8 * math.tau) * 11:.1f}" y2="{20 + math.sin(i / 8 * math.tau) * 11:.1f}" stroke="#23353D" stroke-width="1.4"/>' for i in range(8)))
    (out / "mark.svg").write_text(svg(mark, 40, 40))
    (out / "favicon.svg").write_text(svg(mark, 40, 40))
    hero = wheel(210, 120, 110, spokes=32, tyre="#0F181B", rim="#9FB0B5") + '<circle cx="210" cy="120" r="118" fill="none" stroke="#F2C230" stroke-width="2" opacity="0.6"/>'
    (out / "hero.svg").write_text(svg(hero, 420, 240))


if __name__ == "__main__":
    root = Path(sys.argv[1])
    brackenlight(root / "brackenlight" / "img")
    coppice(root / "coppice" / "img")
    print("art written")
