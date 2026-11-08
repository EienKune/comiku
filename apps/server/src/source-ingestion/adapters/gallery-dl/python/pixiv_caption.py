"""Normalize existing Pixiv caption HTML without fetching enrichment."""
from html.parser import HTMLParser

class CaptionParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def linebreak(self):
        if self.parts and not self.parts[-1].endswith("\n"):
            self.parts.append("\n")

    def handle_starttag(self, tag, attrs):
        if tag == "br":
            self.parts.append("\n")
        elif tag in ("p", "div", "li"):
            self.linebreak()

    def handle_endtag(self, tag):
        if tag in ("p", "div", "li"):
            self.linebreak()

    def handle_data(self, data):
        self.parts.append(data)


def plain_caption(value):
    if not isinstance(value, str) or not value.strip():
        return ""
    parser = CaptionParser()
    parser.feed(value)
    parser.close()
    return "".join(parser.parts).strip()
