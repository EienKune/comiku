import unittest
from unittest.mock import patch
import adapter
from gallery_dl.extractor import twitter

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

if __name__=='__main__': unittest.main()
