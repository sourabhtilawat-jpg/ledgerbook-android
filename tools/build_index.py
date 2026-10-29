"""Turns the Ledgerbook web page (ledgerbook.html, as published on claude.ai) into the
offline app page app/src/main/assets/www/index.html: adds the HTML skeleton and swaps
Google Fonts for the font files bundled in assets/www/fonts.
Usage: python3 tools/build_index.py path/to/ledgerbook.html"""
import re, sys, pathlib
src = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
root = pathlib.Path(__file__).resolve().parent.parent
faces = [("IBM Plex Sans", "ibm-plex-sans", w) for w in (400, 500, 600, 700)] + \
        [("IBM Plex Mono", "ibm-plex-mono", w) for w in (400, 500)]
font_css = "".join(
    f'@font-face{{font-family:"{fam}";font-style:normal;font-weight:{w};font-display:swap;'
    f'src:url(fonts/{slug}-latin-{w}-normal.woff2) format("woff2")}}\n' for fam, slug, w in faces)
src = re.sub(r'<link rel="preconnect"[^>]*>\s*', "", src)
src = re.sub(r'<link rel="stylesheet" href="https://fonts.googleapis.com[^>]*>\s*', "", src)
src = re.sub(r'<meta name="claude:viewport-fit-sides"[^>]*>\s*', "", src)
title = re.search(r"<title>.*?</title>", src).group(0)
src = src.replace(title, "", 1)
head = ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
        f'{title}<style>{font_css}'
        ':root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}'
        'body{margin:0;font:14px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}img{max-width:100%}'
        '[hidden]{display:none!important}</style></head><body>')
out = root / "app/src/main/assets/www/index.html"
out.write_text(head + src + "</body></html>", encoding="utf-8")
print("wrote", out, out.stat().st_size, "bytes")
