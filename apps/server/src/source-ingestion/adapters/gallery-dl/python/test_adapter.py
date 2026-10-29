import datetime
import copy
import json
import io
import unittest
import socket
import requests
from unittest.mock import patch

try:
    import adapter
except ImportError:
    adapter = None

from gallery_dl import config, exception
from gallery_dl.util import NullResponse
from gallery_dl.extractor import twitter, pixiv, common


class AdapterTests(unittest.TestCase):
    def test_bound_x_uses_numeric_id_not_stale_handle(self):
        source = {"platform": "x", "remote_id": "42", "handle": "old_name"}
        original = twitter.TwitterWithRepliesExtractor.from_url
        seen = []
        def capture(url):
            seen.append(url)
            return original(url)
        with patch.object(twitter.TwitterWithRepliesExtractor, "from_url", capture), patch.object(twitter.TwitterWithRepliesExtractor, "tweets", lambda e: iter(())), patch.object(twitter.TwitterWithRepliesExtractor, "items", lambda e: iter(())):
            try:
                adapter.collect(source, None)
            except adapter.AdapterError:
                pass  # URL assertion is independent of HTTP fixture coverage.
        self.assertEqual(["https://x.com/id:42/with_replies"], seen)

    def test_missing_user_is_source_failure_after_identity_resolution(self):
        # Run gallery-dl's own user resolver against a missing-user response.
        # Only upstream HTTP is replaced; the numeric identity is already known.
        def vanished(api, endpoint, params=None, **kwargs):
            return {"data": {}}
        with patch.object(twitter.TwitterAPI, "_call", vanished):
            with self.assertRaisesRegex(adapter.AdapterError, "source_not_found") as failure:
                adapter.collect(self.source, None)
        result = failure.exception.result
        self.assertEqual("42", result["source_id"])
        self.assertFalse(result["terminal"])
        self.assertFalse(result["boundary"])
        self.assertEqual("NotFoundError", result["diagnostic"]["exception_type"])
        self.assertIn("Requested user could not be found", result["diagnostic"]["message"])
        self.assertIn("Traceback", result["diagnostic"]["traceback"])

    def test_missing_post_does_not_implicate_source_or_shared_credentials(self):
        self.assertEqual("post_not_found", adapter.safe_error(exception.NotFoundError("tweet")))
        self.assertEqual("post_not_found", adapter.safe_error(exception.NotFoundError("artwork")))
        self.assertEqual("connector_failed", adapter.safe_error(exception.NotFoundError("resource")))

    def collect_http_fixture(self, timeline_responses):
        user = self.native_media_entry("100")["content"]["itemContent"]["tweet_results"]["result"]["core"]["user_results"]["result"]
        config.set(("extractor", "twitter"), "cookies", {"auth_token": "fixture-secret-token", "ct0": "fixture-csrf-value"})
        responses = iter(timeline_responses)
        def request(ext, url, **kwargs):
            if url.endswith("UserByRestId"):
                return self.http_response(200, json.dumps({"data": {"user": {"result": user}}}))
            self.assertTrue(url.endswith("UserTweetsAndReplies"), url)
            return next(responses)
        with patch.object(twitter.TwitterExtractor, "request", request), \
                patch.object(twitter.TwitterAPI, "_transaction_id", lambda *args: None), \
                patch.object(twitter.TwitterAPI, "_handle_ratelimit", lambda *args: None), \
                patch.object(twitter.TwitterWithRepliesExtractor, "items", self.x_conversion):
            return adapter.collect(dict(self.source, cutoff="2026-10-03T00:00:00Z"), "same")

    def http_response(self, status, body):
        response = requests.Response()
        response.status_code = status
        response.reason = "Not Found" if status == 404 else "fixture"
        response._content = body.encode("utf-8")
        response.url = "https://x.com/graphql/fixture/UserTweetsAndReplies?cursor=private-cursor&auth_token=fixture-secret-token"
        # Independent opaque IDs: these must survive while cookie/token canaries do not.
        response.headers.update({"Content-Type": "text/html", "CF-Ray": "cf-a7d3b9e2", "X-Request-Id": "req-9c5e7a1b", "X-Rate-Limit-Remaining": "10", "Set-Cookie": "auth_token=fixture-secret-token", "Location": "https://private.invalid/?token=fixture-secret-token"})
        return response

    def test_failed_native_http_keeps_bounded_response_before_abort_discards_it(self):
        adapter.diagnostic_secrets.extend(["fixture-secret-token", "fixture-csrf-value"])
        for body in ("", "<h1>Unavailable</h1>", json.dumps({"errors": [{"code": 999, "message": ""}]}), "x" * 6000 + "fixture-secret-token"):
            common.CACHE_MEMORY.clear()
            with self.subTest(body_size=len(body)), self.assertRaisesRegex(adapter.AdapterError, "connector_failed") as caught:
                self.collect_http_fixture([self.http_response(404, body)])
            detail = caught.exception.result["diagnostic"]
            self.assertEqual("404", detail.get("http_status"))
            self.assertEqual("GET", detail.get("http_method"))
            self.assertTrue(detail.get("http_endpoint", "").endswith("UserTweetsAndReplies"))
            self.assertEqual(str(len(body.encode())), detail.get("http_response_bytes"))
            excerpt = detail.get("http_response_excerpt")
            self.assertIsNotNone(excerpt)
            self.assertLessEqual(len(excerpt), 4200)
            self.assertEqual(body, excerpt) if len(body) <= 4096 else self.assertIn("truncated", excerpt)
            headers = json.loads(detail.get("http_response_headers", "{}"))
            self.assertEqual("cf-a7d3b9e2", headers.get("cf-ray"))
            self.assertEqual("req-9c5e7a1b", headers.get("x-request-id"))
            self.assertNotIn("set-cookie", headers)
            self.assertNotIn("location", headers)
            raw = json.dumps(detail)
            self.assertNotIn("private-cursor", raw)
            self.assertNotIn("fixture-secret-token", raw)
            self.assertFalse(caught.exception.result["terminal"])

    def test_recovered_http_error_is_not_attached_to_successful_empty_end(self):
        limit = self.http_response(429, json.dumps({"errors": [{"message": "Rate limit"}]}))
        success = self.http_response(200, json.dumps(self.repeated_empty_response()))
        page = self.collect_http_fixture([limit, success])
        self.assertTrue(page["empty_cursor_repeat"])
        self.assertNotIn("http_response_excerpt", page.get("diagnostic", {}))

    def test_http_diagnostic_suppresses_known_secrets_before_capping(self):
        adapter.diagnostic_secrets.append("fixture-secret-token")
        body = "x" * 4085 + "fixture-secret-token" + "rest"
        with self.assertRaises(adapter.AdapterError) as caught:
            self.collect_http_fixture([self.http_response(404, body)])
        excerpt = caught.exception.result["diagnostic"].get("http_response_excerpt", "")
        self.assertIn("[credential", excerpt)
        self.assertNotIn("fixture-se", excerpt)

    def test_http_capture_failure_does_not_replace_original_abort(self):
        with patch.object(adapter, "http_failure_diagnostic", side_effect=ValueError("fixture malformed response")), \
                self.assertRaisesRegex(adapter.AdapterError, "connector_failed") as caught:
            self.collect_http_fixture([self.http_response(404, "")])
        detail = caught.exception.result["diagnostic"]
        self.assertEqual("404 Not Found ()", detail["message"])
        self.assertEqual("response_capture_failed", detail["http_diagnostic_error"])

    def test_http_failure_survives_native_return_then_paginator_exception(self):
        for body in ('{}', '{"errors":[]}', '{"data":{}}'):
            common.CACHE_MEMORY.clear()
            with self.subTest(body=body), self.assertRaises(adapter.AdapterError) as caught:
                self.collect_http_fixture([self.http_response(404, body)])
            detail = caught.exception.result["diagnostic"]
            self.assertEqual("404", detail.get("http_status"))
            self.assertEqual(body, detail.get("http_response_excerpt"))
            self.assertFalse(caught.exception.result["terminal"])

    def setUp(self):
        self.assertIsNotNone(adapter, "native page adapter is missing")
        guard = patch.object(socket.socket, "connect", side_effect=AssertionError("network forbidden in adapter tests"))
        guard.start()
        self.addCleanup(guard.stop)
        config.clear()
        common.CACHE_MEMORY.clear()
        adapter.diagnostic_secrets.clear()
        adapter.diagnostic_handler.messages.clear()
        config.set(("extractor",), "sleep-request", 0)
        config.set(("extractor", "pixiv"), "sanity", False)
        self.source = {"platform": "x", "remote_id": "42", "handle": "synthetic"}

    def test_x_complete_page_and_resume_over_120_posts(self):
        # Exercise the pinned native paginator; only upstream HTTP and per-post
        # conversion are controlled. Truncating at 50 would lose posts here.
        pages = [[str(i) for i in range(1000, 1070)], [str(i) for i in range(1070, 1140)]]
        def response(api, endpoint, params, **kwargs):
            variables = json.loads(params["variables"])
            index = 1 if variables.get("cursor") == "page2" else 0
            entries = [{"entryId": "tweet-"+id, "content": {"itemContent": {"tweet_results": {"result": {"rest_id": id, "core": {"user_results": {"result": {"rest_id": "42"}}}, "legacy": {"id_str": id, "user_id_str": "42", "created_at": "Fri Oct 02 10:00:00 +0000 2026"}}}}}} for id in pages[index]]
            entries.append({"entryId": "cursor-bottom-0", "content": {"value": "page2" if index == 0 else ""}})
            return {"data": {"timeline": {"instructions": [{"type": "TimelineAddEntries", "entries": entries}]}}}
        def native_tweets(extr):
            return extr.api._pagination_tweets("fixture", {"count": 100}, path=("timeline",))
        def conversion(extr):
            for raw in extr.tweets():
                yield 2, "", {"tweet_id": raw["rest_id"], "author": {"id": "42"}, "date": "2026-10-02 10:00:00", "count": 1}
        with patch.object(twitter.TwitterAPI, "_call", response), patch.object(twitter.TwitterWithRepliesExtractor, "tweets", native_tweets), patch.object(twitter.TwitterWithRepliesExtractor, "items", conversion):
            first = adapter.collect(self.source, None)
            self.assertEqual(70, len(first["records"]))
            self.assertEqual("page2", first["next"])
            second = adapter.collect(self.source, first["next"])
            self.assertEqual(70, len(second["records"]))
            self.assertTrue(second["terminal"])
            self.assertEqual(140, len({r[1]["tweet_id"] for r in first["records"]+second["records"]}))

    def test_pixiv_native_next_url_and_foreign_context(self):
        source = {"platform": "pixiv", "remote_id": "42"}
        seen = []
        def response(api, endpoint, params=None, **kwargs):
            seen.append(dict(params))
            offset = int(params.get("offset", 0))
            return {"user": {"id": 42}, "illusts": [{"id": offset+1, "user": {"id": 42}, "type": "illust", "create_date": "2026-10-01T10:00:00+00:00", "page_count": 1, "meta_pages": []}, {"id": offset+2, "user": {"id": 99}}], "next_url": "https://app-api.pixiv.net/v1/user/illusts?user_id=42&offset=30&filter=for_ios" if offset == 0 else None}
        def conversion(extr):
            for work in extr.works():
                yield 2, "", {"id": work["id"], "user": work["user"]}
        with patch.object(pixiv.PixivAppAPI, "_call", response), patch.object(pixiv.PixivArtworksExtractor, "items", conversion):
            page = adapter.collect(source, None)
            self.assertEqual(1, len(page["records"]))
            self.assertEqual("30", page["next"]["offset"])
            self.assertEqual(["1", "2"], page["next"].get("_ids"))
            end = adapter.collect(source, page["next"])
            self.assertTrue(end["terminal"])
            self.assertEqual("0", seen[1]["offset"])
            self.assertEqual("30", seen[2]["offset"])
            self.assertEqual("0", seen[3]["offset"])
            self.assertEqual(4, len(seen))

    def collect_pixiv_sanity_fixture(self, ajax_work, cutoff="2026-09-30T00:00:00Z"):
        config.set(("extractor", "pixiv"), "sanity", True)
        work = {
            "id": 100, "user": {"id": 42}, "type": "illust",
            "create_date": "2026-10-01T10:00:00+00:00",
            "meta_single_page": {"original_image_url": "https://i.pximg.net/img-original/img/2026/10/01/10/00/00/100_p0.jpg"},
            "meta_pages": [], "image_urls": {}, "tags": [], "x_restrict": 0,
            "page_count": 1,
        }
        app_page = {"user": {"id": 42}, "illusts": [work], "next_url": None}
        def ajax(ext, path):
            if path == "/user/42/profile/all":
                return {"illusts": {"100": {}, "200": {}}, "manga": {}}
            if path.startswith("/user/42/profile/illusts?"):
                baseline = self.pixiv_ajax_work()
                value = ajax_work if isinstance(ajax_work, dict) else baseline
                return {"works": {
                    "100": {"id": "100", "userId": "42", "illustType": 0, "createDate": work["create_date"]},
                    "200": {"id": "200", "userId": "42", "illustType": value.get("illustType") if type(value.get("illustType")) is int and value["illustType"] in (0, 1, 2) else 0,
                            "createDate": value.get("createDate") or baseline["createDate"]},
                }}
            if path == "/illust/100":
                value = self.pixiv_ajax_work()
                value.update(id="100", createDate=work["create_date"])
                value["urls"]["original"] = work["meta_single_page"]["original_image_url"]
                return value
            self.assertEqual("/illust/200", path)
            if isinstance(ajax_work, Exception):
                raise ajax_work
            return ajax_work
        with patch.object(pixiv.PixivAppAPI, "_call", side_effect=lambda *args, **kwargs: copy.deepcopy(app_page)), \
                patch.object(pixiv.PixivArtworksExtractor, "_request_ajax", ajax):
            records, cursor = [], None
            for _ in range(5):
                try:
                    page = adapter.collect({"platform": "pixiv", "remote_id": "42", "cutoff": cutoff}, cursor)
                except adapter.AdapterError as exc:
                    page = exc.result
                    if page is None:
                        raise
                    records.extend(page["records"])
                    break
                records.extend(page["records"])
                if page["terminal"]:
                    break
                cursor = page["next"]
            # Production persistence deduplicates observations across the union;
            # this fixture combines those pages for the original media assertions.
            unique = {}
            for record in records:
                unique.setdefault((record[0], str(record[-1]["id"]), record[-1].get("num")), record)
            page["records"] = list(unique.values())
            return page

    @staticmethod
    def pixiv_ajax_work(owner="42", date="2026-10-01T10:00:00+00:00"):
        return {
            "id": "200", "urls": {"original": "https://i.pximg.net/img-original/img/2026/10/01/10/00/00/200_p0.jpg"},
            "illustTitle": "Synthetic", "createDate": date,
            "width": 100, "height": 100, "sl": 0, "viewCount": 0,
            "commentCount": 0, "bookmarkCount": 0, "restrict": 0,
            "xRestrict": 0, "aiType": 0, "bookStyle": 0,
            "userAccount": "synthetic", "userId": owner, "userName": "Synthetic",
            "tags": {"tags": []}, "illustComment": "", "pageCount": 1, "illustType": 0,
        }

    def test_pixiv_sanity_resolves_author_before_collecting_missing_work(self):
        page = self.collect_pixiv_sanity_fixture(self.pixiv_ajax_work())
        self.assertEqual([100, 200], [record[-1]["id"] for record in page["records"] if record[0] == 2])
        self.assertEqual([42, 42], [record[-1]["user"]["id"] for record in page["records"] if record[0] == 3])
        self.assertEqual([], page["failed_ids"])
        self.assertFalse(page["boundary"])
        self.assertTrue(page["terminal"])
        self.assertTrue(page["terminal"])
        self.assertTrue(page["page_complete"])

    def test_pixiv_sanity_recent_resolved_work_prevents_old_boundary(self):
        page = self.collect_pixiv_sanity_fixture(self.pixiv_ajax_work(date="2026-10-03T10:00:00+00:00"))
        self.assertEqual([100, 200], [record[-1]["id"] for record in page["records"] if record[0] == 2])
        self.assertFalse(page["boundary"])

    def test_pixiv_sanity_static_types_are_preserved_after_native_conversion(self):
        for ajax_type, native_type in ((0, "illust"), (1, "manga")):
            with self.subTest(ajax_type=ajax_type):
                payload = self.pixiv_ajax_work()
                payload["illustType"] = ajax_type
                page = self.collect_pixiv_sanity_fixture(payload)
                self.assertEqual([native_type, native_type],
                                 [record[-1]["type"] for record in page["records"] if record[-1]["id"] == 200])
                self.assertEqual([], page["failed_ids"])

    def test_pixiv_sanity_animation_is_marked_unsupported_without_first_frame_media(self):
        payload = self.pixiv_ajax_work()
        payload["illustType"] = 2
        payload["urls"]["original"] = "https://i.pximg.net/img-original/img/2026/10/01/10/00/00/200_ugoira0.jpg"
        page = self.collect_pixiv_sanity_fixture(payload)
        self.assertEqual([], [record for record in page["records"] if record[-1]["id"] == 200])
        self.assertEqual([100], [record[-1]["id"] for record in page["records"] if record[0] == 3])
        self.assertEqual([], page["failed_ids"])
        self.assertTrue(page["page_complete"])
        self.assertTrue(page["terminal"])

    def test_pixiv_sanity_unknown_type_cannot_be_a_complete_static_work(self):
        for ajax_type in (None, 3, "2", True):
            with self.subTest(ajax_type=ajax_type):
                payload = self.pixiv_ajax_work()
                if ajax_type is None:
                    del payload["illustType"]
                else:
                    payload["illustType"] = ajax_type
                page = self.collect_pixiv_sanity_fixture(payload)
                self.assertIn("200", page["failed_ids"])
                self.assertEqual([100], [record[-1]["id"] for record in page["records"] if record[0] == 2])
                self.assertFalse(page["boundary"])

    def test_pixiv_sanity_resolved_foreign_work_is_not_collected(self):
        page = self.collect_pixiv_sanity_fixture(self.pixiv_ajax_work(owner="99"))
        self.assertEqual([100], [record[-1]["id"] for record in page["records"] if record[0] == 2])
        self.assertIn("200", page["failed_ids"])
        self.assertFalse(page["page_complete"])

    def test_pixiv_sanity_failed_resolution_cannot_complete_scan(self):
        missing_author = self.pixiv_ajax_work()
        del missing_author["userId"]
        for payload in (None, {}, missing_author, self.pixiv_ajax_work(owner="0"),
                        requests.exceptions.ConnectionError("synthetic AJAX failure")):
            with self.subTest(payload=payload):
                try:
                    page = self.collect_pixiv_sanity_fixture(payload)
                except adapter.AdapterError as exc:
                    page = exc.result
                self.assertIn("200", page["failed_ids"])
                self.assertEqual([100], [record[-1]["id"] for record in page["records"] if record[0] == 2])
                self.assertFalse(page["boundary"])

    def test_pixiv_forbidden_continuation(self):
        for url in ["https://evil.test/v1/user/illusts?user_id=42&offset=30", "https://app-api.pixiv.net/v1/novel?user_id=42&offset=30", "https://app-api.pixiv.net/v1/user/illusts?user_id=99&offset=30", "https://app-api.pixiv.net/v1/user/illusts?user_id=42&offset=30&url=evil", "https://app-api.pixiv.net/v1/user/illusts?user_id=42&offset=30&offset=60"]:
            with self.subTest(url=url), self.assertRaises(adapter.AdapterError):
                adapter.pixiv_cursor(url, "42")

    def test_malformed_post_keeps_id_and_later_posts(self):
        def tweets(extr):
            for id, owner in [("100", "42"), ("101", "99"), ("102", "42")]:
                yield {"legacy": {"id_str": id, "user_id_str": owner}}
            extr._update_cursor("next")
        def conversion(extr):
            for raw in extr.tweets():
                if raw["legacy"]["id_str"] == "100":
                    raise KeyError("synthetic missing media")
                yield 2, "", {"tweet_id": raw["legacy"]["id_str"]}
        with patch.object(twitter.TwitterWithRepliesExtractor, "tweets", tweets), patch.object(twitter.TwitterWithRepliesExtractor, "items", conversion):
            page = adapter.collect(self.source, None)
            self.assertEqual(["100"], page["failed_ids"])
            self.assertEqual("102", page["records"][0][1]["tweet_id"])
            self.assertEqual("next", page["next"])

    def test_repeated_and_invalid_cursor_do_not_claim_terminal(self):
        def repeated(extr):
            extr._update_cursor("same")
            yield
        with patch.object(twitter.TwitterWithRepliesExtractor, "tweets", repeated):
            with self.assertRaisesRegex(adapter.AdapterError, "cursor_invalid"):
                adapter.collect(self.source, "same")
        def invalid(extr):
            raise exception.AbortExtraction("Invalid cursor")
            yield
        with patch.object(twitter.TwitterWithRepliesExtractor, "tweets", invalid):
            with self.assertRaisesRegex(adapter.AdapterError, "cursor_invalid"):
                adapter.collect(self.source, "expired")

    def test_text_only_old_page_reaches_boundary_and_unknown_date_does_not(self):
        def tweets(extr):
            yield {"legacy": {"id_str": "100", "user_id_str": "42", "created_at": "Thu Oct 01 10:00:00 +0000 2026"}}
            extr._update_cursor("next")
        def no_media(extr):
            for _ in extr.tweets():
                pass
            return
            yield
        with patch.object(twitter.TwitterWithRepliesExtractor, "tweets", tweets), patch.object(twitter.TwitterWithRepliesExtractor, "items", no_media):
            source = dict(self.source, cutoff="2026-10-02T00:00:00Z")
            page = adapter.collect(source, None)
            self.assertTrue(page["boundary"])
            self.assertEqual([], page["records"])

    def test_nanosecond_cutoff_is_accepted(self):
        def tweets(extr):
            yield {"legacy": {"id_str": "100", "user_id_str": "42", "created_at": "Thu Oct 01 10:00:00 +0000 2026"}}
            extr._update_cursor(None)

        def conversion(extr):
            for raw in extr.tweets():
                yield 2, "", {"tweet_id": raw["legacy"]["id_str"]}

        source = dict(self.source, cutoff="2026-10-02T00:00:00.123456789Z")
        with patch.object(twitter.TwitterWithRepliesExtractor, "tweets", tweets), patch.object(twitter.TwitterWithRepliesExtractor, "items", conversion):
            page = adapter.collect(source, None)
            self.assertTrue(page["boundary"])
            self.assertEqual("100", page["records"][0][1]["tweet_id"])

    def test_rfc3339nano_cutoff_supports_trimmed_fraction_and_offsets(self):
        for fraction, expected_micros in (("", 0), (".1", 100000), (".12", 120000),
                                         (".123", 123000), (".1234", 123400),
                                         (".12345", 123450), (".123456", 123456),
                                         (".1234567", 123456), (".12345678", 123456),
                                         (".123456789", 123456)):
            for suffix in ("Z", "+00:00", "+08:00"):
                with self.subTest(fraction=fraction, suffix=suffix):
                    value = adapter.parse_cutoff("2026-10-02T00:00:00" + fraction + suffix)
                    self.assertEqual(expected_micros, value.microsecond)
                    self.assertEqual(datetime.timedelta(hours=8 if suffix == "+08:00" else 0), value.utcoffset())

    def test_pixiv_rate_limit_returns_without_waiting(self):
        def response(ext, *args, **kwargs):
            class Response:
                status_code = 429
                def json(self):
                    return {"error": {"message": "Rate limit exceeded"}}
            return Response()
        with patch.object(pixiv.PixivAppAPI, "login", lambda api: None), patch.object(pixiv.PixivArtworksExtractor, "request", response), patch.object(pixiv.PixivArtworksExtractor, "wait", side_effect=AssertionError("unexpected 300 second upstream sleep")):
            with self.assertRaisesRegex(adapter.AdapterError, "rate_limited"):
                adapter.collect({"platform": "pixiv", "remote_id": "42"}, None)

    def test_pixiv_overlap_rejects_shift_even_when_anchor_remains(self):
        source = {"platform": "pixiv", "remote_id": "42"}
        ids = list(range(100, 240))
        def response(api, endpoint, params=None, **kwargs):
            offset = int(params.get("offset", 0))
            works = [{"id": id, "user": {"id": 42}, "type": "illust", "create_date": "2026-10-01T10:00:00+00:00", "page_count": 1, "meta_pages": []} for id in ids[offset:offset+30]]
            next_url = "https://app-api.pixiv.net/v1/user/illusts?user_id=42&offset="+str(offset+30) if offset+30<len(ids) else None
            return {"user": {"id":42}, "illusts":works, "next_url":next_url}
        def conversion(ext):
            for raw in ext.works():
                yield 2, "", raw
        with patch.object(pixiv.PixivAppAPI, "_call", response), patch.object(pixiv.PixivArtworksExtractor, "items", conversion):
            page=adapter.collect(source,None)
            ids.remove(100)  # 130 now precedes the stored next offset (30).
            with self.assertRaisesRegex(adapter.AdapterError,"cursor_invalid"):
                adapter.collect(source,page["next"])
            ids[:]=list(range(100,240))
            page=adapter.collect(source,None)
            ids[:0]=list(range(50,85)) # Anchor pushed outside overlap page.
            with self.assertRaisesRegex(adapter.AdapterError,"cursor_invalid"):
                adapter.collect(source,page["next"])

    def test_unknown_post_identity_blocks_checkpoint(self):
        def tweets(ext):
            yield {"legacy":{"id_str":"100"}}
            ext._update_cursor("next")
        with patch.object(twitter.TwitterWithRepliesExtractor,"tweets",tweets):
            with self.assertRaisesRegex(adapter.AdapterError,"discovery_incomplete"):
                adapter.collect(self.source,None)

    def test_native_repeated_x_cursor_is_not_false_completion(self):
        def response(api, endpoint, params, **kwargs):
            return {"data":{"timeline":{"instructions":[{"type":"TimelineAddEntries","entries":[{"entryId":"cursor-bottom-0","content":{"value":"same"}}]}]}}}
        def tweets(ext):
            return ext.api._pagination_tweets("fixture",{"count":100},path=("timeline",))
        with patch.object(twitter.TwitterAPI,"_call",response),patch.object(twitter.TwitterWithRepliesExtractor,"tweets",tweets):
            with self.assertRaisesRegex(adapter.AdapterError,"cursor_invalid"):
                adapter.collect(self.source,"same")

    def repeated_empty_response(self, entries=None, instructions=None, response_id="42"):
        if entries is None:
            entries = [
                {"entryId": "cursor-top-0", "content": {"cursorType": "Top", "value": "head"}},
                {"entryId": "cursor-bottom-0", "content": {"cursorType": "Bottom", "value": "same"}},
            ]
        return {"data": {"user": {"result": {"rest_id": response_id, "timeline": {"timeline": {
            "instructions": instructions or [{"type": "TimelineAddEntries", "entries": entries}]
        }}}}}}

    def collect_bound_response(self, data, user_id="42", cursor="same"):
        # Exercise the native numeric-ID resolver and paginator, replacing only HTTP.
        user = self.native_media_entry("100")["content"]["itemContent"]["tweet_results"]["result"]["core"]["user_results"]["result"]
        user["rest_id"] = user_id
        def response(api, endpoint, params, **kwargs):
            if endpoint.endswith("UserByRestId"):
                return {"data": {"user": {"result": user}}}
            self.assertTrue(endpoint.endswith("UserTweetsAndReplies"), endpoint)
            return data
        with patch.object(twitter.TwitterAPI, "_call", response), \
                patch.object(twitter.TwitterWithRepliesExtractor, "items", self.x_conversion):
            return adapter.collect(dict(self.source, cutoff="2026-10-03T00:00:00Z"), cursor)

    def test_bound_empty_repeat_yields_explicit_end_evidence(self):
        for stop in (None, True):
            with self.subTest(stop=stop):
                data = self.repeated_empty_response()
                if stop is not None:
                    data["data"]["user"]["result"]["timeline"]["timeline"]["instructions"][0]["entries"][1]["content"]["stopOnEmptyResponse"] = stop
                page = self.collect_bound_response(data)
                self.assertTrue(page.get("empty_cursor_repeat"))
                self.assertTrue(page["page_complete"])
                self.assertTrue(page["terminal"])
                self.assertIsNone(page["next"])
                self.assertEqual([], page["records"])
                self.assertEqual([], page["failed_ids"])
                self.assertEqual("x_empty_cursor_repeat", page["diagnostic"]["guard"])

    def test_empty_repeat_rejects_nonempty_or_ambiguous_raw_response(self):
        for variant in ("text", "retweet", "unknown", "stop_false", "stop_string", "two_bottom", "wrong_type", "unknown_instruction", "errors", "wrong_identity", "hidden_items", "hidden_instruction", "hidden_top", "malformed_errors", "hidden_sort_index", "hidden_cursor_meta", "hidden_wrapper_meta", "top_stop_string"):
            with self.subTest(variant=variant):
                data = self.repeated_empty_response()
                instructions = data["data"]["user"]["result"]["timeline"]["timeline"]["instructions"]
                entries = instructions[0]["entries"]
                if variant in ("text", "retweet"):
                    entry = self.x_entry("100")
                    if variant == "retweet":
                        entry["content"]["itemContent"]["tweet_results"]["result"]["legacy"]["retweeted_status_id_str"] = "99"
                    entries.insert(0, entry)
                elif variant == "unknown": entries.insert(0, {"entryId": "future-1", "content": {}})
                elif variant == "stop_false": entries[1]["content"]["stopOnEmptyResponse"] = False
                elif variant == "stop_string": entries[1]["content"]["stopOnEmptyResponse"] = "true"
                elif variant == "two_bottom": entries.append(dict(entries[1]))
                elif variant == "wrong_type": entries[1]["content"]["cursorType"] = "Top"
                elif variant == "unknown_instruction": instructions.append({"type": "FutureInstruction"})
                elif variant == "errors": data["errors"] = [{"message": "partial response"}]
                elif variant == "wrong_identity": data["data"]["user"]["result"]["rest_id"] = "99"
                elif variant == "hidden_items": entries[1]["content"] = {"itemContent": entries[1]["content"], "items": [self.x_entry("100")]}
                elif variant == "hidden_instruction": instructions[0]["moduleItems"] = [self.x_entry("100")]
                elif variant == "hidden_top": entries[0]["item"] = self.x_entry("100")["content"]
                elif variant == "malformed_errors": data["errors"] = {}
                elif variant == "hidden_sort_index": entries[1]["sortIndex"] = {"tweet_results": self.x_entry("100")}
                elif variant == "hidden_cursor_meta": entries[1]["content"]["__typename"] = self.x_entry("100")
                elif variant == "hidden_wrapper_meta": entries[1]["content"] = {"itemContent": entries[1]["content"], "entryType": self.x_entry("100")}
                elif variant == "top_stop_string": entries[0]["content"]["stopOnEmptyResponse"] = "true"
                with self.assertRaises(adapter.AdapterError) as caught:
                    self.collect_bound_response(data)
                self.assertFalse(caught.exception.result.get("empty_cursor_repeat", False))
                self.assertFalse(caught.exception.result["terminal"])

    def test_internal_repeat_failure_keeps_guard_and_page_summary(self):
        with self.assertRaises(adapter.AdapterError) as caught:
            self.collect_bound_response(self.repeated_empty_response([self.x_entry("100"), {
                "entryId": "cursor-bottom-0", "content": {"cursorType": "Bottom", "value": "same"}}]))
        detail = caught.exception.result.get("diagnostic", {})
        self.assertEqual("x_repeated_cursor", detail.get("guard"))
        self.assertEqual("true", detail.get("same_cursor"))
        self.assertIn("ordinary", detail.get("coverage", ""))
        self.assertEqual("2", detail.get("response_entry_count"))
        self.assertIn("inspect", detail.get("validation_site", ""))
        self.assertIn("Traceback", detail.get("traceback", ""))
        self.assertNotIn('"same"', json.dumps(detail))

    def test_null_transport_response_is_not_a_missing_user(self):
        # gallery-dl normally turns this synthetic response into {} then NotFoundError.
        with patch.object(twitter.TwitterAPI, "_transaction_id", lambda *args: None), \
                patch.object(twitter.TwitterExtractor, "request", return_value=NullResponse("https://x.com/graphql/UserByRestId", "ProxyError: connection closed")):
            with self.assertRaises(adapter.AdapterError) as caught:
                adapter.collect(self.source, None)
        self.assertEqual("network_error", str(caught.exception))
        detail = caught.exception.result["diagnostic"]
        self.assertEqual("transport_null_response", detail["guard"])
        self.assertIn("ProxyError", detail["transport_reason"])

    def test_previous_proxy_warning_does_not_override_real_missing_user(self):
        adapter.diagnostic_handler.messages.append("ProxyError: previous request recovered")
        with patch.object(twitter.TwitterAPI, "_call", return_value={"data": {}}):
            with self.assertRaisesRegex(adapter.AdapterError, "source_not_found"):
                adapter.collect(self.source, None)

    def test_early_adapter_validation_has_private_diagnostic(self):
        request = {"source": self.source, "cursor": {}, "config": "not-read", "cache": "not-read"}
        stdout = io.StringIO()
        with patch("builtins.open", return_value=io.StringIO(json.dumps(request))), \
                patch.object(config, "load", lambda *args, **kwargs: None), \
                patch.object(adapter.sys, "argv", ["adapter", "not-read"]), \
                patch.object(adapter.sys, "stdout", stdout):
            adapter.main()
        result = json.loads(stdout.getvalue())
        self.assertEqual("cursor_invalid", result["error"])
        self.assertEqual("AdapterError", result.get("diagnostic", {}).get("exception_type"))
        self.assertIn("Traceback", result["diagnostic"]["traceback"])

    def test_later_internal_failure_keeps_its_guard_after_conversion_error(self):
        def tweets(ext):
            yield {"legacy": {"id_str": "100", "user_id_str": "42"}}
            raise adapter.AdapterError("cursor_invalid", guard="synthetic_later_guard")
        def conversion(ext):
            for raw in ext.tweets():
                raise ValueError("earlier conversion error")
                yield
        with patch.object(twitter.TwitterWithRepliesExtractor, "tweets", tweets), \
                patch.object(twitter.TwitterWithRepliesExtractor, "items", conversion):
            with self.assertRaises(adapter.AdapterError) as caught:
                adapter.collect(self.source, "previous")
        detail = caught.exception.result["diagnostic"]
        self.assertEqual("synthetic_later_guard", detail.get("guard"))
        self.assertIn("earlier conversion error", detail.get("previous_diagnostic", ""))

    def test_native_x_malformed_entry_cannot_disappear(self):
        def response(api, endpoint, params, **kwargs):
            return {"data":{"timeline":{"instructions":[{"type":"TimelineAddEntries","entries":[{"entryId":"tweet-100","content":{"itemContent":{}}},{"entryId":"cursor-bottom-0","content":{"value":"next"}}]}]}}}
        def tweets(ext):
            return ext.api._pagination_tweets("fixture",{"count":100},path=("timeline",))
        with patch.object(twitter.TwitterAPI,"_call",response),patch.object(twitter.TwitterWithRepliesExtractor,"tweets",tweets):
            with self.assertRaisesRegex(adapter.AdapterError,"discovery_incomplete"):
                adapter.collect(self.source,None)

    def test_empty_native_x_page_preserves_next_then_reads_populated_page(self):
        calls = []
        def response(api, endpoint, params, **kwargs):
            current = json.loads(params["variables"]).get("cursor")
            calls.append(current)
            entries = [] if current is None else [self.x_entry("200")]
            entries.append({"entryId":"cursor-bottom-0","content":{"value":"after-empty" if current is None else ""}})
            return self.x_response(entries)
        with patch.object(twitter.TwitterAPI,"_call",response), patch.object(twitter.TwitterWithRepliesExtractor,"tweets",self.native_x_tweets), patch.object(twitter.TwitterWithRepliesExtractor,"items",self.x_conversion):
            first=adapter.collect(self.source,None)
            self.assertFalse(first["terminal"])
            self.assertEqual("after-empty",first["next"])
            self.assertEqual([],first["records"])
            second=adapter.collect(self.source,first["next"])
            self.assertTrue(second["terminal"])
            self.assertEqual("200",second["records"][0][1]["tweet_id"])
            self.assertEqual([None,"after-empty"],calls)

    def test_native_x_malformed_modules_preserve_attributable_id_and_valid_sibling(self):
        for prefix in ("profile-conversation-", "homeConversation-", "conversationthread-", "profile-grid-", "search-grid-", "communities-grid-"):
            for instruction in ("TimelineAddEntries", "TimelineAddToModule"):
                with self.subTest(prefix=prefix,instruction=instruction):
                    bad=self.x_entry("100",module=True)
                    # Native paginator discards this missing-legacy result, but
                    # rest_id plus core author still establish attribution.
                    del bad["item"]["itemContent"]["tweet_results"]["result"]["legacy"]
                    good=self.x_entry("200",module=True)
                    entries=[{"entryId":prefix+"1","content":{"items":[bad,good]}},{"entryId":"cursor-bottom-0","content":{"value":"next"}}] if instruction=="TimelineAddEntries" else [bad,good,{"entryId":"cursor-bottom-0","content":{"value":"next"}}]
                    field="entries" if instruction=="TimelineAddEntries" else "moduleItems"
                    data={"data":{"timeline":{"instructions":[{"type":instruction,field:entries}]}}}
                    with patch.object(twitter.TwitterAPI,"_call",return_value=data), patch.object(twitter.TwitterWithRepliesExtractor,"tweets",self.native_x_tweets), patch.object(twitter.TwitterWithRepliesExtractor,"items",self.x_conversion):
                        page=adapter.collect(self.source,None)
                        self.assertEqual(["100"],page["failed_ids"])
                        self.assertEqual(["200"],[r[1]["tweet_id"] for r in page["records"]])
                        self.assertEqual("next",page["next"])

    def test_native_x_unattributed_module_record_blocks_page_with_valid_sibling(self):
        bad={"entryId":"profile-conversation-1-tweet-100","item":{"itemContent":{"tweet_results":{"result":{"rest_id":"100"}}}}}
        entries=[{"entryId":"profile-conversation-1","content":{"items":[bad,self.x_entry("200",module=True)]}},{"entryId":"cursor-bottom-0","content":{"value":"next"}}]
        with patch.object(twitter.TwitterAPI,"_call",return_value=self.x_response(entries)), patch.object(twitter.TwitterWithRepliesExtractor,"tweets",self.native_x_tweets), patch.object(twitter.TwitterWithRepliesExtractor,"items",self.x_conversion):
            with self.assertRaisesRegex(adapter.AdapterError,"discovery_incomplete"):
                adapter.collect(self.source,None)

    def test_arbitrary_module_child_id_is_durable_and_valid_sibling_survives(self):
        for prefix in ("profile-conversation-", "homeConversation-", "conversationthread-", "profile-grid-", "search-grid-", "communities-grid-"):
            with self.subTest(prefix=prefix):
                bad=self.x_entry("100",module=True)
                bad["entryId"]="module-item-100"
                del bad["item"]["itemContent"]["tweet_results"]["result"]["legacy"]
                good=self.x_entry("200",module=True)
                good["entryId"]="module-item-200"
                entries=[{"entryId":prefix+"1","content":{"items":[bad,good]}},{"entryId":"cursor-bottom-0","content":{"value":"next"}}]
                with patch.object(twitter.TwitterAPI,"_call",return_value=self.x_response(entries)), patch.object(twitter.TwitterWithRepliesExtractor,"tweets",self.native_x_tweets), patch.object(twitter.TwitterWithRepliesExtractor,"items",self.x_conversion):
                    page=adapter.collect(self.source,None)
                    self.assertEqual(["100"],page["failed_ids"])
                    self.assertEqual(["200"],[r[1]["tweet_id"] for r in page["records"]])
                    self.assertFalse(page["terminal"])
                    self.assertEqual("next",page["next"])

    def test_arbitrary_unattributed_module_child_cannot_advance(self):
        bad={"entryId":"module-item-100","item":{"itemContent":{"tweet_results":{"result":{"rest_id":"100"}}}}}
        entries=[{"entryId":"profile-conversation-1","content":{"items":[bad,self.x_entry("200",module=True)]}},{"entryId":"cursor-bottom-0","content":{"value":"next"}}]
        with patch.object(twitter.TwitterAPI,"_call",return_value=self.x_response(entries)), patch.object(twitter.TwitterWithRepliesExtractor,"tweets",self.native_x_tweets), patch.object(twitter.TwitterWithRepliesExtractor,"items",self.x_conversion):
            with self.assertRaisesRegex(adapter.AdapterError,"discovery_incomplete"):
                adapter.collect(self.source,None)

    @staticmethod
    def x_entry(id,module=False):
        return {"entryId":("profile-conversation-1-tweet-" if module else "tweet-")+id,("item" if module else "content"):{"itemContent":{"tweet_results":{"result":{"rest_id":id,"legacy":{"id_str":id,"user_id_str":"42","created_at":"Fri Oct 02 10:00:00 +0000 2026"},"core":{"user_results":{"result":{"rest_id":"42"}}}}}}}}

    def native_media_entry(self, id, marker=None, old=False):
        entry = self.x_entry(id)
        tweet = entry["content"]["itemContent"]["tweet_results"]["result"]
        legacy = tweet["legacy"]
        legacy.update(lang="ja", entities={}, extended_entities={"media": [{
            "type": "photo", "media_url_https": "https://pbs.twimg.com/media/synthetic.jpg",
            "original_info": {"width": 100, "height": 100},
        }]})
        if marker:
            legacy[marker] = "300000000000000001"
        if old:
            legacy["created_at"] = "Thu Oct 01 10:00:00 +0000 2026"
        tweet["core"]["user_results"]["result"].update(
            screen_name="synthetic", name="Synthetic", created_at=legacy["created_at"],
            location="", description="", profile_image_url_https="", verified=False, protected=False)
        return entry

    def collect_native_media(self, entries, cutoff="2026-10-02T00:00:00Z"):
        entries = entries + [{"entryId": "cursor-bottom-0", "content": {"value": "next"}}]
        # Only the external page, login, and account lookup are replaced.
        # Native items(), filtering, media extraction and transformation run.
        with patch.object(twitter.TwitterAPI, "_call", return_value=self.x_response(entries)), \
                patch.object(twitter.TwitterWithRepliesExtractor, "tweets", self.native_x_tweets), \
                patch.object(twitter.TwitterWithRepliesExtractor, "login", lambda ext: None), \
                patch.object(twitter.TwitterWithRepliesExtractor, "metadata", lambda ext: {}):
            return adapter.collect(dict(self.source, cutoff=cutoff), None)

    def test_native_unavailable_photo_cannot_silently_create_half_post(self):
        entry = self.native_media_entry("100", old=True)
        media = entry["content"]["itemContent"]["tweet_results"]["result"]["legacy"]["extended_entities"]["media"]
        media.append(dict(media[0], media_url_https="https://pbs.twimg.com/media/missing.jpg", ext_media_availability={"status": "Unavailable"}))
        page = self.collect_native_media([entry])
        self.assertEqual(["100"], page["failed_ids"])
        self.assertEqual([], page["records"])
        self.assertFalse(page["boundary"])

    def test_native_filtered_media_do_not_fail_or_establish_boundary(self):
        for marker in ("retweeted_status_id_str", "quoted_by_id_str"):
            with self.subTest(marker=marker):
                page = self.collect_native_media([self.native_media_entry("100", marker, old=True)])
                self.assertEqual([], page["records"])
                self.assertEqual([], page["failed_ids"])
                self.assertFalse(page["boundary"])
                self.assertFalse(page["terminal"])
                self.assertEqual("next", page["next"])

    def test_native_filtered_media_does_not_block_ordinary_old_boundary(self):
        page = self.collect_native_media([
            self.native_media_entry("100", "retweeted_status_id_str"),
            self.native_media_entry("101", "quoted_by_id_str"),
            self.native_media_entry("200", old=True),
        ])
        self.assertEqual([], page["failed_ids"])
        self.assertEqual([200], [r[1]["tweet_id"] for r in page["records"] if r[0] == 2])
        self.assertTrue(page["boundary"])
        self.assertEqual("next", page["next"])

    def collect_x_fixture(self, entries):
        entries = entries + [{"entryId": "cursor-bottom-0", "content": {"value": "next"}}]
        with patch.object(twitter.TwitterAPI, "_call", return_value=self.x_response(entries)), \
                patch.object(twitter.TwitterWithRepliesExtractor, "tweets", self.native_x_tweets), \
                patch.object(twitter.TwitterWithRepliesExtractor, "items", self.x_conversion):
            return adapter.collect(dict(self.source, cutoff="2026-10-02T00:00:00Z"), None)

    def test_x_verified_old_owned_module_supplies_boundary_without_order_evidence(self):
        old = self.x_entry("100", module=True)
        old["item"]["itemContent"]["tweet_results"]["result"]["legacy"]["created_at"] = "Thu Oct 01 10:00:00 +0000 2026"
        page = self.collect_x_fixture([{"entryId": "profile-conversation-1", "content": {"items": [old]}}])
        self.assertTrue(page["boundary"])
        self.assertIsNone(page["first_date"])
        self.assertIsNone(page["last_date"])
        self.assertTrue(page.get("page_complete"))
        self.assertEqual(["100"], [record[1]["tweet_id"] for record in page["records"]])

    def test_x_confirmed_foreign_context_does_not_block_old_boundary(self):
        for module, unknown in ((False, False), (False, True), (True, False)):
            with self.subTest(module=module, unknown=unknown):
                old = self.x_entry("100")
                old["content"]["itemContent"]["tweet_results"]["result"]["legacy"]["created_at"] = "Thu Oct 01 10:00:00 +0000 2026"
                foreign = self.x_entry("200", module=module)
                item = foreign["item" if module else "content"]["itemContent"]["tweet_results"]["result"]
                item["legacy"]["user_id_str"] = "99"
                item["core"]["user_results"]["result"]["rest_id"] = "99"
                if unknown:
                    del item["legacy"]["created_at"]
                context = {"entryId": "profile-conversation-1", "content": {"items": [foreign]}} if module else foreign
                page = self.collect_x_fixture([old, context])
                self.assertTrue(page["boundary"])
                self.assertFalse(page["terminal"])
                self.assertEqual(["100"], [record[1]["tweet_id"] for record in page["records"]])

    def test_x_observed_date_inversion_blocks_boundary(self):
        first, second = self.x_entry("100"), self.x_entry("200")
        first["content"]["itemContent"]["tweet_results"]["result"]["legacy"]["created_at"] = "Thu Oct 01 09:00:00 +0000 2026"
        second["content"]["itemContent"]["tweet_results"]["result"]["legacy"]["created_at"] = "Thu Oct 01 10:00:00 +0000 2026"
        page = self.collect_x_fixture([first, second])
        self.assertFalse(page["boundary"])
        self.assertTrue(page["order_anomaly"])
        self.assertEqual("2026-10-01T09:00:00Z", page["first_date"])
        self.assertEqual("2026-10-01T10:00:00Z", page["last_date"])

    def test_x_nonchronological_context_does_not_poison_order_evidence(self):
        first, second = self.x_entry("100"), self.x_entry("200")
        first["content"]["itemContent"]["tweet_results"]["result"]["legacy"]["created_at"] = "Thu Oct 01 10:00:00 +0000 2026"
        second["content"]["itemContent"]["tweet_results"]["result"]["legacy"]["created_at"] = "Thu Oct 01 09:00:00 +0000 2026"
        context = self.x_entry("300", module=True)
        context["item"]["itemContent"]["tweet_results"]["result"]["legacy"]["created_at"] = "Fri Oct 02 10:00:00 +0000 2026"
        page = self.collect_x_fixture([first, {"entryId": "profile-conversation-1", "content": {"items": [context]}}, second])
        self.assertFalse(page["boundary"])
        self.assertFalse(page["order_anomaly"])
        self.assertEqual("2026-10-01T10:00:00Z", page["first_date"])
        self.assertEqual("2026-10-01T09:00:00Z", page["last_date"])

    def test_x_ordinary_old_batch_has_boundary_and_order_evidence(self):
        first, second = self.x_entry("100"), self.x_entry("200")
        first["content"]["itemContent"]["tweet_results"]["result"]["legacy"]["created_at"] = "Thu Oct 01 10:00:00 +0000 2026"
        second["content"]["itemContent"]["tweet_results"]["result"]["legacy"]["created_at"] = "Thu Oct 01 09:00:00 +0000 2026"
        page = self.collect_x_fixture([first, second])
        self.assertTrue(page["boundary"])
        self.assertTrue(page.get("page_complete"))
        self.assertFalse(page["order_anomaly"])
        self.assertEqual("2026-10-01T10:00:00Z", page["first_date"])
        self.assertEqual("2026-10-01T09:00:00Z", page["last_date"])

    def test_x_empty_module_or_quote_parent_does_not_block_old_boundary(self):
        for context in (
                {"entryId": "profile-conversation-1", "content": {"items": []}},
                self.x_entry("200")):
            with self.subTest(context=context):
                old = self.x_entry("100")
                old["content"]["itemContent"]["tweet_results"]["result"]["legacy"]["created_at"] = "Thu Oct 01 10:00:00 +0000 2026"
                if context.get("entryId") == "tweet-200":
                    tweet = context["content"]["itemContent"]["tweet_results"]["result"]
                    tweet["legacy"]["created_at"] = "Thu Oct 01 09:00:00 +0000 2026"
                    tweet["quoted_status_result"] = {"result": {}}
                page = self.collect_x_fixture([old, context])
                self.assertTrue(page["boundary"])

    def test_x_disabled_pinned_instruction_does_not_block_old_boundary(self):
        pinned, old = self.x_entry("100"), self.x_entry("200")
        for entry in (pinned, old):
            entry["content"]["itemContent"]["tweet_results"]["result"]["legacy"]["created_at"] = "Thu Oct 01 10:00:00 +0000 2026"
        data = self.x_response([old, {"entryId": "cursor-bottom-0", "content": {"value": "next"}}])
        data["data"]["timeline"]["instructions"].insert(0, {"type": "TimelinePinEntry", "entry": pinned})
        with patch.object(twitter.TwitterAPI, "_call", return_value=data), \
                patch.object(twitter.TwitterWithRepliesExtractor, "tweets", self.native_x_tweets), \
                patch.object(twitter.TwitterWithRepliesExtractor, "items", self.x_conversion):
            page = adapter.collect(dict(self.source, cutoff="2026-10-02T00:00:00Z"), None)
        self.assertTrue(page["boundary"])

    def test_x_old_owned_module_is_neutral_but_recent_or_unknown_blocks_stop(self):
        for date, boundary in (("Thu Oct 01 10:00:00 +0000 2026", True),
                               ("Fri Oct 02 10:00:00 +0000 2026", False),
                               (None, False)):
            with self.subTest(date=date):
                ordinary = self.native_media_entry("200", old=True)
                child = self.x_entry("100", module=True)
                legacy = child["item"]["itemContent"]["tweet_results"]["result"]["legacy"]
                if date is None:
                    legacy.pop("created_at")
                else:
                    legacy["created_at"] = date
                page = self.collect_x_fixture([ordinary, {"entryId": "profile-conversation-1", "content": {"items": [child]}}])
                self.assertEqual(boundary, page["boundary"])
                self.assertEqual("2026-10-01T10:00:00Z", page["last_date"])

    def test_x_excluded_only_batch_preserves_confirmation_without_proving_boundary(self):
        page = self.collect_native_media([self.native_media_entry("100", "retweeted_status_id_str")])
        self.assertFalse(page["boundary"])
        self.assertTrue(page.get("neutral"))
        self.assertEqual(1, page.get("coverage", {}).get("excluded_retweet"))

    def test_x_diagnostic_keeps_cause_and_traceback(self):
        def tweets(ext):
            raise KeyError("unexpected upstream field legacy")
            yield
        with patch.object(twitter.TwitterWithRepliesExtractor, "tweets", tweets):
            with self.assertRaises(adapter.AdapterError) as caught:
                adapter.collect(self.source, None)
        diagnostic = caught.exception.result.get("diagnostic", {})
        self.assertEqual("KeyError", diagnostic.get("exception_type"))
        self.assertEqual("enumeration", diagnostic.get("stage"))
        self.assertIn("unexpected upstream field legacy", diagnostic["message"])
        self.assertIn("Traceback", diagnostic["traceback"])

    def test_diagnostic_unknown_exception_retains_http_status_and_message(self):
        class NewPlatformFailure(Exception):
            status_code = 503
        try:
            raise NewPlatformFailure("service overloaded")
        except NewPlatformFailure as exc:
            diagnostic = adapter.safe_diagnostic(exc, "enumeration")
        self.assertEqual("NewPlatformFailure", diagnostic["exception_type"])
        self.assertEqual("service overloaded", diagnostic["message"])
        self.assertEqual("503", diagnostic["http_status"])

    def test_diagnostic_redacts_before_capping_message_and_traceback(self):
        token = "0123456789abcdefghijklmnopqrstuv"
        adapter.diagnostic_secrets.append(token)
        diagnostic = adapter.safe_diagnostic(ValueError("x" * 8180 + token), "enumeration")
        self.assertNotIn("0123456789ab", diagnostic["message"])
        self.assertNotIn(token, diagnostic["traceback"])

    def test_diagnostic_retains_upstream_warning_with_abort_cause(self):
        record = __import__("logging").LogRecord("twitter", 40, "upstream", 1, "HTTP backend rejected timeline", (), None)
        adapter.diagnostic_handler.emit(record)
        diagnostic = adapter.safe_diagnostic(exception.AbortExtraction("502 Bad Gateway"), "enumeration")
        self.assertEqual("502", diagnostic["http_status"])
        self.assertIn("rejected timeline", diagnostic["upstream_logs"])

    def test_quote_collects_only_parent_attachments_without_requiring_self_quote(self):
        parent = self.native_media_entry("200")
        original = self.native_media_entry("100", old=True)["content"]["itemContent"]["tweet_results"]["result"]
        original["legacy"]["user_id_str"] = "99"
        original["core"]["user_results"]["result"]["rest_id"] = "99"
        parent["content"]["itemContent"]["tweet_results"]["result"]["quoted_status_result"] = {"result": original}
        page = self.collect_native_media([parent])
        self.assertEqual([200], [r[1]["tweet_id"] for r in page["records"] if r[0] == 2])
        self.assertEqual([], page["failed_ids"])
        self.assertFalse(page["boundary"])

    def test_owned_reply_in_module_collects_without_collecting_foreign_parent(self):
        owned = self.native_media_entry("200")
        own_tweet = owned["content"]["itemContent"]["tweet_results"]["result"]
        own_tweet["legacy"]["in_reply_to_status_id_str"] = "100"
        own_tweet["legacy"]["in_reply_to_user_id_str"] = "99"
        foreign = self.native_media_entry("100")
        other = foreign["content"]["itemContent"]["tweet_results"]["result"]
        other["legacy"]["user_id_str"] = "99"
        other["core"]["user_results"]["result"]["rest_id"] = "99"
        page = self.collect_native_media([{"entryId": "profile-conversation-1", "content": {"items": [foreign, owned]}}])
        self.assertEqual([200], [r[1]["tweet_id"] for r in page["records"] if r[0] == 2])
        self.assertFalse(page["boundary"])
        self.assertEqual(1, page["coverage"]["owned_context"])
        self.assertEqual(1, page["coverage"]["foreign"])

    def test_unknown_timeline_entries_cannot_be_neutral_or_certify_old_page(self):
        for unknown in ({"entryId": "future-tweet-200", "content": {}},
                        {"entryId": "unrecognized-200", "content": {"itemContent": {"itemType": "TimelineTweet", "tweetResult": {}}}}):
            for old in ([], [self.native_media_entry("100", old=True)]):
                with self.subTest(unknown=unknown, old=bool(old)):
                    with self.assertRaisesRegex(adapter.AdapterError, "discovery_incomplete") as caught:
                        self.collect_x_fixture(old + [unknown])
                    self.assertFalse(caught.exception.result["boundary"])
                    self.assertFalse(caught.exception.result["neutral"])
                    self.assertFalse(caught.exception.result["page_complete"])

    def test_known_top_cursor_does_not_block_old_batch(self):
        page = self.collect_x_fixture([self.native_media_entry("100", old=True),
            {"entryId": "cursor-top-0", "content": {"cursorType": "Top", "value": "top"}}])
        self.assertTrue(page["boundary"])

    def test_x_unknown_date_and_empty_native_batch_have_no_boundary_evidence(self):
        unknown = self.x_entry("100")
        del unknown["content"]["itemContent"]["tweet_results"]["result"]["legacy"]["created_at"]
        for entries in ([unknown], []):
            with self.subTest(entries=entries):
                page = self.collect_x_fixture(entries)
                self.assertFalse(page["boundary"])
                self.assertIsNone(page["first_date"])
                self.assertIsNone(page["last_date"])

    def test_x_native_rate_limit_during_conversion_keeps_unconverted_ids(self):
        def conversion(ext):
            for raw in ext.tweets():
                if raw["rest_id"] == "100":
                    raise exception.AbortExtraction("429 rate limit secret-token")
                yield 2, "", {"tweet_id": raw["rest_id"], "author": {"id": "42"}}
        entries = [self.x_entry("100"), self.x_entry("200"), {"entryId": "cursor-bottom-0", "content": {"value": "next"}}]
        with patch.object(twitter.TwitterAPI, "_call", return_value=self.x_response(entries)), \
                patch.object(twitter.TwitterWithRepliesExtractor, "tweets", self.native_x_tweets), \
                patch.object(twitter.TwitterWithRepliesExtractor, "items", conversion):
            with self.assertRaisesRegex(adapter.AdapterError, "rate_limited") as caught:
                adapter.collect(self.source, None)
        page = caught.exception.result
        self.assertEqual(["100", "200"], page["failed_ids"])
        self.assertFalse(page["page_complete"])
        self.assertFalse(page["terminal"])

    def test_x_native_silently_skipped_known_post_remains_failed(self):
        skipped = self.x_entry("100")
        skipped["content"]["itemContent"]["tweet_results"]["result"]["legacy"]["retweeted_status_result"] = {"result": {}}
        config.set(("extractor", "twitter"), "retweets", True)
        page = self.collect_x_fixture([skipped, self.x_entry("200")])
        self.assertEqual(["100"], page["failed_ids"])
        self.assertEqual(["200"], [record[1]["tweet_id"] for record in page["records"]])

    def test_native_malformed_core_does_not_hide_valid_later_sibling(self):
        malformed = self.x_entry("999")
        malformed["content"]["itemContent"]["tweet_results"]["result"]["core"] = []
        try:
            page = self.collect_x_fixture([malformed, self.x_entry("100")])
        except adapter.AdapterError as exc:
            page = exc.result
        self.assertEqual(["100"], [record[1]["tweet_id"] for record in page["records"]])
        self.assertEqual(["999"], page["failed_ids"])

    def test_pixiv_overlap_rejects_reordering_with_same_id_membership(self):
        source = {"platform": "pixiv", "remote_id": "42"}
        ids = [100, 101, 102, 103]
        def response(api, endpoint, params=None, **kwargs):
            offset = int(params.get("offset", 0))
            return {"user": {"id": 42}, "illusts": [{"id": post_id, "user": {"id": 42}, "type": "illust", "create_date": "2026-10-01T10:00:00+00:00", "page_count": 1, "meta_pages": []} for post_id in ids[offset:offset+2]],
                    "next_url": "https://app-api.pixiv.net/v1/user/illusts?user_id=42&offset=2" if offset == 0 else None}
        def conversion(ext):
            for raw in ext.works():
                yield 2, "", raw
        with patch.object(pixiv.PixivAppAPI, "_call", response), patch.object(pixiv.PixivArtworksExtractor, "items", conversion):
            first = adapter.collect(source, None)
            ids[:2] = [101, 100]
            with self.assertRaisesRegex(adapter.AdapterError, "cursor_invalid"):
                adapter.collect(source, first["next"])

    def test_partial_records_and_failed_id_survive_later_page_error(self):
        for failure in (adapter.AdapterError("rate_limited"), exception.AbortExtraction("Invalid cursor secret-token")):
            with self.subTest(failure=type(failure).__name__):
                def tweets(ext):
                    for post_id in ("100", "200"):
                        yield {"legacy": {"id_str": post_id, "user_id_str": "42"}}
                    raise failure
                def conversion(ext):
                    for raw in ext.tweets():
                        if raw["legacy"]["id_str"] == "200":
                            raise ValueError("bad metadata")
                        yield 2, "", {"tweet_id": raw["legacy"]["id_str"]}
                with patch.object(twitter.TwitterWithRepliesExtractor, "tweets", tweets), \
                        patch.object(twitter.TwitterWithRepliesExtractor, "items", conversion):
                    with self.assertRaises(adapter.AdapterError) as caught:
                        adapter.collect(self.source, "previous")
                page = getattr(caught.exception, "result", {})
                self.assertEqual(["100"], [record[1]["tweet_id"] for record in page.get("records", [])])
                self.assertEqual(["200"], page["failed_ids"])
                self.assertEqual("rate_limited" if isinstance(failure, adapter.AdapterError) else "cursor_invalid", page["error"])
                self.assertFalse(page["terminal"])
                self.assertFalse(page["boundary"])
                self.assertFalse(page["page_complete"])
                self.assertIsNone(page["next"])

    def test_native_error_journals_owned_siblings_in_entire_response(self):
        unknown = {"entryId": "tweet-999", "content": {"itemContent": {}}}
        entries = [unknown, self.x_entry("100"), self.x_entry("200")]
        with self.assertRaises(adapter.AdapterError) as caught:
            self.collect_x_fixture(entries)
        page = getattr(caught.exception, "result", {})
        self.assertEqual(["100", "200"], page.get("failed_ids"))
        self.assertFalse(page["page_complete"])
        self.assertEqual("discovery_incomplete", page["error"])

    def test_malformed_native_entry_fields_do_not_hide_later_owned_id(self):
        for malformed in (
                {"entryId": None, "content": {}},
                {"entryId": "tweet-999", "content": [1]},
                {"entryId": "cursor-bottom-0", "content": None}):
            with self.subTest(malformed=malformed):
                with self.assertRaises(adapter.AdapterError) as caught:
                    self.collect_x_fixture([malformed, self.x_entry("100")])
                self.assertEqual(["100"], caught.exception.result["failed_ids"])

    def test_user_recommendation_module_does_not_block_tweet_discovery(self):
        # X's real timeline includes who-to-follow modules with content.items,
        # but these are users, not malformed tweet containers.
        module = {"entryId": "who-to-follow-123", "content": {"entryType": "TimelineTimelineModule", "items": [{"entryId": "who-to-follow-123-user-99", "item": {"itemContent": {"itemType": "TimelineUser", "user_results": {"result": {"rest_id": "99"}}}}}]}}
        page = self.collect_x_fixture([module, self.x_entry("100")])
        self.assertTrue(page["page_complete"])
        self.assertEqual([], page["failed_ids"])
        self.assertEqual("next", page["next"])
        self.assertEqual(["100"], [record[1]["tweet_id"] for record in page["records"]])

    def test_user_recommendation_prefix_cannot_hide_tweet_payload(self):
        module = {"entryId": "who-to-follow-123", "content": {"items": [self.x_entry("200", module=True)]}}
        with self.assertRaises(adapter.AdapterError) as caught:
            self.collect_x_fixture([module, self.x_entry("100")])
        self.assertEqual(["200", "100"], caught.exception.result["failed_ids"])
        self.assertFalse(caught.exception.result["page_complete"])

    def test_user_recommendation_sibling_cannot_hide_tweet_payload(self):
        module = {"entryId": "who-to-follow-123", "content": {"items": []}, "extra": self.x_entry("200")}
        with self.assertRaises(adapter.AdapterError) as caught:
            self.collect_x_fixture([module, self.x_entry("100")])
        self.assertEqual(["200", "100"], caught.exception.result["failed_ids"])
        self.assertFalse(caught.exception.result["page_complete"])

    def test_native_quote_mutation_does_not_exclude_original_timeline_post(self):
        original = self.native_media_entry("100")
        quoting = self.native_media_entry("200")
        user = quoting["content"]["itemContent"]["tweet_results"]["result"]["core"]["user_results"]["result"]
        user["core"] = {"screen_name": "synthetic", "name": "Synthetic", "created_at": "Fri Oct 02 10:00:00 +0000 2026"}
        user["legacy"] = {"description": ""}
        user.update(location={"location": ""}, verification={"verified": False}, privacy={"protected": False}, avatar={"image_url": ""})
        quoting["content"]["itemContent"]["tweet_results"]["result"]["quoted_status_result"] = {"result": original["content"]["itemContent"]["tweet_results"]["result"]}
        # gallery-dl modifies the shared original's legacy while expanding the
        # quote. A later ordinary timeline entry must remain collectable.
        page = self.collect_native_media([quoting, original])
        self.assertEqual([], page["failed_ids"])
        self.assertEqual([200, 100], [r[1]["tweet_id"] for r in page["records"] if r[0] == 2])
        self.assertFalse(page["boundary"])

    def test_disabled_pinned_entry_is_not_a_failed_discovery_candidate(self):
        data = self.x_response([self.x_entry("100"), {"entryId": "cursor-bottom-0", "content": {"value": "next"}}])
        data["data"]["timeline"]["instructions"].insert(0, {"type": "TimelinePinEntry", "entry": self.x_entry("200")})
        with patch.object(twitter.TwitterAPI, "_call", return_value=data), \
                patch.object(twitter.TwitterWithRepliesExtractor, "tweets", self.native_x_tweets), \
                patch.object(twitter.TwitterWithRepliesExtractor, "items", self.x_conversion):
            page = adapter.collect(dict(self.source, cutoff="2026-10-02T00:00:00Z"), None)
        self.assertEqual([], page["failed_ids"])
        self.assertEqual(["100"], [r[1]["tweet_id"] for r in page["records"]])
        self.assertFalse(page["boundary"])
        self.assertTrue(page["page_complete"])

    def test_unrecognized_native_wrapper_preserves_confirmed_owned_payload_ids(self):
        for entry_id in (None, 200, "unrecognized-200"):
            with self.subTest(entry_id=entry_id):
                unknown = self.x_entry("200")
                unknown["entryId"] = entry_id
                with self.assertRaises(adapter.AdapterError) as caught:
                    self.collect_x_fixture([unknown, self.x_entry("100")])
                page = caught.exception.result
                self.assertEqual(["200", "100"], page["failed_ids"])
                self.assertEqual("discovery_incomplete", page["error"])
                self.assertFalse(page["page_complete"])
                self.assertFalse(page["terminal"])
                self.assertFalse(page["boundary"])
                self.assertIsNone(page["next"])

    def test_missing_native_entry_id_key_preserves_confirmed_owned_id(self):
        unknown = self.x_entry("200")
        del unknown["entryId"]
        try:
            page = self.collect_x_fixture([unknown, self.x_entry("100")])
        except adapter.AdapterError as exc:
            page = exc.result
        self.assertEqual(["200", "100"], page["failed_ids"])
        self.assertEqual("discovery_incomplete", page.get("error"))
        self.assertFalse(page["page_complete"])
        self.assertFalse(page["boundary"])
        self.assertFalse(page["terminal"])
        self.assertIsNone(page["next"])

    def test_rejected_native_wrapper_shapes_preserve_confirmed_owned_ids(self):
        content = self.x_entry("200")["content"]
        module_item = self.x_entry("200", module=True)
        malformed_wrappers = (
            {"entryId": "tweet-200", "content": [content]},
            {"entryId": "profile-conversation-1", "content": {"items": {"unexpected": module_item}}},
            {"entryId": "cursor-bottom-bad", "content": [content]},
            {"entryId": "profile-conversation-1", "content": {"items": [{"entryId": "module-item-200", "item": [module_item["item"]]}]}},
        )
        for wrapper in malformed_wrappers:
            with self.subTest(wrapper=wrapper):
                with self.assertRaises(adapter.AdapterError) as caught:
                    self.collect_x_fixture([wrapper, self.x_entry("100")])
                self.assertEqual(["200", "100"], caught.exception.result["failed_ids"])
                self.assertFalse(caught.exception.result["page_complete"])

    def test_unknown_list_or_missing_module_wrapper_preserves_safe_payload(self):
        wrappers = (
            {"entryId": "unrecognized-200", "content": [self.x_entry("200")["content"]]},
            {"content": {"items": [self.x_entry("200", module=True)]}},
        )
        for wrapper in wrappers:
            with self.subTest(wrapper=wrapper):
                try:
                    page = self.collect_x_fixture([wrapper, self.x_entry("100")])
                except adapter.AdapterError as exc:
                    page = exc.result
                self.assertEqual(["200", "100"], page["failed_ids"])
                self.assertEqual("discovery_incomplete", page.get("error"))
                self.assertFalse(page["page_complete"])

    def test_normal_native_payload_recursion_remains_complete_old_boundary(self):
        entry = self.x_entry("200")
        entry["content"]["itemContent"]["tweet_results"]["result"]["legacy"]["created_at"] = "Thu Oct 01 10:00:00 +0000 2026"
        page = self.collect_x_fixture([entry])
        self.assertNotIn("error", page)
        self.assertTrue(page["page_complete"])
        self.assertTrue(page["boundary"])
        self.assertEqual([], page["failed_ids"])
        self.assertEqual(["200"], [record[1]["tweet_id"] for record in page["records"]])

    def test_unrecognized_native_module_preserves_confirmed_child_payload_ids(self):
        for entry_id in (None, "unrecognized-module-1"):
            with self.subTest(entry_id=entry_id):
                unknown = {"entryId": entry_id, "content": {"items": [self.x_entry("200", module=True)]}}
                with self.assertRaises(adapter.AdapterError) as caught:
                    self.collect_x_fixture([unknown, self.x_entry("100")])
                self.assertEqual(["200", "100"], caught.exception.result["failed_ids"])
                self.assertFalse(caught.exception.result["page_complete"])

    def test_native_module_child_without_string_entry_id_is_a_complete_page(self):
        for entry_id in ("missing", None, 200):
            with self.subTest(entry_id=entry_id):
                child = self.x_entry("200", module=True)
                if entry_id == "missing":
                    del child["entryId"]
                else:
                    child["entryId"] = entry_id
                parent = {"entryId": "profile-conversation-1", "content": {"items": [child]}}
                data = self.x_response([parent, {"entryId": "cursor-bottom-0", "content": {"value": ""}}])
                with patch.object(twitter.TwitterAPI, "_call", return_value=data):
                    ext = twitter.TwitterWithRepliesExtractor.from_url("https://x.com/synthetic/with_replies")
                    ext.initialize()
                    raw = list(self.native_x_tweets(ext))
                self.assertEqual(["200"], [tweet["rest_id"] for tweet in raw])
                # A recognized parent's native items are validated by payload;
                # only top-level timeline entries require the entryId wrapper.
                try:
                    page = self.collect_x_fixture([parent])
                except adapter.AdapterError as exc:
                    page = exc.result
                self.assertNotIn("error", page)
                self.assertTrue(page["page_complete"])
                self.assertEqual([], page["failed_ids"])
                self.assertEqual(["200"], [record[1]["tweet_id"] for record in page["records"]])
                self.assertFalse(page["boundary"])
                self.assertFalse(page["terminal"])
                self.assertEqual("next", page["next"])

    def test_unrecognized_native_wrapper_rejects_unconfirmed_or_foreign_ids(self):
        for entry_id in (None, "unrecognized-200"):
            for mismatch in ("post_id", "author_id", "missing_legacy", "missing_core", "foreign"):
                with self.subTest(entry_id=entry_id, mismatch=mismatch):
                    unknown = self.x_entry("200")
                    unknown["entryId"] = entry_id
                    tweet = unknown["content"]["itemContent"]["tweet_results"]["result"]
                    if mismatch == "post_id":
                        tweet["rest_id"] = "999"
                    elif mismatch == "author_id":
                        tweet["core"]["user_results"]["result"]["rest_id"] = "99"
                    elif mismatch == "missing_legacy":
                        del tweet["legacy"]
                    elif mismatch == "missing_core":
                        del tweet["core"]
                    else:
                        tweet["legacy"]["user_id_str"] = "99"
                        tweet["core"]["user_results"]["result"]["rest_id"] = "99"
                    try:
                        page = self.collect_x_fixture([unknown, self.x_entry("100")])
                    except adapter.AdapterError as exc:
                        page = exc.result
                    self.assertEqual("discovery_incomplete", page.get("error"))
                    self.assertEqual(["100"], page["failed_ids"])
                    self.assertFalse(page["page_complete"])

    def test_identity_conflict_does_not_journal_foreign_or_unsafe_id(self):
        foreign, conflict = self.x_entry("200"), self.x_entry("300")
        foreign_tweet = foreign["content"]["itemContent"]["tweet_results"]["result"]
        foreign_tweet["legacy"]["user_id_str"] = "99"
        foreign_tweet["core"]["user_results"]["result"]["rest_id"] = "99"
        conflict["content"]["itemContent"]["tweet_results"]["result"]["core"]["user_results"]["result"]["rest_id"] = "99"
        with self.assertRaises(adapter.AdapterError) as caught:
            self.collect_x_fixture([self.x_entry("100"), foreign, conflict])
        self.assertEqual(["100"], caught.exception.result["failed_ids"])

    def test_generator_cleanup_cannot_replace_partial_rate_limit_error(self):
        def tweets(ext):
            try:
                yield {"legacy": {"id_str": "100", "user_id_str": "42"}}
            finally:
                raise ValueError("cleanup secret-token")
        def conversion(ext):
            for raw in ext.tweets():
                raise adapter.AdapterError("rate_limited")
                yield
        with patch.object(twitter.TwitterWithRepliesExtractor, "tweets", tweets), \
                patch.object(twitter.TwitterWithRepliesExtractor, "items", conversion):
            try:
                adapter.collect(self.source, None)
            except Exception as exc:
                caught = exc
        self.assertIsInstance(caught, adapter.AdapterError)
        self.assertEqual("rate_limited", str(caught))
        self.assertEqual(["100"], caught.result["failed_ids"])

    def test_pixiv_malformed_work_keeps_owned_later_sibling(self):
        data = {"user": {"id": 42}, "illusts": [{"id": 999, "user": [1]}, {"id": 100, "user": {"id": 42}, "type": "illust", "create_date": "2026-10-01T10:00:00+00:00", "page_count": 1, "meta_pages": []}], "next_url": None}
        with patch.object(pixiv.PixivAppAPI, "_call", return_value=data), self.assertRaises(adapter.AdapterError) as caught:
            adapter.collect({"platform": "pixiv", "remote_id": "42"}, None)
        self.assertEqual(["100"], caught.exception.result["failed_ids"])

    def test_pixiv_empty_placeholder_page_verifies_user_detail(self):
        def response(api, endpoint, params=None, **kwargs):
            if endpoint == "/v1/user/detail":
                self.assertEqual("42", str(params["user_id"]))
                return {"user": {"id": 42}}
            return {"user": {"id": 0}, "illusts": [], "next_url": None}
        with patch.object(pixiv.PixivAppAPI, "_call", response):
            page = adapter.collect({"platform": "pixiv", "remote_id": "42"}, None)
        self.assertTrue(page["terminal"])
        self.assertTrue(page["page_complete"])
        self.assertEqual([], page["records"])
        self.assertEqual([], page["failed_ids"])
        self.assertIsNone(page["next"])

    def test_pixiv_empty_placeholder_detail_failure_stays_incomplete(self):
        for detail, expected in (({"user": {"id": 99}}, "source_identity_conflict"),
                                 ({}, "source_identity_conflict"),
                                 ({"user": {"id": 42, "is_access_blocking_user": True}}, "source_forbidden"),
                                 (requests.exceptions.ConnectionError("connection failed"), "network_error")):
            def response(api, endpoint, params=None, **kwargs):
                if endpoint == "/v1/user/detail":
                    if isinstance(detail, Exception):
                        raise detail
                    return detail
                return {"user": {"id": 0}, "illusts": [], "next_url": None}
            with self.subTest(expected=expected, detail=detail), \
                    patch.object(pixiv.PixivAppAPI, "_call", response), \
                    self.assertRaisesRegex(adapter.AdapterError, expected) as caught:
                adapter.collect({"platform": "pixiv", "remote_id": "42"}, None)
            self.assertFalse(caught.exception.result["page_complete"])
            self.assertFalse(caught.exception.result["terminal"])

    def test_pixiv_empty_fallback_rejects_nonterminal_nonempty_and_foreign_pages(self):
        for data in ({"user": {"id": 0}, "illusts": [], "next_url": "https://app-api.pixiv.net/v1/user/illusts?user_id=42&offset=30"},
                     {"user": {"id": 0}, "illusts": [{"id": 100, "user": {"id": 42}, "type": "illust", "create_date": "2026-10-01T10:00:00+00:00", "page_count": 1, "meta_pages": []}], "next_url": None},
                     {"user": {"id": 99}, "illusts": [], "next_url": None}):
            def response(api, endpoint, params=None, **kwargs):
                self.assertNotEqual("/v1/user/detail", endpoint)
                return data
            with self.subTest(data=data), patch.object(pixiv.PixivAppAPI, "_call", response), \
                    self.assertRaisesRegex(adapter.AdapterError, "source_identity_conflict"):
                adapter.collect({"platform": "pixiv", "remote_id": "42"}, None)

    def test_pixiv_conflicting_page_owner_does_not_expose_untrusted_ids(self):
        data = {"user": {"id": 99}, "illusts": [{"id": 100, "user": {"id": 42}, "type": "illust", "create_date": "2026-10-01T10:00:00+00:00", "page_count": 1, "meta_pages": []}], "next_url": None}
        with patch.object(pixiv.PixivAppAPI, "_call", return_value=data), self.assertRaisesRegex(adapter.AdapterError, "source_identity_conflict") as caught:
            adapter.collect({"platform": "pixiv", "remote_id": "42"}, None)
        self.assertEqual([], caught.exception.result["failed_ids"])

    def test_main_emits_safe_source_bound_partial_error_envelope(self):
        request = {"source": self.source, "config": "not-read", "cache": "not-read"}
        def tweets(ext):
            yield {"legacy": {"id_str": "100", "user_id_str": "42"}}
            raise exception.AbortExtraction("network timeout https://secret.test/token")
        def conversion(ext):
            for raw in ext.tweets():
                yield 2, "", {"tweet_id": raw["legacy"]["id_str"]}
        stdout = io.StringIO()
        with patch("builtins.open", return_value=io.StringIO(json.dumps(request))), \
                patch.object(config, "load", lambda *args, **kwargs: None), \
                patch.object(adapter.sys, "argv", ["adapter", "not-read"]), \
                patch.object(adapter.sys, "stdout", stdout), \
                patch.object(twitter.TwitterWithRepliesExtractor, "tweets", tweets), \
                patch.object(twitter.TwitterWithRepliesExtractor, "items", conversion):
            adapter.main()
        page = json.loads(stdout.getvalue())
        self.assertEqual("network_error", page["error"])
        self.assertEqual(1, page.get("version"))
        self.assertEqual("x", page["platform"])
        self.assertEqual("42", page["source_id"])
        self.assertEqual("100", page["records"][0][1]["tweet_id"])
        self.assertFalse(page["page_complete"])
        self.assertIn("network timeout", page["diagnostic"]["message"])

    def test_pixiv_post_validation_rejects_drift_with_terminal_new_page(self):
        source = {"platform": "pixiv", "remote_id": "42"}
        ids = [100, 101, 102, 103]
        mutate = False
        def response(api, endpoint, params=None, **kwargs):
            offset = int(params.get("offset", 0))
            works = [{"id": post_id, "user": {"id": 42}, "type": "illust", "create_date": "2026-10-01T10:00:00+00:00", "page_count": 1, "meta_pages": []} for post_id in ids[offset:offset+2]]
            data = {"user": {"id": 42}, "illusts": works, "next_url": "https://app-api.pixiv.net/v1/user/illusts?user_id=42&offset=2" if offset == 0 else None}
            if mutate and offset == 2:
                ids.pop(0)  # Saved last anchor 101 still occurs in previous page.
            return data
        def conversion(ext):
            for raw in ext.works():
                yield 2, "", raw
        with patch.object(pixiv.PixivAppAPI, "_call", response), patch.object(pixiv.PixivArtworksExtractor, "items", conversion):
            first = adapter.collect(source, None)
            mutate = True
            with self.assertRaisesRegex(adapter.AdapterError, "cursor_invalid") as caught:
                adapter.collect(source, first["next"])
        page = getattr(caught.exception, "result", {})
        self.assertTrue({"102", "103"} <= set(page.get("failed_ids", [])))
        self.assertFalse(page["terminal"])
        self.assertFalse(page["boundary"])
        self.assertFalse(page["page_complete"])

    def test_pixiv_legacy_anchor_or_unbound_offset_requires_restart(self):
        base = {"user_id": "42", "offset": "30"}
        for cursor in (base, dict(base, _previous={"user_id": "42", "offset": "0"}, _anchor="100")):
            with self.subTest(cursor=cursor), self.assertRaisesRegex(adapter.AdapterError, "cursor_invalid"):
                adapter.collect({"platform": "pixiv", "remote_id": "42"}, cursor)

    def test_native_authored_quote_reference_is_eligible(self):
        page = self.collect_native_media([self.native_media_entry("100", "quoted_status_id_str")])
        self.assertEqual([], page["failed_ids"])
        self.assertEqual(2, len(page["records"]))
        self.assertEqual(100, page["records"][0][1]["tweet_id"])
        self.assertEqual(300000000000000001, page["records"][0][1]["quoted_id"])
        self.assertFalse(page["boundary"])

    def test_native_enabled_retweet_and_quote_media_are_eligible(self):
        config.set(("extractor", "twitter"), "retweets", True)
        config.set(("extractor", "twitter"), "quoted", True)
        page = self.collect_native_media([
            self.native_media_entry("100", "retweeted_status_id_str"),
            self.native_media_entry("101", "quoted_by_id_str"),
        ])
        self.assertEqual([], page["failed_ids"])
        self.assertEqual([100, 101], [r[1]["tweet_id"] for r in page["records"] if r[0] == 2])
        self.assertEqual(4, len(page["records"]))

    def test_native_eligible_media_without_records_remains_failure(self):
        entry = self.native_media_entry("100", old=True)
        media = entry["content"]["itemContent"]["tweet_results"]["result"]["legacy"]["extended_entities"]["media"][0]
        media["ext_media_availability"] = {"status": "Unavailable", "reason": "synthetic"}
        page = self.collect_native_media([entry, self.native_media_entry("200", old=True)])
        self.assertEqual(["100"], page["failed_ids"])
        self.assertEqual([200], [r[1]["tweet_id"] for r in page["records"] if r[0] == 2])
        self.assertFalse(page["boundary"])
        self.assertEqual("next", page["next"])

    def test_native_filtered_media_still_requires_consistent_identity(self):
        entry = self.native_media_entry("100", "retweeted_status_id_str")
        entry["content"]["itemContent"]["tweet_results"]["result"]["core"]["user_results"]["result"]["rest_id"] = "99"
        with self.assertRaisesRegex(adapter.AdapterError, "discovery_incomplete"):
            self.collect_native_media([entry])

    @staticmethod
    def x_response(entries):
        return {"data":{"timeline":{"instructions":[{"type":"TimelineAddEntries","entries":entries}]}}}

    @staticmethod
    def native_x_tweets(ext):
        return ext.api._pagination_tweets("fixture",{"count":100},path=("timeline",))

    @staticmethod
    def x_conversion(ext):
        for raw in ext.tweets():
            yield 2,"",{"tweet_id":raw["rest_id"],"author":{"id":"42"},"date":"2026-10-02 10:00:00","count":1}
            for media in raw.get("legacy", {}).get("extended_entities", {}).get("media", []):
                if media.get("type") == "photo":
                    yield 3,media["media_url_https"],{"type":"photo","tweet_id":raw["rest_id"],"author":{"id":"42"}}


if __name__ == "__main__":
    unittest.main()
