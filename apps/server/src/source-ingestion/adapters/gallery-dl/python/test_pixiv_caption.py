import unittest
from pixiv_caption import plain_caption

class CaptionTests(unittest.TestCase):
    def test_plain_text_preserves_breaks_links_and_entities(self):
        self.assertEqual("First & second\nLink label <student>\nLast\nline", plain_caption('First &amp; second<br><a href="/jump.php?private">Link label</a> &lt;student&gt;<p>Last\nline</p>'))
    def test_empty_caption(self):
        for caption in (None, "", "   "):
            self.assertEqual("", plain_caption(caption))

if __name__ == "__main__":
    unittest.main()
