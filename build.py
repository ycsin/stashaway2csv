# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Yong Cong Sin <yongcong.sin@gmail.com>
"""Assemble web/index.html: one self-contained file (pdf.js, worker, parser, UI inlined)."""
from pathlib import Path

HERE = Path(__file__).parent
parts = {
    "/*PDFJS*/": HERE / "vendor/pdf.min.js",
    "/*PDFJS_WORKER*/": HERE / "vendor/pdf.worker.min.js",
    "/*PARSER*/": HERE / "src/parser.js",
    "/*APP*/": HERE / "src/app.js",
}
html = (HERE / "src/index.template.html").read_text()
for marker, path in parts.items():
    code = path.read_text()
    if "</script" in code.lower() or "<!--" in code:
        raise SystemExit(f"{path} contains a sequence that would break inline <script>")
    assert html.count(marker) == 1, marker
    html = html.replace(marker, code)
out = HERE / "index.html"
out.write_text(html)
print(f"wrote {out} ({out.stat().st_size // 1024} KiB)")
