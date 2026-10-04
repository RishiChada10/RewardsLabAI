"""Build the Claude artifact version of the site into build/artifact/.

The artifact publisher wraps the page in its own <!doctype>/<head>/<body>
skeleton, so this strips ours and moves <title> and the stylesheet link to the
top. The JS, CSS, and prompts are published alongside as separate files.
"""

import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
OUT = ROOT / "build" / "artifact"
FILES = ["app.js", "ai.mjs", "economics.mjs", "styles.css", "prompts.json"]


def main() -> None:
    html = (DIST / "index.html").read_text()
    title = re.search(r"<title>.*?</title>", html, re.S).group(0)
    body = re.search(r"<body>(.*)</body>", html, re.S).group(1).strip()
    page = f'{title}\n<link rel="stylesheet" href="styles.css" />\n{body}\n'
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    (OUT / "index.html").write_text(page)
    for name in FILES:
        shutil.copy2(DIST / name, OUT / name)
    print(f"Built {OUT.relative_to(ROOT)} ({len(FILES) + 1} files)")


if __name__ == "__main__":
    main()
