import unittest
from unittest.mock import patch
import adapter
from gallery_dl.extractor import twitter, pixiv, common
from gallery_dl.extractor.common import Extractor

class ProfileTests(unittest.TestCase):
    def test_profile_metadata_uses_id_and_never_timeline(self):
        seen=[]
        def metadata(ext):
            seen.append(ext.user)
            return iter(((2, '', {'id': 42, 'name': 'latest_name', 'nick': 'Artist', 'profile_image': 'https://pbs.twimg.com/profile_images/42/a.jpg'}),))
        with patch.object(twitter.TwitterInfoExtractor, 'items', metadata), patch.object(twitter.TwitterAPI, 'user_tweets', side_effect=AssertionError('timeline must not run')):
            result=adapter.collect_profile({'platform':'x','remote_id':'42','handle':'stale_name'})
        self.assertEqual(['id:42'],seen)
        self.assertEqual('42',result['profile']['external_user_id'])
        self.assertEqual('latest_name',result['profile']['handle'])

    def test_native_info_metadata_uses_exact_api_without_timeline(self):
        user = {"rest_id": "42", "core": {"screen_name": "artist", "name": "Artist", "created_at": "Mon Jan 01 00:00:00 +0000 2024"},
                "legacy": {"description": "", "entities": {}}, "location": {"location": ""},
                "verification": {"verified": False}, "privacy": {"protected": False}, "avatar": {"image_url": ""}}
        seen = []
        def call(api, endpoint, params=None, **kwargs):
            seen.append(endpoint.rsplit("/", 1)[-1])
            self.assertIn(endpoint.rsplit("/", 1)[-1], ("UserByRestId", "UserByScreenName"))
            return {"data": {"user": {"result": user}}}
        with patch.object(twitter.TwitterAPI, "_call", call):
            by_id = adapter.collect_profile({"platform": "x", "remote_id": "42"})
            by_handle = adapter.collect_profile({"platform": "x", "handle": "artist"})
        self.assertEqual("artist", by_id["profile"]["handle"])
        self.assertEqual("42", by_handle["profile"]["external_user_id"])
        self.assertEqual(["UserByRestId", "UserByScreenName"], seen)

    def test_profile_rejects_mismatched_bound_id_and_handle(self):
        for source in ({'platform':'x','remote_id':'43'}, {'platform':'x','handle':'different'}):
            with self.subTest(source=source), patch.object(twitter.TwitterInfoExtractor,'items',lambda ext:iter(((2,'',{'id':42,'name':'artist','nick':'Artist'}),))):
                with self.assertRaisesRegex(adapter.AdapterError,'source_identity_conflict'):
                    adapter.collect_profile(source)

    def test_profile_rejects_missing_identity(self):
        for metadata in ({'id':42},{'name':'artist'},{'id':0,'name':'artist'}):
            with self.subTest(metadata=metadata),patch.object(twitter.TwitterInfoExtractor,'items',lambda ext:iter(((2,'',metadata),))):
                with self.assertRaises(adapter.AdapterError):
                    adapter.collect_profile({'platform':'x','handle':'artist'})



class PixivProfileTests(unittest.TestCase):
    def setUp(self):
        # user_detail caches by ID across extractor instances in gallery-dl.
        cache = patch.dict(common.CACHE_MEMORY, {}, clear=True)
        cache.start()
        self.addCleanup(cache.stop)

    def test_native_detail_uses_exact_id_without_enumerating_artworks(self):
        seen = []
        initialized = []
        original_initialize = Extractor.initialize

        def initialize(ext):
            original_initialize(ext)
            initialized.append(ext)

        def call(api, endpoint, params, **kwargs):
            self.assertIn(api.extractor, initialized)
            seen.append((endpoint, params))
            return {"user": {"id": 42, "account": "not_an_x_handle.at.all", "name": "  Artist  ",
                             "profile_image_urls": {"medium": "https://i.pximg.net/user-profile/a.jpg"}},
                    "profile": {"total_illusts": 0, "total_manga": 0}}

        with patch.object(Extractor, "initialize", initialize), \
             patch.object(pixiv.PixivUserExtractor, "items", side_effect=AssertionError("profile dispatch must not run")), \
             patch.object(pixiv.PixivArtworksExtractor, "items", side_effect=AssertionError("artworks must not run")), \
             patch.object(pixiv.PixivAppAPI, "user_illusts", side_effect=AssertionError("timeline must not run")), \
             patch.object(pixiv.PixivAppAPI, "_call", call):
            result = adapter.collect_profile({"platform": "pixiv", "remote_id": "42"})
        self.assertEqual([("/v1/user/detail", {"user_id": "42"})], seen)
        self.assertEqual({"version": 1, "platform": "pixiv", "profile": {
            "external_user_id": "42", "display_name": "Artist",
            "avatar_url": "https://i.pximg.net/user-profile/a.jpg"}}, result)

    def test_detail_accepts_no_avatar_and_falls_back_to_id_for_missing_name(self):
        for name in (None, "", "  "):
            with self.subTest(name=name), patch.dict(common.CACHE_MEMORY, {}, clear=True), patch.object(pixiv.PixivAppAPI, "_call", return_value={"user": {"id": "42", "name": name}}):
                profile = adapter.collect_profile({"platform": "pixiv", "remote_id": "42"})["profile"]
                self.assertEqual("42", profile["display_name"])
                self.assertIsNone(profile["avatar_url"])
                self.assertNotIn("handle", profile)

    def test_detail_rejects_missing_malformed_or_conflicting_identity(self):
        responses = (None, {}, {"user": {}}, {"user": {"id": 0}}, {"user": {"id": True}},
                     {"user": {"id": 42.0}}, {"user": {"id": "042"}}, {"user": {"id": "1" * 21}},
                     {"user": {"id": "43"}}, {"error": {"message": "error"}, "user": {"id": "42"}})
        for response in responses:
            with self.subTest(response=response), patch.dict(common.CACHE_MEMORY, {}, clear=True), patch.object(pixiv.PixivAppAPI, "_call", return_value=response):
                with self.assertRaises(adapter.AdapterError) as raised:
                    adapter.collect_profile({"platform": "pixiv", "remote_id": "42"})
                self.assertEqual("source_identity_conflict" if response == {"user": {"id": "43"}} else "source_unresolved", str(raised.exception))
                self.assertIn("diagnostic", raised.exception.result)

    def test_detail_rejects_invalid_requested_id_before_network(self):
        for remote_id in (None, "", "0", "042", "-1", "1" * 21, 42):
            with self.subTest(remote_id=remote_id), patch.object(pixiv.PixivAppAPI, "_call", side_effect=AssertionError("invalid ID must not request")):
                with self.assertRaisesRegex(adapter.AdapterError, "source_unresolved"):
                    adapter.collect_profile({"platform": "pixiv", "remote_id": remote_id})

    def test_detail_preserves_safe_auth_and_network_failures(self):
        class AuthenticationError(Exception):
            pass
        for error, code in ((AuthenticationError("private upstream text"), "auth_failed"),
                            (ConnectionError("network unavailable"), "network_error")):
            with self.subTest(code=code), patch.dict(common.CACHE_MEMORY, {}, clear=True), patch.object(pixiv.PixivAppAPI, "_call", side_effect=error):
                with self.assertRaisesRegex(adapter.AdapterError, code) as raised:
                    adapter.collect_profile({"platform": "pixiv", "remote_id": "42"})
                self.assertEqual(code, raised.exception.result["error"])
                self.assertIn("diagnostic", raised.exception.result)


if __name__ == "__main__":
    unittest.main()
