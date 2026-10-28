"""Bounded App API discovery plus source-bound AJAX supplementation.

gallery-dl still owns authentication and original-media conversion. Its native
sanity iterator assumes a complete traversal, so it cannot wrap resumed pages.
"""
import datetime
import hashlib
import json
import re
from urllib.parse import urlencode

CATALOG_PAGE_SIZE = 100
DETAIL_PAGE_SIZE = 20
MAX_CATALOG_IDS = 100000
APP_PAGE_SIZE = 30
RECENT_RECHECK_IDS = 20
MAX_DEFERRED_IDS = 1000


class PixivPager:
    def __init__(self, ext, source, cursor, result, parse_cursor, error, page_done, remember):
        self.ext, self.result = ext, result
        self.parse_cursor, self.error, self.page_done = parse_cursor, error, page_done
        self.remember = remember
        self.source_id = source["remote_id"]
        self.cutoff = self.date(source["cutoff"]) if source.get("cutoff") else None
        self.until = self.date(source["until"]) if source.get("until") else None
        if self.cutoff is not None and self.until is not None and self.cutoff > self.until:
            raise error("discovery_incomplete")
        self.cutoff_key = self.cutoff.isoformat() if self.cutoff else ""
        self.until_key = self.until.isoformat() if self.until else ""
        self.empty_window = self.cutoff is not None and self.cutoff == self.until
        self.baseline = self.checkpoint_ids(source.get("checkpoint"))
        self.baseline_hash = self.fingerprint(self.baseline) if self.baseline is not None else ""
        self.call = ext.api._call
        self.supplement = bool(ext.sanity_workaround)
        self.cursor = cursor
        self.phase = "app"
        self.head = None
        self.expected = {}
        self.catalog_hash = None
        self.catalog_count = 0
        self.target_count = 0
        self.next_offset = 0
        self.called = False
        self.app_pages = 0
        self.old_pages = 0
        self.last_time = None
        self.order_anomaly = False
        self.deferred = set()
        if cursor is not None:
            if (not isinstance(cursor, dict) or type(cursor.get("_v")) is not int or cursor["_v"] != 3
                    or cursor.get("_source") != self.source_id
                    or cursor.get("_cutoff") != self.cutoff_key
                    or cursor.get("_until") != self.until_key
                    or cursor.get("_baseline") != self.baseline_hash
                    or cursor.get("_phase") not in ("app", "sanity")):
                raise error("cursor_invalid")
            deferred = cursor.get("_deferred")
            if (not isinstance(deferred, list) or len(deferred) > MAX_DEFERRED_IDS
                    or any(type(item) is not str for item in deferred)
                    or len(set(deferred)) != len(deferred)):
                raise error("cursor_invalid")
            try:
                self.deferred = {self.identifier(item) for item in deferred}
            except self.error:
                raise error("cursor_invalid") from None
            self.phase = cursor["_phase"]
            self.head = self.proof(cursor.get("_head"))
            if self.phase == "app":
                allowed = {"_v", "_source", "_cutoff", "_until", "_baseline", "_deferred", "_phase", "_head",
                           "user_id", "offset", "filter", "type", "_previous", "_ids",
                           "_pages", "_old_pages", "_last_time", "_order_anomaly"}
                if set(cursor) - allowed:
                    raise error("cursor_invalid")
                self.params(cursor)
                self.proof({"params": cursor.get("_previous"), "ids": cursor.get("_ids")})
                self.app_pages, self.old_pages = cursor.get("_pages"), cursor.get("_old_pages")
                self.order_anomaly = cursor.get("_order_anomaly")
                if (type(self.app_pages) is not int or self.app_pages < 1
                        or type(self.old_pages) is not int or not 0 <= self.old_pages <= 1
                        or type(self.order_anomaly) is not bool
                        or (self.order_anomaly and self.old_pages)):
                    raise error("cursor_invalid")
                try:
                    value = cursor["_last_time"]
                    if value is not None and (not isinstance(value, str) or not value):
                        raise error("cursor_invalid")
                    self.last_time = self.date(value) if value is not None else None
                except (self.error, KeyError):
                    raise error("cursor_invalid") from None
            else:
                allowed = {"_v", "_source", "_cutoff", "_until", "_baseline", "_deferred", "_phase", "_head",
                           "_hash", "_count", "_offset", "_targets"}
                if set(cursor) != allowed:
                    raise error("cursor_invalid")
                fingerprint, count, offset = cursor["_hash"], cursor["_count"], cursor["_offset"]
                targets = cursor["_targets"]
                if (type(count) is not int or type(offset) is not int
                        or type(targets) is not int
                        or not 0 <= offset <= targets <= count <= MAX_CATALOG_IDS
                        or (fingerprint is None and (count != 0 or offset != 0 or targets != 0))
                        or (fingerprint is not None and (not isinstance(fingerprint, str)
                            or not re.fullmatch(r"[0-9a-f]{64}", fingerprint)))):
                    raise error("cursor_invalid")
        # Optional enrichment must not create unbounded comment/user traversals.
        ext.meta_user = False
        ext.meta_bookmark = False
        ext.meta_comments = False
        ext.meta_captions = False
        # Native AJAX conversion unescapes entities before the metadata boundary.
        # Keep existing HTML intact until the bridge parses it once, preserving
        # encoded literal angle brackets as text. Link URLs are not needed.
        ext._sanitize_ajax_caption = lambda caption: caption or ""
        ext.load_ugoira = False
        ext.metadata = lambda: {}
        if self.phase == "app":
            ext.api._call = self.app_call
        else:
            # Native placeholders must always resolve real author/date/type.
            ext.sanity_workaround = True

    def date(self, value):
        if not isinstance(value, str):
            raise self.error("discovery_incomplete")
        try:
            parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                raise ValueError("timezone missing")
            return parsed.astimezone(datetime.timezone.utc)
        except (ValueError, OverflowError):
            raise self.error("discovery_incomplete") from None

    def identifier(self, value):
        if type(value) not in (int, str) or not re.fullmatch(r"[1-9][0-9]{0,19}", str(value)):
            raise self.error("discovery_incomplete")
        return str(value)

    def checkpoint_ids(self, value):
        # A missing/invalid cache cannot establish prior coverage. Bootstrap
        # safely instead of trusting a cache belonging to another account.
        if (not isinstance(value, dict) or set(value) != {"version", "sourceId", "ids"}
                or type(value["version"]) is not int or value["version"] != 1
                or type(value["sourceId"]) is not str or value["sourceId"] != self.source_id
                or not isinstance(value["ids"], list) or len(value["ids"]) > MAX_CATALOG_IDS
                or any(type(item) is not str for item in value["ids"])):
            return None
        try:
            ids = {self.identifier(item) for item in value["ids"]}
        except self.error:
            return None
        return ids if len(ids) == len(value["ids"]) else None

    def fingerprint(self, ids):
        ordered = sorted(ids, key=int, reverse=True)
        return hashlib.sha256(json.dumps(ordered, separators=(",", ":")).encode()).hexdigest()

    def may_be_recent(self, value):
        # A list endpoint may truncate seconds. Use UTC minute floors at the
        # lower discovery boundary; final native dates control persistence.
        if self.empty_window:
            return False
        date = self.date(value)
        minute = date.replace(second=0, microsecond=0)
        return ((self.cutoff is None or minute >= self.cutoff.replace(second=0, microsecond=0))
                and (self.until is None or date < self.until))

    def in_window(self, value):
        date = self.date(value)
        return ((self.cutoff is None or date >= self.cutoff)
                and (self.until is None or date < self.until))

    def defer_if_future(self, post_id, value):
        date = self.date(value)
        future = self.until is not None and (
            date >= self.until or (self.empty_window
                and date.replace(second=0, microsecond=0) >= self.until.replace(second=0, microsecond=0)))
        if future:
            self.deferred.add(self.identifier(post_id))
            if len(self.deferred) > MAX_DEFERRED_IDS:
                raise self.error("limit_reached")
            if isinstance(self.result.get("next"), dict):
                self.result["next"]["_deferred"] = sorted(self.deferred, key=int, reverse=True)
            return True
        return False

    def same_publication_time(self, left, right):
        first, second = self.date(left), self.date(right)
        return (first == second or first == second.replace(second=0, microsecond=0)
                or second == first.replace(second=0, microsecond=0))

    def params(self, value):
        if not isinstance(value, dict):
            raise self.error("cursor_invalid")
        params = {key: str(value[key]) for key in ("user_id", "offset", "filter", "type") if key in value}
        params.setdefault("offset", "0")
        return self.parse_cursor("https://app-api.pixiv.net/v1/user/illusts?" + urlencode(params), self.source_id)

    def proof(self, value):
        if not isinstance(value, dict) or set(value) != {"params", "ids"}:
            raise self.error("cursor_invalid")
        params, ids = self.params(value["params"]), value["ids"]
        if (not isinstance(ids, list) or len(ids) > APP_PAGE_SIZE
                or any(type(item) is not str for item in ids)
                or len(set(ids)) != len(ids)):
            raise self.error("cursor_invalid")
        try:
            for item in ids:
                self.identifier(item)
        except Exception:
            raise self.error("cursor_invalid") from None
        return {"params": params, "ids": ids}

    def base(self, phase):
        return {"_v": 3, "_source": self.source_id, "_cutoff": self.cutoff_key,
                "_until": self.until_key, "_baseline": self.baseline_hash,
                "_deferred": sorted(self.deferred, key=int, reverse=True),
                "_phase": phase, "_head": self.head}

    def page_ids(self, data):
        if not isinstance(data, dict) or not isinstance(data.get("user"), dict):
            raise self.error("source_identity_conflict")
        owner, works = str(data["user"].get("id", "")), data.get("illusts")
        if owner != self.source_id:
            if owner != "0" or works != [] or data.get("next_url", False) is not None:
                raise self.error("source_identity_conflict")
            self.verify_user()
        if not isinstance(works, list) or len(works) > APP_PAGE_SIZE:
            raise self.error("discovery_incomplete")
        ids, malformed = [], False
        for work in works:
            try:
                if not isinstance(work, dict) or not isinstance(work.get("user"), dict):
                    raise self.error("discovery_incomplete")
                author = self.identifier(work["user"].get("id"))
                item = self.identifier(work.get("id"))
                ids.append(item)
                self.remember(item, author)
                if author == self.source_id:
                    if (type(work.get("type")) is not str or work["type"] not in ("illust", "manga", "ugoira")
                            or type(work.get("page_count")) is not int or not 1 <= work["page_count"] <= 1000
                            or not isinstance(work.get("meta_pages"), list) or len(work["meta_pages"]) > 1000):
                        raise self.error("discovery_incomplete")
                    self.date(work.get("create_date"))
            except self.error:
                malformed = True
        if malformed or len(set(ids)) != len(ids):
            raise self.error("discovery_incomplete")
        return ids

    def verify_user(self):
        detail = self.call("/v1/user/detail", {"user_id": self.source_id})
        user = detail.get("user") if isinstance(detail, dict) else None
        if not isinstance(user, dict) or str(user.get("id")) != self.source_id:
            raise self.error("source_identity_conflict")
        if user.get("is_access_blocking_user"):
            raise self.error("source_forbidden")

    def verify_head(self):
        if self.page_ids(self.call("/v1/user/illusts", dict(self.head["params"]))) != self.head["ids"]:
            raise self.error("cursor_invalid")

    def app_call(self, endpoint, params=None, **kwargs):
        if endpoint != "/v1/user/illusts":
            return self.call(endpoint, params, **kwargs)
        if self.called:
            raise self.page_done()
        effective = self.params(self.cursor or params)
        previous = self.cursor and self.proof({"params": self.cursor["_previous"], "ids": self.cursor["_ids"]})
        if previous and self.page_ids(self.call(endpoint, dict(previous["params"]), **kwargs)) != previous["ids"]:
            raise self.error("cursor_invalid")
        data = self.call(endpoint, dict(effective), **kwargs)
        ids = self.page_ids(data)
        if previous and self.page_ids(self.call(endpoint, dict(previous["params"]), **kwargs)) != previous["ids"]:
            raise self.error("cursor_invalid")
        self.called = True
        if self.head is None:
            self.head = {"params": effective, "ids": ids}
        if "next_url" not in data:
            raise self.error("discovery_incomplete")
        dates = [self.date(work["create_date"]) for work in data["illusts"]
                 if str(work["user"]["id"]) == self.source_id]
        for work in data["illusts"]:
            if str(work["user"]["id"]) == self.source_id:
                self.defer_if_future(work["id"], work["create_date"])
        previous_time = self.last_time
        for date in dates:
            # Minute truncation between upstream endpoints is not evidence of
            # an order change. A true increase disables the time shortcut for
            # the rest of this bounded App traversal.
            if (previous_time is not None
                    and date.replace(second=0, microsecond=0) > previous_time.replace(second=0, microsecond=0)):
                self.order_anomaly = True
            previous_time = date
        self.last_time = previous_time
        full_old = (not self.order_anomaly and self.cutoff is not None
                    and len(dates) == APP_PAGE_SIZE
                    and all(date.replace(second=0, microsecond=0) < self.cutoff.replace(second=0, microsecond=0)
                            for date in dates))
        self.old_pages = self.old_pages + 1 if full_old else 0
        self.app_pages += 1
        stop_history = self.supplement and (self.empty_window or self.old_pages >= 2)
        following = None
        if data["next_url"] is not None:
            following = self.parse_cursor(data["next_url"], self.source_id)
            if not ids or following == effective:
                raise self.error("cursor_invalid")
        if following is not None and not stop_history:
            self.result["next"] = dict(self.base("app"), **following, _previous=effective, _ids=ids,
                                      _pages=self.app_pages, _old_pages=min(self.old_pages, 1),
                                      _last_time=self.last_time.isoformat() if self.last_time else None,
                                      _order_anomaly=self.order_anomaly)
            self.result["terminal"] = False
        elif self.supplement:
            self.result["next"] = dict(self.base("sanity"), _hash=None, _count=0, _offset=0, _targets=0)
            self.result["terminal"] = False
        else:
            self.result["next"], self.result["terminal"] = None, True
        return data

    def catalog(self):
        data = self.ext._request_ajax("/user/" + self.source_id + "/profile/all")
        if not isinstance(data, dict):
            raise self.error("discovery_incomplete")
        ids = set()
        for name in ("illusts", "manga"):
            group = data.get(name)
            if not isinstance(group, dict) and group != []:
                raise self.error("discovery_incomplete")
            if len(group) + len(ids) > MAX_CATALOG_IDS:
                raise self.error("limit_reached")
            for key in group:
                ids.add(self.identifier(key))
        ordered = sorted(ids, key=int, reverse=True)
        digest = self.fingerprint(ordered)
        return ordered, digest

    def works(self):
        if self.phase == "app":
            # Do not use works(): _extend_sanity assumes traversal from the head.
            for work in self.ext.api.user_illusts(self.source_id):
                if str(work["user"]["id"]) == self.source_id:
                    if work["type"] == "ugoira" or not self.may_be_recent(work["create_date"]):
                        continue
                yield work
            return
        ids, digest = self.catalog()
        self.catalog_hash, self.catalog_count = digest, len(ids)
        if self.cursor["_hash"] is not None and (self.cursor["_hash"] != digest or self.cursor["_count"] != len(ids)):
            raise self.error("cursor_invalid")
        # The full directory is always fingerprinted. Only the first baseline
        # requires all metadata; later scans resolve new IDs anywhere in that
        # directory plus a small recent prefix, never a numeric-ID cutoff.
        # Empty windows still inspect dates before caching IDs, so a directory
        # observed after the fixed upper time cannot swallow future additions.
        if self.baseline is None:
            targets = ids
        else:
            prefix = set(ids[:RECENT_RECHECK_IDS])
            targets = [item for item in ids if item not in self.baseline or item in prefix]
        self.target_count = len(targets)
        offset = self.cursor["_offset"]
        if (offset > self.target_count
                or (self.cursor["_hash"] is not None and self.cursor["_targets"] != self.target_count)):
            raise self.error("cursor_invalid")
        if not ids:
            self.verify_user()
        selected = targets[offset:offset + CATALOG_PAGE_SIZE]
        self.next_offset = offset
        if not selected:
            return
        query = urlencode([("ids[]", item) for item in selected] + [("work_category", "illustManga"), ("is_first_page", "0")])
        data = self.ext._request_ajax("/user/" + self.source_id + "/profile/illusts?" + query)
        works = data.get("works") if isinstance(data, dict) else None
        if not isinstance(works, dict) or set(works) != set(selected):
            raise self.error("discovery_incomplete")
        # Validate the whole response before allowing any part of it to advance.
        for item in selected:
            work = works[item]
            if (not isinstance(work, dict) or self.identifier(work.get("id")) != item
                    or str(work.get("userId")) != self.source_id
                    or type(work.get("illustType")) is not int or work["illustType"] not in (0, 1, 2)):
                raise self.error("discovery_incomplete")
            self.remember(item, self.source_id)
            self.date(work.get("createDate"))
            self.defer_if_future(item, work["createDate"])
        details = 0
        for item in selected:
            work = works[item]
            # Pixiv's list timestamp can retain seconds that the detail endpoint
            # rounds to a minute. Use the minute's upper bound for discovery;
            # native detail dates remain authoritative at the storage boundary.
            recent = self.may_be_recent(work["createDate"])
            if recent and work["illustType"] != 2:
                if details >= DETAIL_PAGE_SIZE:
                    break
                self.expected[item] = work
                details += 1
                yield self.ext._make_work(int(item), self.ext.limit_url, {"id": 1})
            self.next_offset += 1

    def validate_resolved(self, work):
        if self.phase != "sanity":
            return
        brief = self.expected.get(str(work.get("id")))
        if (brief is None or str(work.get("user", {}).get("id")) != self.source_id
                or work.get("type") != ("illust", "manga", "ugoira")[brief["illustType"]]
                or not self.same_publication_time(work.get("create_date"), brief["createDate"])):
            raise self.error("discovery_incomplete")
        self.defer_if_future(work["id"], work["create_date"])

    def finish(self):
        if self.phase != "sanity":
            return
        ids, digest = self.catalog()
        if digest != self.catalog_hash or len(ids) != self.catalog_count:
            raise self.error("cursor_invalid")
        if self.next_offset == self.target_count:
            self.verify_head()
            self.result["next"], self.result["terminal"] = None, True
            self.result["checkpoint"] = {"version": 1, "sourceId": self.source_id,
                                         "ids": [item for item in ids if item not in self.deferred]}
        else:
            self.result["next"] = dict(self.base("sanity"), _hash=digest, _count=len(ids),
                                      _offset=self.next_offset, _targets=self.target_count)
            self.result["terminal"] = False
