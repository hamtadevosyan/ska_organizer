"""Prepare a private OCR image; never modify or replace the uploaded source."""
import os
import sys
import warnings


def main():
    os.umask(0o077)
    try:
        from PIL import Image, ImageOps
    except ImportError:
        sys.stderr.write("Local statement image preparation is not installed.\n")
        return 69
    if len(sys.argv) != 3:
        sys.stderr.write("Statement image preparation received invalid arguments.\n")
        return 65
    source_path, output_path = sys.argv[1:]
    Image.MAX_IMAGE_PIXELS = 20_000_000
    warnings.simplefilter("error", Image.DecompressionBombWarning)
    written = False
    try:
        with open(source_path, "rb") as source:
            with Image.open(source, formats=["JPEG", "PNG"]) as image:
                if image.format not in ("JPEG", "PNG"):
                    raise ValueError("Unsupported image")
                width, height = image.size
                if not width or not height or max(width, height) > 5000 or width * height > 20_000_000:
                    raise ValueError("Image bounds exceeded")
                if getattr(image, "n_frames", 1) != 1:
                    raise ValueError("Animated image")
                # EXIF orientations 1-8 include mirrored as well as rotated
                # phone photos. Work on a derived copy of the complete frame.
                oriented = ImageOps.exif_transpose(image)
                # Older system Pillow packages expose filters directly on Image.
                resampling = getattr(Image, "Resampling", Image)
                oriented.thumbnail((2200, 2200), resampling.LANCZOS)
                clean = Image.new("RGB", oriented.size, "white")
                if oriented.mode in ("RGBA", "LA") or "transparency" in oriented.info:
                    rgba = oriented.convert("RGBA")
                    clean.paste(rgba, (0, 0), rgba.getchannel("A"))
                else:
                    clean.paste(oriented.convert("RGB"), (0, 0))
                # A fresh image carries no source EXIF, ICC, comments or text.
                descriptor = os.open(output_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                written = True
                with os.fdopen(descriptor, "wb") as output:
                    clean.save(output, format="PNG", optimize=False)
                if os.stat(output_path).st_size > 16 * 1024 * 1024:
                    raise ValueError("Prepared image bounds exceeded")
        return 0
    except Exception:
        if written:
            try:
                os.unlink(output_path)
            except OSError:
                pass
        # Do not include source paths, filenames, metadata or document text.
        sys.stderr.write("This statement image could not be prepared safely.\n")
        return 65


if __name__ == "__main__":
    sys.exit(main())
