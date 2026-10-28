"""Synthetic regressions for the bounded App/AJAX artwork union.

Only the upstream App API and AJAX boundary are replaced. Native works, items,
placeholder resolution and metadata conversion remain real; sockets are denied.
"""

import copy
import json
import socket
import unittest
from contextlib import contextmanager
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

import adapter
import pixiv_paging
from gallery_dl import config
from gallery_dl.extractor import common, pixiv


RECENT = "2026-10-03T10:00:00+00:00"
OLD = "2026-10-01T10:00:00+00:00"
CUTOFF = "2026-10-02T00:00:00Z"
UNTIL = "2026-10-04T00:00:00Z"


def app_work(post_id, date=RECENT, owner="42", artwork_type="illust"):
    return {
        "id": int(post_id), "user": {"id": int(owner)}, "type": artwork_type,
        "create_date": date,
        "meta_single_page": {"original_image_url": (
            "https://i.pximg.net/img-original/img/2026/10/03/10/00/00/"
            + str(post_id) + "_p0.jpg")},
        "meta_pages": [], "image_urls": {}, "tags": [], "x_restrict": 0,
        "page_count": 1,
    }


def ajax_work(post_id, date=RECENT, owner="42", artwork_type=0):
    return {
        "id": str(post_id), "urls": {"original": (
            "https://i.pximg.net/img-original/img/2026/10/03/10/00/00/"
            + str(post_id) + "_p0.jpg")},
        "illustTitle": "Synthetic", "createDate": date,
        "width": 100, "height": 100, "sl": 0, "viewCount": 0,
        "commentCount": 0, "bookmarkCount": 0, "restrict": 0,
        "xRestrict": 0, "aiType": 0, "bookStyle": 0,
        "userAccount": "synthetic", "userId": owner, "userName": "Synthetic",
        "tags": {"tags": []}, "illustComment": "", "pageCount": 1,
        "illustType": artwork_type,
    }


def directory_ids(page):
    return [str(record[-1]["id"]) for record in page["records"] if record[0] == 2]


class PixivUpstream:
    """Mutable upstream state; each response is independent of native mutation."""

    def __init__(self, case, app_pages, ajax_works):
        self.case = case
        self.app_pages = app_pages
        self.details = {str(work["id"]): copy.deepcopy(work) for work in ajax_works}
        self.briefs = {
            post_id: {key: copy.deepcopy(work[key]) for key in (
                "id", "userId", "illustType", "createDate")}
            for post_id, work in self.details.items()
        }
        self.catalog_ids = list(self.details)
        self.app_calls = []
        self.catalog_calls = 0
        self.metadata_batches = []
        self.detail_ids = []
        self.user_detail_calls = 0
        self.user_detail = {"user": {"id": 42}}
        self.empty_app_owner = 42
        self.on_catalog = None
        self.on_metadata = None
        self.on_detail = None

    def app(self, api, endpoint, params=None, **kwargs):
        params = params or {}
        self.case.assertEqual("42", str(params.get("user_id")))
        if endpoint == "/v1/user/detail":
            self.user_detail_calls += 1
            return copy.deepcopy(self.user_detail)
        self.case.assertEqual("/v1/user/illusts", endpoint)
        offset = int(params.get("offset", 0))
        self.app_calls.append(offset)
        cumulative = 0
        for index, works in enumerate(self.app_pages):
            if offset == cumulative:
                next_offset = cumulative + len(works)
                return {
                    "user": {"id": 42 if works else self.empty_app_owner},
                    "illusts": copy.deepcopy(works),
                    "next_url": (
                        "https://app-api.pixiv.net/v1/user/illusts?user_id=42&offset="
                        + str(next_offset) + "&filter=for_ios"
                    ) if index + 1 < len(self.app_pages) else None,
                }
            cumulative += len(works)
        self.case.fail("unexpected App offset: " + str(offset))

    def ajax(self, ext, endpoint):
        parsed = urlsplit(endpoint)
        path = parsed.path.removeprefix("/ajax")
        if path == "/user/42/profile/all":
            self.catalog_calls += 1
            if self.on_catalog:
                self.on_catalog(self)
            return {"illusts": {post_id: None for post_id in self.catalog_ids},
                    "manga": {}}
        if path == "/user/42/profile/illusts":
            query = parse_qs(parsed.query)
            requested = query.get("ids[]", [])
            self.case.assertTrue(requested, "metadata query must specify IDs")
            self.metadata_batches.append(list(requested))
            if self.on_metadata:
                self.on_metadata(self, requested)
            return {"works": {post_id: copy.deepcopy(self.briefs[post_id])
                              for post_id in requested if post_id in self.briefs}}
        prefix = "/illust/"
        self.case.assertTrue(path.startswith(prefix), "unexpected AJAX endpoint: " + path)
        post_id = path[len(prefix):]
        self.case.assertTrue(post_id.isdecimal(), "unexpected AJAX enrichment: " + path)
        self.detail_ids.append(post_id)
        if self.on_detail:
            self.on_detail(self, post_id)
        self.case.assertIn(post_id, self.details, "detail requested outside catalog")
        return copy.deepcopy(self.details[post_id])

    @contextmanager
    def installed(self):
        # Assign closures instead of bound methods: patched class attributes
        # receive the real native extractor/API as their first argument.
        def app(api, endpoint, params=None, **kwargs):
            return self.app(api, endpoint, params, **kwargs)

        def ajax(ext, endpoint):
            return self.ajax(ext, endpoint)

        with patch.object(pixiv.PixivAppAPI, "_call", app), \
                patch.object(pixiv.PixivArtworksExtractor, "_request_ajax", ajax):
            yield self


