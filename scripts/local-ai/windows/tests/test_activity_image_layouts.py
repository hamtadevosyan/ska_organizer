"""Fixed reference geometry and rendered-pixel checks; no models or GPU."""
from collections import Counter
import importlib.util
from pathlib import Path
import tempfile
import unittest

from PIL import Image


SPEC = importlib.util.spec_from_file_location(
    "activity_image_layouts", Path(__file__).resolve().parents[1] / "activity_image_layouts.py")
LAYOUTS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LAYOUTS)


def front_components(image, color):
    """Count disconnected flat-colored cube fronts in actual rendered pixels."""
    small = image.resize((256, 256), Image.Resampling.NEAREST)
    pixels = small.load()
    remaining = {(x, y) for y in range(256) for x in range(256) if pixels[x, y] == color}
    groups = 0
    while remaining:
        groups += 1
        pending = [remaining.pop()]
        while pending:
            x, y = pending.pop()
            for adjacent in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if adjacent in remaining:
                    remaining.remove(adjacent)
                    pending.append(adjacent)
    small.close()
    return groups


class LayoutTests(unittest.TestCase):
    def test_every_step_keeps_the_same_six_named_cubes_inside_canvas(self):
        expected = {"red-1", "red-2", "blue-1", "blue-2", "yellow-1", "yellow-2"}
        for step in range(1, 5):
            with self.subTest(step=step):
                cubes = LAYOUTS.layout_plan(step)["cubes"]
                self.assertEqual({cube.name for cube in cubes}, expected)
                self.assertEqual(Counter(cube.color for cube in cubes), {"red": 2, "blue": 2, "yellow": 2})
                for cube in cubes:
                    left, top, right, bottom = LAYOUTS.cube_bounds(cube)
                    self.assertTrue(0 < left < right < 1024)
                    self.assertTrue(0 < top < bottom < 1024)

    def test_sorted_pairs_are_separate_columns_closer_within_each_pair(self):
        cubes = LAYOUTS.layout_plan(2)["cubes"]
        for color in ("red", "blue", "yellow"):
            pair = [cube for cube in cubes if cube.color == color]
            others = [cube for cube in cubes if cube.color != color]
            self.assertEqual(pair[0].x, pair[1].x)
            within = abs(pair[0].y - pair[1].y)
            self.assertLess(within, min(abs(pair[0].x - other.x) for other in others))
            self.assertLess(LAYOUTS.cube_bounds(pair[0])[3], LAYOUTS.cube_bounds(pair[1])[1])

    def test_tower_has_exactly_three_touching_cube_fronts_and_three_spares(self):
        cubes = LAYOUTS.layout_plan(3)["cubes"]
        tower = [cube for cube in cubes if cube.name.endswith("-1")]
        self.assertEqual([cube.color for cube in tower], ["red", "blue", "yellow"])
        self.assertEqual(len({cube.x for cube in tower}), 1)
        self.assertEqual(tower[0].y, tower[1].y + LAYOUTS.CUBE_EDGE)
        self.assertEqual(tower[1].y, tower[2].y + LAYOUTS.CUBE_EDGE)
        spares = [cube for cube in cubes if cube.name.endswith("-2")]
        self.assertEqual(len(spares), 3)
        self.assertGreater(min(cube.x for cube in spares), max(LAYOUTS.cube_bounds(cube)[2] for cube in tower))

    def test_all_six_box_cubes_are_fully_inside_the_open_rim_and_separate(self):
        plan = LAYOUTS.layout_plan(4)
        left, top, right, bottom = plan["container"]["inner"]
        rectangles = [LAYOUTS.cube_bounds(cube) for cube in plan["cubes"]]
        for x1, y1, x2, y2 in rectangles:
            self.assertTrue(left < x1 < x2 < right)
            self.assertTrue(top < y1 < y2 < bottom)
        for index, first in enumerate(rectangles):
            for second in rectangles[index + 1:]:
                self.assertTrue(first[2] < second[0] or second[2] < first[0]
                                or first[3] < second[1] or second[3] < first[1])

    def test_four_pngs_are_rgb_metadata_free_and_have_two_visible_fronts_per_color(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "inputs"
            records = LAYOUTS.create_layouts(directory)
            self.assertEqual(records, [{"step": step, "file": f"layout-step-{step}.png"} for step in range(1, 5)])
            self.assertEqual(sorted(path.name for path in directory.iterdir()), [record["file"] for record in records])
            for record in records:
                with self.subTest(step=record["step"]), Image.open(directory / record["file"]) as image:
                    self.assertEqual(image.size, (1024, 1024))
                    self.assertEqual(image.mode, "RGB")
                    self.assertEqual(image.info, {})
                    self.assertEqual(dict(image.getexif()), {})
                    self.assertEqual(image.getpixel((0, 0)), LAYOUTS.BACKGROUND)
                    for color in LAYOUTS.FRONT_COLORS.values():
                        self.assertEqual(front_components(image, color), 2)

    def test_one_png_and_existing_file_refusal_preserve_prior_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "inputs"
            self.assertEqual(LAYOUTS.create_layouts(directory, count=1), [{"step": 1, "file": "layout-step-1.png"}])
            original = (directory / "layout-step-1.png").read_bytes()
            with self.assertRaises(FileExistsError):
                LAYOUTS.create_layouts(directory, count=4)
            self.assertEqual((directory / "layout-step-1.png").read_bytes(), original)
            self.assertEqual(len(list(directory.iterdir())), 1)

    def test_invalid_arguments_do_not_create_a_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            for count, size in ((0, 1024), (2, 1024), (True, 1024), (4, 512), (4, True), ("4", 1024)):
                directory = Path(temporary) / "absent"
                with self.subTest(count=count, size=size), self.assertRaises(ValueError):
                    LAYOUTS.create_layouts(directory, count=count, size=size)
                self.assertFalse(directory.exists())
            for step in (0, 5, True, "1"):
                with self.assertRaises(ValueError):
                    LAYOUTS.layout_plan(step)

    def test_linked_directory_and_linked_output_are_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            ordinary = root / "ordinary"
            ordinary.mkdir()
            linked = root / "linked"
            try:
                linked.symlink_to(ordinary, target_is_directory=True)
            except OSError:
                self.skipTest("This host does not permit synthetic symlinks.")
            with self.assertRaises(ValueError):
                LAYOUTS.create_layouts(linked)
            (ordinary / "layout-step-1.png").symlink_to(root / "missing")
            with self.assertRaises(FileExistsError):
                LAYOUTS.create_layouts(ordinary)
            self.assertTrue((ordinary / "layout-step-1.png").is_symlink())


if __name__ == "__main__":
    unittest.main()
