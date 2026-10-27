# Synthetic statement fixtures

These files contain only invented children, references and amounts. They are
generic labelled payment examples, not copies of an official CCRC statement
layout and not evidence that every CCRC export format is supported.

Each JSON file stores the original fixture filename, MIME type and base64 bytes
as an ordinary `DocumentFile` upload. Tests decode and process real PDF/JPEG/PNG
bytes; text storage keeps the patch installer portable.

The labelled PDF has two pages: Ada Synthetic / CCRC-A paid $600 and Ben
Synthetic / CCRC-B paid $400 for October 2026, with a November 20 payment date
and a $1,000 statement total. Its uncompressed reference `SYN-CCRC-2026-11` can
be replaced with equal-length ASCII bytes in isolated browser fixtures.

The scanned PDF rasterizes both pages. The hybrid PDF adds searchable text
above the scanned tables, exercising OCR fallback despite a searchable header.
The photo fixtures show one $600 receipt. The locked PDF tests safe rejection.
