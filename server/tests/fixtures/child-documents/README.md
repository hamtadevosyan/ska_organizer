These files contain only the words “Synthetic document only.” They contain no
real child details, medical information, signatures, photographs or EXIF data.

- `synthetic.pdf` is a complete one-page PDF with a catalog, page tree, standard
  Helvetica font, text stream, cross-reference table and EOF marker.
- `synthetic.png` is a 180 × 100 RGB image with black text on white.
- `synthetic.jpg` is the same generated image encoded as JPEG at quality 92.

The document API tests read these committed bytes directly. They do not require
Pillow, a browser, an external scanner, OCR or any remote service. Additional
PNG encodings, inflated-data rejection cases and the exact-size 5 MB PDF are
generated in memory during the tests.
