"""Draws the fixed character reference sheet (character_sheet.png) from assets/*.png."""
import json
from PIL import Image, ImageDraw, ImageFont

FONT_DIR = "/usr/share/fonts/opentype/inter/"
tl = json.load(open("timeline.json"))
NOTES = {
    "boy": ["Age ~11, the curious one", "Fluffy black hair, big brown eyes", "White tee, silver chain", "Black joggers"],
    "young_man": ["Age ~25, the problem-solver", "Long dark hair, short beard", "Black tee, gold chain, gold bracelet", "Gold watch, black jeans, black boots"],
    "delivery": ["Age ~28, the helper", "Red cap and red zip jacket", "Grey trousers, brown boots", "Always carries the cardboard box"],
    "elder": ["Age ~65, the mentor", "Grey hair, grey mustache", "Navy polo, brown belt and watch", "Beige trousers, brown shoes"],
}
W, H = 2400, 1500
sheet = Image.new("RGB", (W, H), "#f4f1ea")
d = ImageDraw.Draw(sheet)
title = ImageFont.truetype(FONT_DIR + "Inter-Black.otf", 72)
name = ImageFont.truetype(FONT_DIR + "Inter-ExtraBold.otf", 46)
body = ImageFont.truetype(FONT_DIR + "Inter-Medium.otf", 28)
d.text((80, 50), "THE POWER OF ONE SMALL IDEA — CHARACTER REFERENCE", font=title, fill="#1d2433")
d.text((80, 140), "Locked designs: use these exact faces, hair, clothes, accessories and proportions in every shot.", font=body, fill="#5a6273")
col = W // 4
for i, cid in enumerate(["boy", "young_man", "delivery", "elder"]):
    c = tl["characters"][cid]
    img = Image.open(f"assets/{cid}.png")
    # relative heights match the film (the boy's reference ends at the thigh)
    h = int(c["height"] * 1.18)
    img = img.resize((int(img.width * h / img.height), h), Image.LANCZOS)
    x0 = i * col
    d.rounded_rectangle((x0 + 30, 210, x0 + col - 30, H - 40), 30, fill="#ffffff")
    base = 1180
    sheet.paste(img, (x0 + col // 2 - img.width // 2, base - h), img)
    d.rectangle((x0 + 30, base, x0 + col - 30, base + 6), fill=c["color"])
    d.text((x0 + 60, base + 30), c["name"], font=name, fill="#1d2433")
    for k, line in enumerate(NOTES[cid]):
        d.text((x0 + 60, base + 95 + k * 40), "• " + line, font=body, fill="#3d4556")
sheet.save("character_sheet.png", optimize=True)
print("character_sheet.png")
