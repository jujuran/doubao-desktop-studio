from pathlib import Path

from PIL import Image, ImageChops, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "build" / "icon-source.png"
BUILD_ICON = ROOT / "build" / "icon.png"
WINDOWS_ICON = ROOT / "build" / "icon.ico"
MAC_ICON = ROOT / "build" / "icon.icns"
RENDERER_ICON = ROOT / "src" / "assets" / "app-icon.png"

CANVAS_SIZE = 1024
CROP_MARGIN = 40
TILE_MARGIN = 24
TILE_RADIUS = 190


def render_icon() -> Image.Image:
    source = Image.open(SOURCE).convert("RGBA")
    width, height = source.size
    crop = source.crop(
        (CROP_MARGIN, CROP_MARGIN, width - CROP_MARGIN, height - CROP_MARGIN)
    ).resize((CANVAS_SIZE, CANVAS_SIZE), Image.Resampling.LANCZOS)

    tile_mask = Image.new("L", (CANVAS_SIZE, CANVAS_SIZE), 0)
    draw = ImageDraw.Draw(tile_mask)
    draw.rounded_rectangle(
        (
            TILE_MARGIN,
            TILE_MARGIN,
            CANVAS_SIZE - TILE_MARGIN - 1,
            CANVAS_SIZE - TILE_MARGIN - 1,
        ),
        radius=TILE_RADIUS,
        fill=255,
    )

    tile = Image.new("RGBA", (CANVAS_SIZE, CANVAS_SIZE), (0, 0, 0, 0))
    tile_draw = ImageDraw.Draw(tile)
    tile_draw.rounded_rectangle(
        (
            TILE_MARGIN,
            TILE_MARGIN,
            CANVAS_SIZE - TILE_MARGIN - 1,
            CANVAS_SIZE - TILE_MARGIN - 1,
        ),
        radius=TILE_RADIUS,
        fill=(252, 253, 255, 255),
    )

    crop.putalpha(ImageChops.multiply(crop.getchannel("A"), tile_mask))
    tile.alpha_composite(crop)
    return tile


def main() -> None:
    icon = render_icon()
    BUILD_ICON.parent.mkdir(parents=True, exist_ok=True)
    RENDERER_ICON.parent.mkdir(parents=True, exist_ok=True)
    icon.save(BUILD_ICON, optimize=True)
    icon.save(RENDERER_ICON, optimize=True)
    icon.save(
        WINDOWS_ICON,
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    icon.save(MAC_ICON, format="ICNS")


if __name__ == "__main__":
    main()
