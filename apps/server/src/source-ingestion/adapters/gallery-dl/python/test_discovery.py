"""D7 native proof and single-post regressions. Synthetic upstream only."""
import unittest
from unittest.mock import patch
from gallery_dl import exception
from gallery_dl.extractor import pixiv
import adapter
from test_pixiv_paging import PixivUpstream, ajax_work
import test_pixiv_paging as paging_fixtures
import test_adapter as x_fixtures
import json
from gallery_dl.extractor import twitter


class DiscoveryTests(unittest.TestCase):
    setUp = paging_fixtures.PixivPagingTests.setUp
    x_entry = staticmethod(x_fixtures.AdapterTests.x_entry)
    def test_known_catalog_notfound_has_exact_proof_and_good_siblings(self):
        upstream = PixivUpstream(self, [[]], [ajax_work(100), ajax_work(200), ajax_work(300)])
        def unavailable(state, post_id):
            if post_id == "200":
                raise exception.NotFoundError("artwork")
        upstream.on_detail = unavailable
        with upstream.installed():
            first = adapter.collect(self.source, None)
            page = adapter.collect(self.source, first["next"])
        self.assertTrue(page["page_complete"])
        self.assertTrue(page["terminal"])
        self.assertEqual(["200"], page["failed_ids"])
        proof = page["enumeration_proof"]
        self.assertEqual("author_catalog", proof["kind"])
        self.assertEqual({"100", "200", "300"}, set(proof["ids"]))
        self.assertEqual({"100", "300"}, set(proof["resolved_ids"]))
        self.assertEqual("metadata_unavailable", page["discovery_failures"][0]["failure_code"])
        self.assertNotIn("date", page["discovery_failures"][0])

    def test_missing_batch_entry_is_confirmed_by_detail_before_stub(self):
        upstream = PixivUpstream(self, [[]], [ajax_work(100)])
        del upstream.briefs["100"]
        with upstream.installed():
            first = adapter.collect(self.source, None)
            page = adapter.collect(self.source, first["next"])
        self.assertTrue(page["page_complete"])
        self.assertEqual([], page["failed_ids"])
        self.assertEqual(["100"], [str(r[-1]["id"]) for r in page["records"] if r[0] == 2])
        self.assertEqual(["100"], upstream.detail_ids)

    def test_internal_post_validates_real_owner_and_manifest(self):
        with patch.object(pixiv.PixivWorkExtractor, "_request_ajax", return_value=ajax_work(100)):
            page = adapter.collect_post({"platform":"pixiv", "remote_id":"42"}, "100")
        self.assertEqual("ready", page["post_status"])
        self.assertEqual(["100"], [str(r[-1]["id"]) for r in page["records"] if r[0] == 2])
        with patch.object(pixiv.PixivWorkExtractor, "_request_ajax", return_value=ajax_work(100, owner="99")):
            page = adapter.collect_post({"platform":"pixiv", "remote_id":"42"}, "100")
        self.assertEqual("excluded", page["post_status"])
        self.assertEqual("99", page["verified"]["source_id"])
        self.assertEqual([], page["records"])

    def test_post_huge_count_rejected_before_native_allocation(self):
        work=ajax_work(100)
        work["pageCount"]=1000000000
        with patch.object(pixiv.PixivWorkExtractor, "_request_ajax", return_value=work):
            with self.assertRaises(adapter.AdapterError):
                adapter.collect_post({"platform":"pixiv", "remote_id":"42"}, "100")

    def test_x_internal_own_quote_reply_and_snowflakes_use_one_native_target(self):
        post_id, owner = "798688505224273923", "798688505224273921"
        for marker in ("quoted_status_id_str", "in_reply_to_status_id_str"):
            with self.subTest(marker=marker):
                raw=x_fixtures.AdapterTests.native_media_entry(self,post_id,marker)["content"]["itemContent"]["tweet_results"]["result"]
                raw["legacy"]["user_id_str"]=owner
                raw["legacy"]["extended_entities"]["media"][0]["id"]=798688505224273925
                raw["core"]["user_results"]["result"]["rest_id"]=owner
                calls=[]
                def fetch(api,requested):
                    calls.append(requested)
                    return raw
                with patch.object(twitter.TwitterAPI,"tweet_result_by_rest_id",fetch), patch.object(twitter.TwitterTweetExtractor,"login",lambda ext:None):
                    result=adapter.collect_post({"platform":"x","remote_id":owner},post_id)
                self.assertEqual([post_id],calls)
                self.assertEqual("ready",result["post_status"])
                wire=json.loads(json.dumps(adapter.stringify_ids(result),default=str))
                media=[r for r in wire["records"] if r[0]==3]
                self.assertEqual(1,len(media))
                self.assertEqual(post_id,media[0][-1]["tweet_id"])
                self.assertEqual(owner,media[0][-1]["author"]["id"])
                self.assertEqual("300000000000000001",media[0][-1]["quoted_id" if marker.startswith("quoted") else "reply_id"])

    def test_x_internal_foreign_empty_substitution_and_shared_errors(self):
        raw=x_fixtures.AdapterTests.native_media_entry(self,"100")["content"]["itemContent"]["tweet_results"]["result"]
        with patch.object(twitter.TwitterTweetExtractor,"login",lambda ext:None):
            with patch.object(twitter.TwitterAPI,"tweet_result_by_rest_id",return_value=raw):
                result=adapter.collect_post({"platform":"x","remote_id":"99"},"100")
                self.assertEqual("foreign",result["reason"])
                self.assertEqual("42",result["verified"]["source_id"])
                with self.assertRaises(adapter.AdapterError):
                    adapter.collect_post({"platform":"x","remote_id":"42"},"101")
            with patch.object(twitter.TwitterAPI,"tweet_result_by_rest_id",return_value={}):
                with self.assertRaises(adapter.AdapterError):
                    adapter.collect_post({"platform":"x","remote_id":"42"},"100")
            for message,reason in (("429 rate limit","rate_limited"),("authentication failed","auth_failed")):
                with patch.object(twitter.TwitterAPI,"tweet_result_by_rest_id",side_effect=RuntimeError(message)):
                    with self.assertRaisesRegex(adapter.AdapterError,reason):
                        adapter.collect_post({"platform":"x","remote_id":"42"},"100")

    def test_catalog_leaf_auth_and_rate_limit_never_become_metadata_stubs(self):
        for reason in ("auth_failed","rate_limited","network_error"):
            upstream=PixivUpstream(self,[[]],[ajax_work(100)])
            def unavailable(state,post_id):
                raise adapter.AdapterError(reason)
            upstream.on_detail=unavailable
            with upstream.installed():
                first=adapter.collect(self.source,None)
                with self.assertRaisesRegex(adapter.AdapterError,reason) as caught:
                    adapter.collect(self.source,first["next"])
            self.assertFalse(caught.exception.result["page_complete"])
            self.assertNotIn("enumeration_proof",caught.exception.result)

    def test_present_metadata_cdn_head_404_is_not_metadata_notfound(self):
        from gallery_dl.extractor import common
        from types import SimpleNamespace
        upstream=PixivUpstream(self,[[]],[ajax_work(100)])
        upstream.details["100"]["urls"]["original"]=None
        upstream.details["100"]["userIllusts"]={"100":{"url":"https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/10/03/10/00/00/100_p0_square1200.jpg"}}
        with upstream.installed(), patch.object(common.Extractor,"request",return_value=SimpleNamespace(status_code=404)):
            first=adapter.collect(self.source,None)
            try:
                result=adapter.collect(self.source,first["next"])
            except adapter.AdapterError as exc:
                result=exc.result
        self.assertIsNotNone(result)
        self.assertFalse(result["page_complete"])
        self.assertNotIn("enumeration_proof",result)
        self.assertNotIn("discovery_failures",result)


if __name__ == "__main__":
    unittest.main()
