from PIL import Image, ImageDraw
import os

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "icons")
os.makedirs(OUT_DIR, exist_ok=True)

# oklch(62% 0.17 45) approx -> warm amber/orange, matches design accent color
AMBER = (219, 111, 45, 255)

def rounded_square(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    radius = round(size * 0.28)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=AMBER)
    # simple "++" mark in the center, matching the USOS++ wordmark accent
    plus_color = (255, 255, 255, 255)
    cx, cy = size / 2, size / 2
    bar = max(1, round(size * 0.09))
    arm = round(size * 0.30)
    draw.rectangle([cx - bar / 2, cy - arm / 2, cx + bar / 2, cy + arm / 2], fill=plus_color)
    draw.rectangle([cx - arm / 2, cy - bar / 2, cx + arm / 2, cy + bar / 2], fill=plus_color)
    return img

for size in (16, 32, 48, 128):
    rounded_square(size).save(os.path.join(OUT_DIR, f"icon{size}.png"))

print("done")
