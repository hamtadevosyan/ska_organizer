"""Draw fixed, synthetic reference layouts for the attended image benchmark.

These diagrams specify the intended six objects. They are input references,
not model-generated pictures or proof that a generated result is correct.
Pillow is already included in the managed ComfyUI portable runtime.
"""
from pathlib import Path
from typing import NamedTuple

from PIL import Image, ImageDraw


SIZE = 1024
CUBE_EDGE = 110
DEPTH = 32
BACKGROUND = (250, 247, 235)
OUTLINE = (47, 52, 62)
FRONT_COLORS = {
    "red": (218, 65, 60),
    "blue": (49, 118, 205),
    "yellow": (240, 194, 42),
}
BOX_OUTER = (156, 180, 902, 856)
BOX_INNER = (216, 240, 842, 796)


class Cube(NamedTuple):
    name: str
    color: str
    x: int
    y: int


_LAYOUTS = (
    (
        Cube("red-1", "red", 150, 250),
        Cube("blue-1", "blue", 440, 190),
        Cube("yellow-1", "yellow", 730, 270),
        Cube("yellow-2", "yellow", 230, 620),
        Cube("red-2", "red", 500, 560),
        Cube("blue-2", "blue", 740, 670),
    ),
    (
        Cube("red-1", "red", 115, 340),
        Cube("red-2", "red", 115, 525),
        Cube("blue-1", "blue", 440, 340),
        Cube("blue-2", "blue", 440, 525),
        Cube("yellow-1", "yellow", 765, 340),
        Cube("yellow-2", "yellow", 765, 525),
    ),
    (
        # Paint the tower from bottom to top so hidden top faces are covered.
        Cube("red-1", "red", 270, 700),
        Cube("blue-1", "blue", 270, 590),
        Cube("yellow-1", "yellow", 270, 480),
        Cube("red-2", "red", 660, 350),
        Cube("blue-2", "blue", 660, 550),
        Cube("yellow-2", "yellow", 660, 750),
    ),
    (
        Cube("red-1", "red", 275, 340),
        Cube("blue-1", "blue", 465, 340),
        Cube("yellow-1", "yellow", 655, 340),
        Cube("red-2", "red", 275, 590),
        Cube("blue-2", "blue", 465, 590),
        Cube("yellow-2", "yellow", 655, 590),
    ),
)


def cube_bounds(cube: Cube) -> tuple[int, int, int, int]:
    """Bounding rectangle of all three visible faces."""
    return (cube.x, cube.y - DEPTH, cube.x + CUBE_EDGE + DEPTH, cube.y + CUBE_EDGE)


def layout_plan(step: int) -> dict:
    """Return the fixed one-based step's inventory and intended placement."""
    if type(step) is not int or step not in (1, 2, 3, 4):
        raise ValueError("A layout step must be one of 1, 2, 3 or 4.")
    return {
        "step": step,
        "cubes": _LAYOUTS[step - 1],
        "container": {"outer": BOX_OUTER, "inner": BOX_INNER} if step == 4 else None,
    }


def _shade(color: tuple[int, int, int], amount: float) -> tuple[int, int, int]:
    if amount > 1:
        return tuple(round(channel + (255 - channel) * (amount - 1)) for channel in color)
    return tuple(round(channel * amount) for channel in color)


def _draw_cube(draw: ImageDraw.ImageDraw, cube: Cube):
    x, y, edge, depth = cube.x, cube.y, CUBE_EDGE, DEPTH
    color = FRONT_COLORS[cube.color]
    top = [(x, y), (x + depth, y - depth), (x + edge + depth, y - depth), (x + edge, y)]
    right = [(x + edge, y), (x + edge + depth, y - depth),
             (x + edge + depth, y + edge - depth), (x + edge, y + edge)]
    front = [(x, y), (x + edge, y), (x + edge, y + edge), (x, y + edge)]
    for polygon, fill in ((top, _shade(color, 1.23)), (right, _shade(color, .72)), (front, color)):
        draw.polygon(polygon, fill=fill)
        draw.line(polygon + [polygon[0]], fill=OUTLINE, width=5, joint="curve")


def _render_layout(step: int) -> Image.Image:
    plan = layout_plan(step)
    image = Image.new("RGB", (SIZE, SIZE), BACKGROUND)
    draw = ImageDraw.Draw(image)
    if plan["container"]:
        # An open tray, seen from above, keeps every cube visible inside its rim.
        # Separate wall tones and a narrow inner shadow make this read as a
        # shallow container rather than a flat picture frame.
        draw.rectangle(BOX_OUTER, fill=(201, 159, 104))
        walls = (
            ([(156, 180), (902, 180), (842, 240), (216, 240)], (221, 186, 136)),
            ([(156, 180), (216, 240), (216, 796), (156, 856)], (183, 137, 84)),
            ([(902, 180), (902, 856), (842, 796), (842, 240)], (205, 163, 109)),
            ([(156, 856), (902, 856), (842, 796), (216, 796)], (230, 194, 140)),
        )
        for polygon, color in walls:
            draw.polygon(polygon, fill=color)
            draw.line(polygon + [polygon[0]], fill=(133, 99, 62), width=3)
        draw.rectangle(BOX_INNER, fill=(244, 227, 195))
        draw.line([(220, 792), (220, 244), (838, 244)], fill=(211, 180, 135), width=9)
        draw.rectangle(BOX_OUTER, outline=OUTLINE, width=6)
        draw.rectangle(BOX_INNER, outline=OUTLINE, width=5)
    for cube in plan["cubes"]:
        _draw_cube(draw, cube)
    return image


def _ordinary_directory(directory: Path):
    for entry in (directory, *directory.parents):
        if entry.is_symlink():
            raise ValueError("Reference layouts require an ordinary directory path.")
    if directory.exists():
        if not directory.is_dir():
            raise ValueError("Reference layouts require an ordinary directory.")
    else:
        directory.mkdir(mode=0o700)


def create_layouts(directory: Path, count: int = 4, size: int = SIZE) -> list[dict]:
    """Create one or four 1024px RGB reference PNGs without overwriting files.

    The runner supplies a private input directory for its owned ComfyUI process.
    Returned filenames are fixed basenames usable by ComfyUI's LoadImage node.
    """
    if type(count) is not int or count not in (1, 4):
        raise ValueError("Reference layouts support one or four images.")
    if type(size) is not int or size != SIZE:
        raise ValueError("Reference layouts require the SDXL 1024px profile.")
    directory = Path(directory).absolute()
    _ordinary_directory(directory)
    records = [{"step": step, "file": f"layout-step-{step}.png"} for step in range(1, count + 1)]
    for record in records:
        target = directory / record["file"]
        if target.exists() or target.is_symlink():
            raise FileExistsError("An existing reference layout was preserved.")
    for record in records:
        image = _render_layout(record["step"])
        try:
            with (directory / record["file"]).open("xb") as stream:
                image.save(stream, format="PNG")
        finally:
            image.close()
    return records
