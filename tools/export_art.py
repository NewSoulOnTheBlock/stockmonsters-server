"""Export every species' front sprite as 256x256 PNGs for NFT images, with the
background colour (index 0) transparent: art/<id>.png from the normal palette
and art/<id>s.png from the shiny one.
Usage: python -P tools/export_art.py ../stockred
-P, not -I: Pillow lives in the user site-packages."""
import json, pathlib, sys
from PIL import Image

root = pathlib.Path(sys.argv[1])
here = pathlib.Path(__file__).resolve().parent.parent
species = json.loads((here / "species.json").read_text(encoding="utf-8"))
out = here / "art"
out.mkdir(exist_ok=True)

def read_jasc(path):
    lines = path.read_text().split()
    count = int(lines[2])
    nums = list(map(int, lines[3:3 + count * 3]))
    return [tuple(nums[i:i + 3]) for i in range(0, len(nums), 3)]

done = 0
for sid, info in species["info"].items():
    folder = root / "graphics/pokemon" / info["slot"].lower()
    pic = folder / "front.png"
    if not pic.exists():
        continue
    im = Image.open(pic)
    if im.mode != "P":
        continue
    for pal_name, suffix in (("normal.pal", ""), ("shiny.pal", "s")):
        pal = folder / pal_name
        if not pal.exists():
            continue
        colors = read_jasc(pal)
        rgba = Image.new("RGBA", im.size)
        px, dst = im.load(), rgba.load()
        for y in range(im.height):
            for x in range(im.width):
                i = px[x, y]
                dst[x, y] = (0, 0, 0, 0) if i == 0 else (*colors[i % len(colors)], 255)
        rgba.resize((256, 256), Image.NEAREST).save(out / f"{sid}{suffix}.png")
        done += 1
print("exported", done, "sprites to", out)