class PixivPagingTests(unittest.TestCase):
    def setUp(self):
        guard = patch.object(socket.socket, "connect", side_effect=AssertionError(
            "network forbidden in Pixiv paging tests"))
        guard.start()
        self.addCleanup(guard.stop)
        config.clear()
        common.CACHE_MEMORY.clear()
        adapter.diagnostic_secrets.clear()
        adapter.diagnostic_handler.messages.clear()
        config.set(("extractor",), "sleep-request", 0)
        config.set(("extractor", "pixiv"), "sanity", True)
        self.source = {"platform": "pixiv", "remote_id": "42", "cutoff": CUTOFF}

    def collect_all(self, upstream, cursor=None, max_pages=50):
        pages = []
        for _ in range(max_pages):
            before_details = len(upstream.detail_ids)
            before_batches = len(upstream.metadata_batches)
            page = adapter.collect(self.source, cursor)
            pages.append(page)
            self.assertTrue(page["page_complete"])
            self.assertEqual([], page["failed_ids"])
            self.assertLessEqual(len(upstream.detail_ids) - before_details, 20,
                                 "one bridge call expanded an unbounded AJAX tail")
            self.assertLessEqual(sum(map(len, upstream.metadata_batches[before_batches:])), 100,
                                 "one bridge call scanned an unbounded metadata tail")
            if page["terminal"]:
                self.assertIsNone(page["next"])
                return pages
            self.assertFalse(page["boundary"], "union phase must finish before boundary")
            self.assertIsNotNone(page["next"])
            cursor = page["next"]
        self.fail("bounded union did not reach its terminal page")

    def assert_scan_fails(self, upstream, code=None, cursor=None, source=None):
        """A malformed/drifting upstream must not report a successful union."""
        for _ in range(50):
            try:
                page = adapter.collect(source or self.source, cursor)
            except adapter.AdapterError as exc:
                if code:
                    self.assertEqual(code, str(exc))
                if exc.result is None and str(exc) == "cursor_invalid":
                    return None  # A rejected input cursor has no upstream page.
                self.assertIsInstance(exc.result, dict)
                self.assertFalse(exc.result["terminal"])
                self.assertFalse(exc.result["boundary"])
                self.assertFalse(exc.result["page_complete"])
                self.assertIsNone(exc.result["next"])
                return exc.result
            self.assertFalse(page["boundary"], "unsafe scan exposed an old-date boundary")
            self.assertFalse(page["terminal"], "unsafe scan was accepted as terminal")
            self.assertIsNotNone(page["next"])
            cursor = page["next"]
        self.fail("unsafe scan neither failed nor completed within its bound")

    def checkpoint(self, ids, source_id="42"):
        return {"version": 1, "sourceId": source_id, "ids": list(map(str, ids))}

    def test_two_complete_old_app_pages_switch_to_web_before_historical_tail(self):
        old_pages = [[app_work(post_id, OLD) for post_id in range(start, start - 30, -1)]
                     for start in (900, 800, 700, 600)]
        upstream = PixivUpstream(self, [[app_work(1000)], *old_pages], [ajax_work(100)])
        with upstream.installed():
            pages = self.collect_all(upstream)
        self.assertNotIn(61, upstream.app_calls, "old App history must stop after two complete old pages")
        self.assertEqual({"1000", "100"},
                         {post_id for page in pages for post_id in directory_ids(page)})
        self.assertTrue(pages[-1]["terminal"], "App time boundary still requires web supplementation")

    def test_valid_baseline_without_new_ids_checks_only_bounded_recent_prefix(self):
        works = [ajax_work(post_id, OLD) for post_id in range(1000, 2314)]
        self.source["checkpoint"] = self.checkpoint(range(1000, 2314))
        upstream = PixivUpstream(self, [[]], works)
        with upstream.installed():
            pages = self.collect_all(upstream)
        self.assertEqual(20, sum(map(len, upstream.metadata_batches)),
                         "a completed baseline must not rescan all 1314 metadata entries")
        self.assertEqual([], upstream.detail_ids)
        self.assertEqual(set(upstream.catalog_ids), set(pages[-1]["checkpoint"]["ids"]))

    def test_first_bootstrap_scans_metadata_once_then_reuses_terminal_checkpoint(self):
        works = [ajax_work(post_id, OLD) for post_id in range(1000, 1230)]
        works[0]["createDate"] = RECENT  # Recent low ID behind old IDs.
        first = PixivUpstream(self, [[]], works)
        with first.installed():
            pages = self.collect_all(first)
        self.assertEqual(230, sum(map(len, first.metadata_batches)))
        self.assertEqual(["1000"], first.detail_ids)
        self.source["checkpoint"] = pages[-1]["checkpoint"]
        second = PixivUpstream(self, [[]], works)
        with second.installed():
            self.collect_all(second)
        self.assertEqual(20, sum(map(len, second.metadata_batches)))
        self.assertEqual([], second.detail_ids)

    def test_incremental_catalog_finds_new_low_id_and_restored_public_item(self):
        ids = list(range(1000, 1100))
        self.source["checkpoint"] = self.checkpoint(ids)
        upstream = PixivUpstream(self, [[]],
                                 [ajax_work(post_id, OLD) for post_id in ids]
                                 + [ajax_work(10), ajax_work(20)])
        with upstream.installed():
            pages = self.collect_all(upstream)
        self.assertEqual({"10", "20"}, set(upstream.detail_ids))
        self.assertEqual(22, sum(map(len, upstream.metadata_batches)))
        self.assertEqual(set(upstream.catalog_ids), set(pages[-1]["checkpoint"]["ids"]))

    def test_invalid_or_foreign_baseline_bootstraps_instead_of_hiding_low_id(self):
        ids = list(range(1000, 1030)) + [10]
        invalid = (self.checkpoint(ids, "99"), self.checkpoint(ids + [10]),
                   {"version": 2, "sourceId": "42", "ids": list(map(str, ids))},
                   self.checkpoint([True]), self.checkpoint(["0"]),
                   {"version": 1, "sourceId": "42", "ids": "10"})
        for checkpoint in invalid:
            with self.subTest(checkpoint=checkpoint):
                self.source["checkpoint"] = checkpoint
                upstream = PixivUpstream(self, [[]],
                                         [ajax_work(post_id, OLD) for post_id in ids[:-1]]
                                         + [ajax_work(10)])
                with upstream.installed():
                    self.collect_all(upstream)
                self.assertEqual(["10"], upstream.detail_ids)
                self.assertEqual(31, sum(map(len, upstream.metadata_batches)))

    def test_empty_window_builds_catalog_baseline_without_native_history_details(self):
        self.source.update(cutoff=UNTIL, until=UNTIL)
        upstream = PixivUpstream(self, [[app_work(900)], [app_work(800)]],
                                 [ajax_work(post_id, OLD) for post_id in range(1000, 1314)])
        with upstream.installed():
            pages = self.collect_all(upstream)
        self.assertNotIn(1, upstream.app_calls)
        self.assertEqual(314, sum(map(len, upstream.metadata_batches)))
        self.assertEqual([], upstream.detail_ids)
        self.assertEqual([], [post_id for page in pages for post_id in directory_ids(page)])
        self.assertEqual(set(upstream.catalog_ids), set(pages[-1]["checkpoint"]["ids"]))

    def test_upper_exclusive_window_skips_future_app_and_ajax_native_detail(self):
        self.source["until"] = UNTIL
        future_app = app_work(900, UNTIL)
        future_app["meta_single_page"]["original_image_url"] = pixiv.PixivExtractor.limit_url
        upstream = PixivUpstream(self, [[future_app, app_work(800)]],
                                 [ajax_work(900, UNTIL), ajax_work(700),
                                  ajax_work(600, "2026-10-05T10:00:00Z")])
        with upstream.installed():
            pages = self.collect_all(upstream)
        self.assertEqual({"800", "700"},
                         {post_id for page in pages for post_id in directory_ids(page)})
        self.assertEqual(["700"], upstream.detail_ids)

    def test_checkpoint_is_exposed_only_after_complete_union(self):
        upstream = PixivUpstream(self, [[app_work(900)]],
                                 [ajax_work(post_id) for post_id in range(100, 121)])
        with upstream.installed():
            pages = self.collect_all(upstream)
        for page in pages[:-1]:
            self.assertNotIn("checkpoint", page)
        self.assertEqual(self.checkpoint(range(120, 99, -1)), pages[-1]["checkpoint"])

    def test_v3_cursor_is_bound_to_fixed_upper_window_and_baseline(self):
        self.source.update(until=UNTIL, checkpoint=self.checkpoint([100]))
        upstream = PixivUpstream(self, [[app_work(900)], [app_work(800)]], [ajax_work(100)])
        with upstream.installed():
            first = adapter.collect(self.source, None)
            self.assertEqual(3, first["next"]["_v"])
            for changed in (dict(self.source, until="2026-10-05T00:00:00Z"),
                            dict(self.source, checkpoint=self.checkpoint([100, 200]))):
                with self.subTest(source=changed), self.assertRaisesRegex(adapter.AdapterError, "cursor_invalid"):
                    adapter.collect(changed, first["next"])

    def test_baseline_catalog_removal_between_pages_cannot_commit_checkpoint(self):
        ids = list(range(100, 130))
        self.source["checkpoint"] = self.checkpoint(ids)
        upstream = PixivUpstream(self, [[]], [ajax_work(post_id) for post_id in ids])

        def remove_on_second_snapshot(state):
            if state.catalog_calls == 2:
                state.catalog_ids.remove("100")

        upstream.on_catalog = remove_on_second_snapshot
        with upstream.installed():
            result = self.assert_scan_fails(upstream, "cursor_invalid")
        self.assertNotIn("checkpoint", result)

    def test_app_time_increase_disables_early_stop_until_true_exhaustion(self):
        old_page = lambda start: [app_work(post_id, OLD) for post_id in range(start, start - 30, -1)]
        for first in ([app_work(1000, OLD), app_work(999)], [app_work(1000, OLD)]):
            with self.subTest(first=first):
                # The second case increases time across pages; the first does
                # so inside one page. Neither may later infer a safe boundary.
                pages = [first, [app_work(950)], old_page(900), old_page(800), [app_work(10)]]
                upstream = PixivUpstream(self, pages, [])
                with upstream.installed():
                    result = self.collect_all(upstream)
                self.assertIn("10", {post_id for page in result for post_id in directory_ids(page)})

    def test_anomalous_app_history_can_resume_past_worker_page_budget(self):
        pages = [[app_work(1000 - index, OLD if index % 2 else RECENT)] for index in range(105)]
        upstream = PixivUpstream(self, pages, [])
        with upstream.installed():
            result = self.collect_all(upstream, max_pages=110)
        self.assertTrue(result[-1]["terminal"])
        self.assertIn(104, upstream.app_calls,
                      "per-job page budget must not become an unrecoverable lifetime cursor cap")

    def test_real_detail_upper_boundary_filters_minute_truncated_brief(self):
        self.source["until"] = "2026-10-03T10:00:30Z"
        upstream = PixivUpstream(self, [[]], [ajax_work(100, "2026-10-03T10:00:45Z")])
        upstream.briefs["100"]["createDate"] = "2026-10-03T10:00:00Z"
        with upstream.installed():
            pages = self.collect_all(upstream)
        self.assertEqual(["100"], upstream.detail_ids)
        self.assertEqual([], [post_id for page in pages for post_id in directory_ids(page)])
        self.assertTrue(pages[-1]["terminal"])

    def test_future_low_id_stays_delta_for_next_window_even_outside_recent_prefix(self):
        self.source["until"] = UNTIL
        works = [ajax_work(post_id, OLD) for post_id in range(1000, 1030)] + [ajax_work(10, UNTIL)]
        upstream = PixivUpstream(self, [[]], works)
        with upstream.installed():
            first = self.collect_all(upstream)
        self.assertNotIn("10", first[-1]["checkpoint"]["ids"],
                         "an observed future work has not completed this scan window")
        self.source.update(cutoff=UNTIL, until="2026-10-05T00:00:00Z",
                           checkpoint=first[-1]["checkpoint"])
        next_scan = PixivUpstream(self, [[]], works)
        with next_scan.installed():
            second = self.collect_all(next_scan)
        self.assertEqual(["10"], next_scan.detail_ids)
        self.assertIn("10", second[-1]["checkpoint"]["ids"])

    def test_future_app_id_is_deferred_during_empty_window(self):
        self.source.update(cutoff=UNTIL, until=UNTIL)
        upstream = PixivUpstream(self, [[app_work(10, UNTIL)]], [ajax_work(10, UNTIL)])
        with upstream.installed():
            pages = self.collect_all(upstream)
        self.assertEqual([["10"]], upstream.metadata_batches)
        self.assertEqual([], upstream.detail_ids)
        self.assertNotIn("10", pages[-1]["checkpoint"]["ids"])

    def test_empty_window_metadata_defers_future_and_entire_truncated_upper_minute(self):
        until = "2026-10-03T10:00:30Z"
        self.source.update(cutoff=until, until=until)
        works = [ajax_work(post_id, OLD) for post_id in range(1000, 1030)] + [
            ajax_work(10, "2026-10-03T10:00:45Z"),
            ajax_work(20, "2026-10-04T00:00:00Z"),
        ]
        upstream = PixivUpstream(self, [[]], works)
        upstream.briefs["10"]["createDate"] = "2026-10-03T10:00:00Z"
        with upstream.installed():
            first = self.collect_all(upstream)
        self.assertEqual(32, sum(map(len, upstream.metadata_batches)))
        self.assertEqual([], upstream.detail_ids)
        self.assertNotIn("10", first[-1]["checkpoint"]["ids"])
        self.assertNotIn("20", first[-1]["checkpoint"]["ids"])
        self.source.update(cutoff=until, until="2026-10-05T00:00:00Z", checkpoint=first[-1]["checkpoint"])
        next_scan = PixivUpstream(self, [[]], works)
        next_scan.briefs["10"]["createDate"] = "2026-10-03T10:00:00Z"
        with next_scan.installed():
            self.collect_all(next_scan)
        self.assertEqual({"10", "20"}, set(next_scan.detail_ids))

    def test_deferred_future_ids_have_explicit_memory_bound(self):
        self.source["until"] = UNTIL
        upstream = PixivUpstream(self, [[app_work(900, UNTIL), app_work(800, UNTIL),
                                       app_work(700, UNTIL)]], [])
        with upstream.installed(), patch.object(pixiv_paging, "MAX_DEFERRED_IDS", 2, create=True):
            self.assert_scan_fails(upstream, "limit_reached")

    def test_incremental_resume_offset_counts_targets_instead_of_full_catalog(self):
        ids = list(range(1000, 1100))
        self.source["checkpoint"] = self.checkpoint(ids)
        upstream = PixivUpstream(self, [[]], [ajax_work(post_id) for post_id in ids] + [ajax_work(10)])
        with upstream.installed():
            first = adapter.collect(self.source, None)
            second = adapter.collect(self.source, first["next"])
            self.assertEqual(20, second["next"]["_offset"])
            self.assertEqual(21, second["next"]["_targets"])
            self.assertEqual(101, second["next"]["_count"])
            last = self.collect_all(upstream, second["next"])
        self.assertEqual(21, len(upstream.detail_ids))
        self.assertEqual(21, len(set(upstream.detail_ids)))
        self.assertEqual(["10"], directory_ids(last[-1]))

    def test_same_count_catalog_replacement_still_invalidates_baseline_scan(self):
        ids = list(range(1000, 1030))
        self.source["checkpoint"] = self.checkpoint(ids)
        upstream = PixivUpstream(self, [[]], [ajax_work(post_id, OLD) for post_id in ids])

        def replace_on_second_snapshot(state):
            if state.catalog_calls == 2:
                state.catalog_ids.remove("1000")
                state.catalog_ids.append("9000")

        upstream.on_catalog = replace_on_second_snapshot
        with upstream.installed():
            result = self.assert_scan_fails(upstream, "cursor_invalid")
        self.assertNotIn("checkpoint", result)

    def test_large_baseline_is_fingerprinted_in_cursor_and_deferred_ids_are_validated(self):
        self.source.update(until=UNTIL, checkpoint=self.checkpoint(range(1000, 2314)))
        upstream = PixivUpstream(self, [[app_work(900, UNTIL)], [app_work(800)]], [])
        with upstream.installed():
            page = adapter.collect(self.source, None)
            cursor = page["next"]
            self.assertLess(len(json.dumps(cursor)), 6000, "provider cursor copied the full baseline")
            self.assertEqual(["900"], cursor["_deferred"])
            for deferred in (["900", "900"], [900], ["0"], ["x"], None):
                changed = copy.deepcopy(cursor)
                changed["_deferred"] = deferred
                with self.subTest(deferred=deferred), self.assertRaisesRegex(adapter.AdapterError, "cursor_invalid"):
                    adapter.collect(self.source, changed)

    def test_large_ajax_only_catalog_has_bounded_native_details_per_page(self):
        works = [ajax_work(post_id, OLD) for post_id in range(500, 740)]
        for work in works[-3:]:
            work["createDate"] = RECENT
        upstream = PixivUpstream(self, [[]], works)
        with upstream.installed():
            pages = self.collect_all(upstream)
        self.assertGreater(len(pages), 2)
        self.assertEqual({"737", "738", "739"},
                         {post_id for page in pages for post_id in directory_ids(page)})
        self.assertEqual(3, len(upstream.detail_ids), "old metadata needs no native detail")
        self.assertTrue(upstream.metadata_batches, "catalog must use batched metadata")
        self.assertLessEqual(max(map(len, upstream.metadata_batches)), 100)

    def test_app_continuation_never_reprocesses_earlier_ajax_ids(self):
        upstream = PixivUpstream(self, [
            [app_work(400), app_work(300)], [app_work(200), app_work(100)],
        ], [ajax_work(post_id) for post_id in (500, 400, 300, 200, 100)])
        with upstream.installed():
            pages = self.collect_all(upstream)
        ids = [post_id for page in pages for post_id in directory_ids(page)]
        self.assertEqual({"500", "400", "300", "200", "100"}, set(ids))
        self.assertEqual(len(upstream.detail_ids), len(set(upstream.detail_ids)),
                         "resume repeated native AJAX conversion")

    def test_union_preserves_app_only_ajax_only_and_overlap(self):
        upstream = PixivUpstream(self, [[app_work(500), app_work(300)]],
                                 [ajax_work(300), ajax_work(100)])
        with upstream.installed():
            pages = self.collect_all(upstream)
        self.assertGreater(len(pages), 1, "App exhaustion is not union exhaustion")
        self.assertFalse(pages[0]["terminal"])
        ids = [post_id for page in pages for post_id in directory_ids(page)]
        self.assertEqual(["500", "300"], directory_ids(pages[0]))
        self.assertEqual({"500", "300", "100"}, set(ids))
        self.assertTrue(pages[-1]["terminal"])

    def test_old_metadata_cannot_stop_before_later_recent_id(self):
        # ID order does not prove publication-date order; the recent work is
        # behind more than one metadata batch of old works.
        works = [ajax_work(post_id, OLD) for post_id in range(500, 299, -1)]
        works[-1]["createDate"] = RECENT
        upstream = PixivUpstream(self, [[]], works)
        with upstream.installed():
            pages = self.collect_all(upstream)
        self.assertEqual(["300"], [post_id for page in pages for post_id in directory_ids(page)])
        self.assertEqual(["300"], upstream.detail_ids)
        self.assertFalse(pages[-1]["boundary"])
        self.assertEqual(set(upstream.catalog_ids),
                         {post_id for batch in upstream.metadata_batches for post_id in batch})

    def test_twenty_one_recent_ajax_works_resume_without_loss(self):
        upstream = PixivUpstream(self, [[]],
                                 [ajax_work(post_id) for post_id in range(100, 121)])
        with upstream.installed():
            pages = self.collect_all(upstream)
        nonempty_pages = [directory_ids(page) for page in pages if directory_ids(page)]
        self.assertEqual([20, 1], list(map(len, nonempty_pages)))
        self.assertEqual({str(post_id) for post_id in range(100, 121)},
                         {post_id for page in nonempty_pages for post_id in page})
        self.assertEqual(21, len(upstream.detail_ids))

    def test_catalog_change_during_first_web_page_invalidates_coverage(self):
        upstream = PixivUpstream(self, [[]], [ajax_work(100)])

        def change_second_snapshot(state):
            if state.catalog_calls == 2:
                state.catalog_ids.append("200")

        upstream.on_catalog = change_second_snapshot
        with upstream.installed():
            self.assert_scan_fails(upstream, "cursor_invalid")

    def test_catalog_change_during_terminal_web_page_invalidates_coverage(self):
        upstream = PixivUpstream(self, [[]],
                                 [ajax_work(post_id) for post_id in range(100, 121)])

        def mutate_at_last_detail(state, post_id):
            if len(state.detail_ids) == 21:
                state.catalog_ids.append("200")

        upstream.on_detail = mutate_at_last_detail
        with upstream.installed():
            self.assert_scan_fails(upstream, "cursor_invalid")

    def test_missing_metadata_entry_cannot_complete_union(self):
        upstream = PixivUpstream(self, [[]], [ajax_work(100), ajax_work(200)])
        del upstream.briefs["100"]
        with upstream.installed():
            self.assert_scan_fails(upstream, "discovery_incomplete")

    def test_metadata_identity_author_type_and_date_must_be_known(self):
        mutations = (
            ("id", None), ("id", "999"),
            ("userId", None), ("userId", "99"), ("userId", "0"),
            ("illustType", None), ("illustType", 3),
            ("illustType", "0"), ("illustType", True),
            ("createDate", None), ("createDate", "not-a-date"),
            ("createDate", "2026-10-03T10:00:00"),
        )
        for field, value in mutations:
            with self.subTest(field=field, value=value):
                upstream = PixivUpstream(self, [[]], [ajax_work(100)])
                if value is None:
                    del upstream.briefs["100"][field]
                else:
                    upstream.briefs["100"][field] = value
                with upstream.installed():
                    self.assert_scan_fails(upstream, "discovery_incomplete")

    def test_resolved_detail_must_match_validated_brief(self):
        mutations = (
            ("id", "999"), ("userId", "99"),
            ("illustType", 1), ("createDate", OLD),
        )
        for field, value in mutations:
            with self.subTest(field=field):
                upstream = PixivUpstream(self, [[]], [ajax_work(100)])
                upstream.details["100"][field] = value
                with upstream.installed():
                    self.assert_scan_fails(upstream, "discovery_incomplete")

    def test_brief_detail_dates_allow_minute_floor_precision_without_rewriting_detail(self):
        upstream = PixivUpstream(self, [[]], [ajax_work(100)])
        upstream.briefs["100"]["createDate"] = "2026-10-03T19:00:24+09:00"
        upstream.details["100"]["createDate"] = "2026-10-03T10:00:00Z"
        with upstream.installed():
            pages = self.collect_all(upstream)
        records = [record for page in pages for record in page["records"]]
        self.assertEqual(["100"], [post_id for page in pages for post_id in directory_ids(page)])
        self.assertTrue(records)
        self.assertEqual({"2026-10-03T10:00:00Z"},
                         {record[-1]["create_date"] for record in records},
                         "precision compatibility must not rewrite native detail dates")
        self.assertEqual(["100"], upstream.detail_ids)

        # One side may have been truncated to the UTC minute floor. Two
        # distinct nonzero seconds do not demonstrate that precision loss.
        for detail_date in ("2026-10-03T10:01:00Z", "2026-10-03T09:59:59Z",
                            "2026-10-03T10:00:45Z"):
            with self.subTest(detail_date=detail_date):
                changed = PixivUpstream(self, [[]], [ajax_work(100)])
                changed.briefs["100"]["createDate"] = "2026-10-03T19:00:24+09:00"
                changed.details["100"]["createDate"] = detail_date
                with changed.installed():
                    self.assert_scan_fails(changed, "discovery_incomplete")

    def test_brief_before_cutoff_in_same_minute_still_resolves_recent_detail(self):
        self.source["cutoff"] = "2026-10-03T10:00:30Z"
        upstream = PixivUpstream(self, [[]], [ajax_work(100)])
        upstream.briefs["100"]["createDate"] = "2026-10-03T19:00:00+09:00"
        upstream.details["100"]["createDate"] = "2026-10-03T10:00:45Z"
        with upstream.installed():
            pages = self.collect_all(upstream)
        self.assertEqual(["100"], upstream.detail_ids,
                         "brief seconds cannot discard a potentially recent minute")
        self.assertEqual(["100"], [post_id for page in pages for post_id in directory_ids(page)])
        self.assertEqual({"2026-10-03T10:00:45Z"},
                         {record[-1]["create_date"] for page in pages for record in page["records"]})
        self.assertTrue(pages[-1]["terminal"])
        self.assertFalse(pages[-1]["boundary"])

    def test_resolved_detail_cannot_lose_identity_type_or_aware_date(self):
        mutations = (
            ("id", None), ("userId", None), ("illustType", None),
            ("illustType", True), ("createDate", None),
            ("createDate", "2026-10-03T10:00:00"),
        )
        for field, value in mutations:
            with self.subTest(field=field, value=value):
                upstream = PixivUpstream(self, [[]], [ajax_work(100)])
                if value is None:
                    del upstream.details["100"][field]
                else:
                    upstream.details["100"][field] = value
                with upstream.installed():
                    self.assert_scan_fails(upstream, "discovery_incomplete")

    def test_v3_cursor_is_bound_to_source_and_cutoff(self):
        upstream = PixivUpstream(self, [[app_work(500)], [app_work(400)]],
                                 [ajax_work(100)])
        with upstream.installed():
            first = adapter.collect(self.source, None)
            self.assertFalse(first["terminal"])
            self.assertEqual(3, first["next"].get("_v"))
            for changed_source in (
                dict(self.source, remote_id="99"),
                dict(self.source, cutoff="2026-10-01T00:00:00Z"),
                {"platform": "pixiv", "remote_id": "42"},
            ):
                with self.subTest(source=changed_source), \
                        self.assertRaisesRegex(adapter.AdapterError, "cursor_invalid"):
                    adapter.collect(changed_source, copy.deepcopy(first["next"]))

    def test_web_cursor_rejects_changed_catalog_hash_count_or_offset(self):
        upstream = PixivUpstream(self, [[]], [ajax_work(100)])
        with upstream.installed():
            first = adapter.collect(self.source, None)
            self.assertFalse(first["terminal"])
            cursor = first["next"]
            self.assertEqual("sanity", cursor.get("_phase"))
            for field, value in (("_hash", "0" * 64), ("_count", 100),
                                 ("_offset", -1), ("_phase", "unknown")):
                changed = copy.deepcopy(cursor)
                changed[field] = value
                with self.subTest(field=field):
                    self.assert_scan_fails(upstream, "cursor_invalid", changed)

    def test_app_head_is_rechecked_after_web_phase(self):
        upstream = PixivUpstream(self, [[app_work(500)]], [ajax_work(100)])

        def shift_app_head(state, post_id):
            state.app_pages[0] = [app_work(600)]

        upstream.on_detail = shift_app_head
        with upstream.installed():
            self.assert_scan_fails(upstream, "cursor_invalid")

    def test_empty_catalog_independently_verifies_user_detail(self):
        upstream = PixivUpstream(self, [[]], [])
        with upstream.installed():
            pages = self.collect_all(upstream)
        self.assertEqual([], [post_id for page in pages for post_id in directory_ids(page)])
        self.assertTrue(pages[-1]["terminal"])
        self.assertGreaterEqual(upstream.user_detail_calls, 1,
                                "empty AJAX catalog needs independent account evidence")

    def test_empty_catalog_cannot_accept_foreign_or_blocking_detail(self):
        cases = (
            ({"user": {"id": 99}}, "source_identity_conflict"),
            ({}, "source_identity_conflict"),
            ({"user": {"id": 42, "is_access_blocking_user": True}}, "source_forbidden"),
        )
        for detail, error in cases:
            with self.subTest(detail=detail):
                upstream = PixivUpstream(self, [[]], [])
                upstream.user_detail = detail
                with upstream.installed():
                    self.assert_scan_fails(upstream, error)

    def test_ajax_animation_is_excluded_from_validated_brief_without_detail(self):
        upstream = PixivUpstream(self, [[]], [ajax_work(100, artwork_type=2)])
        with upstream.installed():
            pages = self.collect_all(upstream)
        records = [record for page in pages for record in page["records"]]
        self.assertEqual([], records, "unsupported animation must not become a static frame")
        self.assertEqual([], upstream.detail_ids,
                         "validated animation brief needs no full-detail conversion")
        self.assertTrue(pages[-1]["terminal"])

    def test_app_unknown_artwork_type_cannot_become_static_media(self):
        for artwork_type in (3, "unknown", True, None):
            with self.subTest(artwork_type=artwork_type):
                work = app_work(500)
                if artwork_type is None:
                    del work["type"]
                else:
                    work["type"] = artwork_type
                upstream = PixivUpstream(self, [[work]], [])
                with upstream.installed():
                    self.assert_scan_fails(upstream, "discovery_incomplete")

    def test_app_publication_date_must_exist_and_have_timezone(self):
        for date in (None, "not-a-date", "2026-10-03T10:00:00"):
            with self.subTest(date=date):
                work = app_work(500)
                if date is None:
                    del work["create_date"]
                else:
                    work["create_date"] = date
                upstream = PixivUpstream(self, [[work]], [])
                with upstream.installed():
                    self.assert_scan_fails(upstream, "discovery_incomplete")

    def test_old_app_limit_works_skip_details_but_keep_later_recent_app_only_work(self):
        old_works = [app_work(post_id, OLD) for post_id in range(510, 540)]
        for work in old_works:
            work["meta_single_page"]["original_image_url"] = pixiv.PixivExtractor.limit_url
        upstream = PixivUpstream(self, [old_works, [app_work(100)]], [])
        with upstream.installed():
            pages = self.collect_all(upstream)
        self.assertFalse(pages[0]["terminal"])
        self.assertFalse(pages[0]["boundary"])
        self.assertEqual([], directory_ids(pages[0]))
        self.assertIn(30, upstream.app_calls, "old App page must not stop enumeration")
        self.assertEqual(["100"], [post_id for page in pages for post_id in directory_ids(page)])
        self.assertEqual([], upstream.detail_ids,
                         "known old App limit works must not request AJAX detail")
        self.assertTrue(pages[-1]["terminal"])

    def test_app_limit_detail_rejects_naive_date_and_lossy_author_conversion(self):
        for field, value in (("createDate", "2026-10-03T10:00:00"),
                             ("userId", 42.9), ("userId", True)):
            with self.subTest(field=field, value=value):
                work = app_work(500)
                work["meta_single_page"]["original_image_url"] = pixiv.PixivExtractor.limit_url
                upstream = PixivUpstream(self, [[work]], [ajax_work(500)])
                upstream.catalog_ids = []
                upstream.details["500"][field] = value
                with upstream.installed():
                    self.assert_scan_fails(upstream, "discovery_incomplete")

    def test_app_only_limit_minute_floor_before_cutoff_resolves_recent_detail(self):
        self.source["cutoff"] = "2026-10-03T10:00:30Z"
        work = app_work(500, date="2026-10-03T10:00:00Z")
        work["meta_single_page"]["original_image_url"] = pixiv.PixivExtractor.limit_url
        upstream = PixivUpstream(self, [[work]], [ajax_work(500, date="2026-10-03T10:00:45Z")])
        upstream.catalog_ids = []
        with upstream.installed():
            pages = self.collect_all(upstream)
        self.assertEqual(["500"], upstream.detail_ids,
                         "App minute-floor timestamp must not discard a potentially recent detail")
        self.assertEqual(["500"], [post_id for page in pages for post_id in directory_ids(page)])
        self.assertEqual({"2026-10-03T10:00:45Z"},
                         {record[-1]["create_date"] for page in pages for record in page["records"]})
        self.assertTrue(pages[-1]["terminal"])
        self.assertFalse(pages[-1]["boundary"])

    def test_app_only_limit_rejects_distinct_nonzero_seconds_in_same_minute(self):
        work = app_work(500, date="2026-10-03T10:00:24+00:00")
        work["meta_single_page"]["original_image_url"] = pixiv.PixivExtractor.limit_url
        upstream = PixivUpstream(self, [[work]], [ajax_work(500, date="2026-10-03T10:00:45Z")])
        upstream.catalog_ids = []
        with upstream.installed():
            self.assert_scan_fails(upstream, "discovery_incomplete")

    def test_app_page_count_is_bounded_before_native_conversion(self):
        for count in (0, -1, 1001, True, "1", None):
            with self.subTest(count=count):
                work = app_work(500)
                if count is None:
                    del work["page_count"]
                else:
                    work["page_count"] = count
                upstream = PixivUpstream(self, [[work]], [])
                with upstream.installed():
                    self.assert_scan_fails(upstream, "discovery_incomplete")

    def test_app_meta_pages_cannot_exceed_page_limit(self):
        work = app_work(500)
        # The synthetic list is small enough for this test; production must
        # reject it before constructing native per-image metadata/records.
        work["meta_pages"] = [{"image_urls": {"original": (
            "https://i.pximg.net/img-original/img/2026/10/03/10/00/00/500_p0.jpg")}}
            for _ in range(1001)]
        upstream = PixivUpstream(self, [[work]], [])
        with upstream.installed():
            self.assert_scan_fails(upstream, "discovery_incomplete")

    def test_ajax_excessive_page_count_fails_before_native_allocation(self):
        upstream = PixivUpstream(self, [[]], [ajax_work(100)])
        upstream.details["100"]["pageCount"] = 1001
        native_extract = pixiv.PixivArtworksExtractor._extract_ajax
        native_entries = []

        def observe_native(ext, work, body):
            native_entries.append(body.get("pageCount"))
            return native_extract(ext, work, body)

        # Observe the allocation boundary while preserving the native method.
        with upstream.installed(), patch.object(
                pixiv.PixivArtworksExtractor, "_extract_ajax", observe_native):
            self.assert_scan_fails(upstream, "discovery_incomplete")
        self.assertEqual([], native_entries,
                         "pageCount must be rejected before native list allocation")

    def test_existing_app_and_ajax_captions_are_plain_without_extra_enrichment(self):
        for option in ("comments", "captions"):
            config.set(("extractor", "pixiv"), option, True)
        app = app_work(500)
        app["title"] = "App title"
        app["caption"] = 'First &amp; second<br><a href="https://example.invalid">Link label</a> &lt;student&gt;'
        empty = app_work(501)
        empty["caption"] = ""
        ajax = ajax_work(100)
        ajax["illustComment"] = '<p>AJAX &amp; entity</p><a href="/jump.php?https%3A%2F%2Fexample.invalid">Link text</a> &lt;student&gt;'
        upstream = PixivUpstream(self, [[app, empty]], [ajax])
        with upstream.installed():
            pages = self.collect_all(upstream)
        records = {str(record[-1]["id"]): record[-1] for page in pages for record in page["records"] if record[0] == 2}
        self.assertEqual("First & second\nLink label <student>", records["500"]["description"])
        self.assertEqual("AJAX & entity\nLink text <student>", records["100"]["description"])
        self.assertEqual("", records["501"]["description"])
        self.assertEqual(["100"], upstream.detail_ids,
                         "empty App caption must not fetch extra detail")
        # AJAX fixture rejects every unexpected endpoint, including comments.
        self.assertEqual(0, upstream.user_detail_calls)

    def test_optional_metadata_enrichment_cannot_expand_collection_work(self):
        for option in ("metadata", "metadata-bookmark", "comments", "captions"):
            config.set(("extractor", "pixiv"), option, True)
        app = app_work(500)
        app.update(total_comments=2, is_bookmarked=True)
        upstream = PixivUpstream(self, [[app]], [ajax_work(100)])
        with upstream.installed():
            pages = self.collect_all(upstream)
        self.assertEqual({"500", "100"},
                         {post_id for page in pages for post_id in directory_ids(page)})
        self.assertEqual(0, upstream.user_detail_calls,
                         "optional per-work metadata calls must stay disabled")


if __name__ == "__main__":
    unittest.main()
