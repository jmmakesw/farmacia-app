"""Gera os ícones da app (PNG) e o ícone SVG. Para mudar a cor ou o desenho, edite aqui e corra `npm run icons`."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

BG = (15, 118, 110)       # verde-azulado da farmácia
FG = (255, 255, 255)
SCALE = 4                  # desenha em grande e reduz, para bordas suaves


def cross_icon(size, safe=1.0, rounded=True):
    """Cruz de farmácia branca sobre fundo colorido.

    safe < 1 reduz o desenho para ficar dentro da zona segura dos ícones 'maskable'.
    rounded=False dá um quadrado cheio (o iOS aplica os cantos arredondados sozinho).
    """
    s = size * SCALE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=BG)
    else:
        d.rectangle([0, 0, s, s], fill=BG)

    arm = s * 0.26 * safe          # espessura dos braços
    reach = s * 0.30 * safe        # comprimento a partir do centro
    c = s / 2
    r = arm * 0.22
    d.rounded_rectangle([c - arm / 2, c - reach, c + arm / 2, c + reach], radius=r, fill=FG)
    d.rounded_rectangle([c - reach, c - arm / 2, c + reach, c + arm / 2], radius=r, fill=FG)
    return img.resize((size, size), Image.LANCZOS)


cross_icon(192).save(OUT / "icon-192.png")
cross_icon(512).save(OUT / "icon-512.png")
cross_icon(512, safe=0.8, rounded=False).save(OUT / "icon-maskable-512.png")
cross_icon(180, rounded=False).convert("RGB").save(OUT / "apple-touch-icon.png")
cross_icon(32).save(OUT / "favicon-32.png")

(OUT / "icon.svg").write_text(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">'
    '<rect width="512" height="512" rx="113" fill="#0f766e"/>'
    '<rect x="190" y="102" width="133" height="308" rx="29" fill="#fff"/>'
    '<rect x="102" y="190" width="308" height="133" rx="29" fill="#fff"/>'
    "</svg>\n",
    encoding="utf-8",
)
print("Ícones gerados em", OUT)
