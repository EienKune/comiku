"""Bounded native pages with conservative coverage and recoverable errors.

The private input file and stdout envelope are the only protocol. Diagnostics
are consumed only by server logging, never by public API error responses.
"""
import datetime
import json
import logging
import re
import sys
import traceback
from urllib.parse import urlsplit, parse_qsl, unquote

from gallery_dl import config, version
from gallery_dl.extractor import twitter, pixiv
from gallery_dl.util import NullResponse
from pixiv_paging import PixivPager
from pixiv_caption import plain_caption


class AdapterError(Exception):
    def __init__(self, code, result=None, guard=None, detail=None):
        super().__init__(code)
        self.result = result
        self.guard = guard or code
        self.detail = detail or {}


class PageDone(Exception):
    pass


def pixiv_cursor(url, source_id):
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.netloc != "app-api.pixiv.net" or parsed.path != "/v1/user/illusts" or parsed.fragment:
        raise AdapterError("cursor_invalid")
    pairs = parse_qsl(parsed.query, keep_blank_values=True)
    params = dict(pairs)
    if len(params) != len(pairs) or set(params) - {"user_id", "offset", "filter", "type"} or params.get("user_id") != source_id:
        raise AdapterError("cursor_invalid")
    if not re.fullmatch(r"[0-9]{1,10}", params.get("offset", "")) or params.get("filter", "for_ios") != "for_ios" or params.get("type", "illust") not in ("illust", "manga"):
        raise AdapterError("cursor_invalid")
    return params


def safe_error(exc, resumed=False):
    value = (type(exc).__name__ + " " + str(exc)).lower()
    if type(exc).__name__ == "NotFoundError":
        if "requested user could not be found" in value:
            return "source_not_found"
        if any("requested " + kind + " could not be found" in value
               for kind in ("tweet", "post", "artwork", "illustration")):
            return "post_not_found"
    if resumed and "cursor" in value and any(w in value for w in ("invalid", "expired", "not found")):
        return "cursor_invalid"
    if "429" in value or "rate limit" in value:
        return "rate_limited"
    if "captcha" in value or "temporarily locked" in value:
        return "challenge_required"
    if any(w in value for w in ("protected", "blocked your account", "nsfw tweet")):
        return "source_forbidden"
    if any(w in value for w in ("authentication", "loginrequired", "could not authenticate", "authenticated cookies")):
        return "auth_failed"
    if any(w in value for w in ("timeout", "connectionerror", "network", "dns")):
        return "network_error"
    return "connector_failed"


diagnostic_secrets = []


def private_text(value, limit, tail=False):
    value = str(value)
    if len(value) > 262144 or len(diagnostic_secrets) > 128 or any(len(secret) > 1024 for secret in diagnostic_secrets) or sum(map(len, diagnostic_secrets)) > 65536:
        return "[diagnostic omitted]"
    def endpoint(match):
        try:
            parsed = urlsplit(match[0])
            return parsed.scheme + "://" + (parsed.hostname or "") + parsed.path
        except ValueError:
            return "[url removed]"
    for _ in range(3):
        value = re.sub(r'''https?://[^\s"'<>]+''', endpoint, value)
        previous = value
        ambiguous = False
        def part(text):
            nonlocal ambiguous
            if re.search(r'''[\s"'<>]''', text):
                ambiguous = True
            return text
        value = re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: part(chr(int(m[1], 16))), value)
        value = re.sub(r'\\([\\"/])', lambda m: part(m[1]), value)
        value = re.sub(r"(?:%[0-9a-fA-F]{2})+", lambda m: part(unquote(m[0])), value)
        if ambiguous:
            return "[diagnostic omitted]"
        if value == previous:
            break
        if _ == 2:
            return "[diagnostic omitted]"
    value = re.sub(r'''https?://[^\s"'<>]+''', endpoint, value)
    # Match sensitive keys before credential-fragment removal can erase those keys.
    sensitive = r'''(?i)(["']?\b(?:authorization|proxy-authorization|cookie|set-cookie|[\w-]{0,64}(?:token|secret|password|signature|api[_-]?key)[\w-]{0,64})["']?\s*[:=]\s*)[^\r\n]*'''
    if re.search(r"[\r\n]", value) and re.search(sensitive, value):
        return "[diagnostic omitted]"
    value = re.sub(sensitive, r"\1[credential removed]", value)
    for secret in sorted(diagnostic_secrets, key=len, reverse=True):
        if not secret:
            continue
        value = value.replace(secret, "[credential removed]")
        if len(secret) >= 4:
            fragments = {re.escape(secret[i:i + 4]) for i in range(len(secret) - 3)}
            value = re.sub("(?:" + "|".join(sorted(fragments)) + ")+", "[credential removed]", value)
    if len(value) <= limit:
        return value
    return ("[truncated] " + value[-limit:]) if tail else (value[:limit] + " [truncated]")


def previous_diagnostic_text(diagnostic):
    """Re-sanitize selected scalar context, then serialize without decoding JSON."""
    safe = {}
    if not isinstance(diagnostic, dict):
        return "{}"
    for key in ("stage", "guard", "exception_type", "runtime_version", "message", "http_status", "http_method", "http_endpoint", "response_excerpt", "traceback"):
        value = diagnostic.get(key)
        if not isinstance(value, (str, int, bool)):
            continue
        candidate = dict(safe, **{key: private_text(value, 2048)})
        if len(json.dumps(candidate, ensure_ascii=True).encode("ascii")) <= 8192:
            safe = candidate
    return json.dumps(safe, ensure_ascii=True)


def configure_diagnostics():
    token = config.get(("extractor", "pixiv"), "refresh-token")
    if token:
        diagnostic_secrets.append(str(token))
    cookies = config.get(("extractor", "twitter"), "cookies")
    if isinstance(cookies, dict):
        diagnostic_secrets.extend(str(value) for value in cookies.values())
    if isinstance(cookies, str):
        with open(cookies, encoding="utf-8") as file:
            for line in file:
                fields = line.rstrip("\r\n").split("\t")
                if len(fields) >= 7:
                    diagnostic_secrets.append(fields[-1])


class DiagnosticHandler(logging.Handler):
    """Bounded recent warnings/errors; no progress or HTTP debug dumps."""
    def __init__(self):
        super().__init__(logging.WARNING)
        self.messages = []

    def emit(self, record):
        self.messages.append(private_text(self.format(record), 2048, tail=True))
        self.messages = self.messages[-8:]


diagnostic_handler = DiagnosticHandler()


def safe_diagnostic(exc, stage):
    """Private bounded details. The TypeScript boundary applies another allowlist."""
    diagnostic = {"stage": stage, "exception_type": type(exc).__name__, "runtime_version": version.__version__,
                  "message": private_text(exc, 8192),
                  "traceback": private_text("".join(traceback.format_exception(type(exc), exc, exc.__traceback__)), 16384, tail=True)}
    if isinstance(exc, AdapterError):
        diagnostic["guard"] = exc.guard
        diagnostic.update({key: private_text(value, 2048) for key, value in exc.detail.items()})
    if isinstance(exc, KeyError) and exc.args:
        diagnostic["field"] = private_text(exc.args[0], 256)
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None) if response is not None else getattr(exc, "status_code", None)
    if status is None:
        match = re.match(r"(?:HTTP\s+)?([45][0-9]{2})\b", str(exc))
        status = match[1] if match else None
    if status is not None:
        diagnostic["http_status"] = str(status)
    if response is not None:
        diagnostic["response_excerpt"] = private_text(getattr(response, "text", ""), 4096)
    diagnostic.update(getattr(exc, "_collection_http_diagnostic", {}))
    if diagnostic_handler.messages:
        diagnostic["upstream_logs"] = "\n".join(diagnostic_handler.messages)
    return diagnostic


def http_failure_diagnostic(response, url, method):
    """Capture at our HTTP boundary before native AbortExtraction drops it."""
    parsed = urlsplit(str(url))
    endpoint = parsed.scheme + "://" + (parsed.hostname or "") + parsed.path
    allowed = {"content-type", "server", "cf-ray", "x-request-id", "x-transaction-id",
               "x-rate-limit-limit", "x-rate-limit-remaining", "x-rate-limit-reset",
               "retry-after"}
    headers = {key.lower(): private_text(value, 512) for key, value in response.headers.items()
               if key.lower() in allowed}
    return {"http_status": str(response.status_code), "http_method": str(method),
            "http_endpoint": private_text(endpoint, 1024),
            "http_response_bytes": str(len(response.content)),
            "http_response_headers": json.dumps(headers, ensure_ascii=False),
            "http_response_excerpt": private_text(response.text, 4096)}


def parse_cutoff(value):
    """Normalize Go's variable precision to Python's six fractional digits."""
    normalized = value.replace("Z", "+00:00")
    normalized = re.sub(r"\.(\d{1,9})(?=[+-]\d{2}:\d{2}$)",
                        lambda match: "." + match[1][:6].ljust(6, "0"), normalized)
    return datetime.datetime.fromisoformat(normalized)


def empty_x_repeat(data, cursor, source_id, user):
    """Recognize only an unmodified, bound, cursor-only exhaustion response.

    This is evidence, not permission to advance a scan's time boundary. The Go
    worker additionally requires prior safe old-page coverage in the same run.
    """
    if (not isinstance(cursor, str) or not cursor or not isinstance(user, dict)
            or str(user.get("rest_id")) != source_id or not isinstance(data, dict)
            or ("errors" in data and data["errors"] is not None and data["errors"] != [])):
        return False
    try:
        owner = data["data"]["user"]["result"]
        if not isinstance(owner, dict) or ("rest_id" in owner and str(owner["rest_id"]) != source_id):
            return False
        instructions = owner["timeline"]["timeline"]["instructions"]
    except (KeyError, TypeError):
        return False
    if not isinstance(instructions, list) or not instructions:
        return False
    bottom, top, pages = 0, 0, 0
    for instruction in instructions:
        if not isinstance(instruction, dict):
            return False
        if (instruction.get("type") == "TimelineTerminateTimeline" and instruction.get("direction") == "Bottom"
                and not set(instruction) - {"type", "direction"}):
            continue
        if instruction.get("type") != "TimelineAddEntries" or set(instruction) - {"type", "entries"}:
            return False
        pages += 1
        entries = instruction.get("entries")
        if not isinstance(entries, list) or not entries:
            return False
        for entry in entries:
            if (not isinstance(entry, dict) or not isinstance(entry.get("entryId"), str)
                    or set(entry) - {"entryId", "sortIndex", "content"}
                    or ("sortIndex" in entry and not isinstance(entry["sortIndex"], str))):
                return False
            content = entry.get("content")
            if not isinstance(content, dict):
                return False
            if any(key in content and not isinstance(content[key], str) for key in ("entryType", "__typename")):
                return False
            if "itemContent" in content and set(content) - {"entryType", "__typename", "itemContent"}:
                return False
            content = content.get("itemContent", content)
            if not isinstance(content, dict) or set(content) - {"entryType", "__typename", "cursorType", "value", "stopOnEmptyResponse"}:
                return False
            if any(key in content and not isinstance(content[key], str) for key in ("entryType", "__typename")):
                return False
            if "stopOnEmptyResponse" in content and not isinstance(content["stopOnEmptyResponse"], bool):
                return False
            value = content.get("value")
            if not isinstance(value, str) or not value or len(value) > 8192:
                return False
            if entry["entryId"].startswith("cursor-bottom-"):
                if content.get("cursorType") != "Bottom" or content.get("stopOnEmptyResponse", True) is not True or value != cursor:
                    return False
                bottom += 1
            elif entry["entryId"].startswith("cursor-top-"):
                if content.get("cursorType") != "Top":
                    return False
                top += 1
            else:
                return False
    return pages == 1 and bottom == 1 and top <= 1


def collect(source, cursor):
    if version.__version__ != "1.32.11":
        raise AdapterError("runtime_unavailable")
    source_id = source["remote_id"]
    if not re.fullmatch(r"[0-9]+", source_id):
        raise AdapterError("source_unresolved")
    is_x = source["platform"] == "x"
    response_cursor = None
    result = {"version": 1, "platform": source["platform"], "source_id": source_id,
              "records": [], "failed_ids": [], "next": None, "terminal": False,
              "boundary": False, "page_complete": False, "order_anomaly": False,
              "first_date": None, "last_date": None, "neutral": False,
              "coverage": {"ordinary": 0, "owned_context": 0, "foreign": 0,
                           "excluded_retweet": 0, "quoted_context": 0,
                           "recent": 0, "unknown_date": 0, "ignored_pins": 0}}
    coverage = result["coverage"]
    cutoff = source.get("cutoff")
    cutoff = parse_cutoff(cutoff) if cutoff else None
    all_old, target_count = cutoff is not None, 0
    last_date = None
    native_checked = False
    observed_ids, handled_ids = {}, set()
    original_unquoted_legacy = {}

    def eligible_x(legacy):
        return not ((not ext.retweets and ("retweeted_status_id_str" in legacy or "retweeted_status_result" in legacy))
                    or (not ext.quoted and "quoted_by_id_str" in legacy))

    def remember(post_id, owner, eligible=True):
        if eligible and owner == source_id and post_id.isdecimal():
            observed_ids[post_id] = None
            if len(observed_ids) > 1000:
                raise AdapterError("limit_reached")

    def observe_x(legacy, owner, ordinary):
        nonlocal all_old, target_count, last_date
        if owner != source_id:
            coverage["foreign"] += 1
            return
        if not eligible_x(legacy):
            category = "quoted_context" if "quoted_by_id_str" in legacy else "excluded_retweet"
            coverage[category] += 1
            return
        target_count += 1
        if ordinary:
            coverage["ordinary"] += 1
        else:
            coverage["owned_context"] += 1
        try:
            date = datetime.datetime.strptime(legacy["created_at"], "%a %b %d %H:%M:%S %z %Y")
            if cutoff is None or date >= cutoff:
                all_old = False
                coverage["recent"] += 1
            # Module child dates must be checked, but their order inside a
            # conversation is not the ordinary timeline's chronological order.
            if ordinary:
                date_text = date.astimezone(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
                if result["first_date"] is None:
                    result["first_date"] = date_text
                if last_date is not None and date > last_date:
                    result["order_anomaly"] = True
                last_date = date
                result["last_date"] = date_text
        except (KeyError, ValueError, TypeError):
            all_old = False
            coverage["unknown_date"] += 1

    def with_http_diagnostic(exc):
        detail = getattr(ext, "_collection_http_failure", None)
        if detail:
            exc._collection_http_diagnostic = detail
        return exc

    def incomplete(exc, preserve_diagnostic=False):
        result.pop("checkpoint", None)
        for post_id in observed_ids:
            if post_id not in handled_ids and post_id not in result["failed_ids"]:
                result["failed_ids"].append(post_id)
        previous_diagnostic = result.get("diagnostic")
        if not preserve_diagnostic or not previous_diagnostic:
            result["diagnostic"] = safe_diagnostic(with_http_diagnostic(exc), "validation")
            if previous_diagnostic:
                result["diagnostic"]["previous_diagnostic"] = previous_diagnostic_text(previous_diagnostic)
        result["diagnostic"].update({
            "cutoff": cutoff.isoformat() if cutoff else "",
            "coverage": json.dumps(coverage, sort_keys=True),
            "first_date": result["first_date"] or "", "last_date": result["last_date"] or "",
            "request_cursor_length": str(len(cursor)) if isinstance(cursor, str) else "0",
            "response_cursor_length": str(len(response_cursor)) if isinstance(response_cursor, str) else "0",
            "same_cursor": str(cursor is not None and cursor == response_cursor).lower(),
        })
        result.update(error=str(exc), next=None, terminal=False, boundary=False, page_complete=False, empty_cursor_repeat=False)
        exc.result = result
        return exc

    def install_x_checks(ext):
        native_request = ext.request
        ext._collection_http_failure = None
        def checked_request(*args, **kwargs):
            ext._collection_http_failure = None
            response = native_request(*args, **kwargs)
            # Native fatal=None converts exhausted transport errors into an
            # empty synthetic response; its {} must not become NotFoundError.
            if isinstance(response, NullResponse):
                raise AdapterError("network_error", guard="transport_null_response", detail={"transport_reason": response.reason})
            if response.status_code >= 400:
                try:
                    ext._collection_http_failure = http_failure_diagnostic(response, args[0] if args else kwargs.get("url", ""), kwargs.get("method", "GET"))
                except Exception:
                    # Instrumentation must not replace the native failure or
                    # change successful parsing/retry semantics.
                    ext._collection_http_failure = {"http_diagnostic_error": "response_capture_failed"}
            return response
        ext.request = checked_request
        call = ext.api._call
        def checked_call(*args, **kwargs):
            nonlocal response_cursor, native_checked, all_old
            ext._collection_http_failure = None
            try:
                data = call(*args, **kwargs)
            except Exception as exc:
                with_http_diagnostic(exc)
                raise
            # Native _call can return error JSON and fail later in pagination.
            # Retain only this response until the next call/request replaces it.
            response_cursor = None
            native_checked = True
            response_error = None
            # Count before inspection mutates native entries. No payload/URLs.
            response_entries = 0
            def count_entries(value):
                nonlocal response_entries
                if isinstance(value, dict):
                    response_entries += "entryId" in value
                    for child in value.values():
                        count_entries(child)
                elif isinstance(value, list):
                    for child in value:
                        count_entries(child)
            count_entries(data)

            if empty_x_repeat(data, cursor, source_id, ext._user_obj):
                result["empty_cursor_repeat"] = True

            def invalid(code, guard=None):
                nonlocal response_error, all_old
                all_old = False
                if response_error is None:
                    sites = traceback.extract_stack(limit=4)[:-1]
                    response_error = AdapterError(code, guard=guard, detail={
                        "response_entry_count": response_entries,
                        "validation_site": " > ".join(f"{frame.name}:{frame.lineno}" for frame in sites),
                    })
            # The native paginator treats repeated cursors and malformed tweet
            # entries as exhaustion/skips. Detect these before that information
            # is discarded; do not advance coverage over unidentified records.
            def validate_x_tweet(value, ordinary=False, recovery_only=False):
                """Validate an X native entry before gallery-dl can consume it.

                Native module children do not have a stable entryId prefix, so
                this payload check is shared by both prefixed entries and
                arbitrary children in a recognized module container.
                """
                nonlocal all_old
                container = value.get("content") or value.get("item") or value
                item = container.get("itemContent", container) if isinstance(container, dict) else {}
                tweet_results = item.get("tweet_results") if isinstance(item, dict) else None
                tweet = tweet_results.get("result", {}) if isinstance(tweet_results, dict) else {}
                tweet = tweet.get("tweet", tweet) if isinstance(tweet, dict) else {}
                legacy = tweet.get("legacy") if isinstance(tweet, dict) else None
                legacy = legacy if isinstance(legacy, dict) else {}
                core_author = tweet
                for key in ("core", "user_results", "result", "rest_id"):
                    core_author = core_author.get(key) if isinstance(core_author, dict) else None
                post_id = str(legacy.get("id_str") or (tweet.get("rest_id") if isinstance(tweet, dict) else "") or "")
                author_id = str(legacy.get("user_id_str") or core_author or "")
                if recovery_only:
                    # An unrecognized wrapper is unusable for pagination. Its
                    # recovery ID needs both independent identity representations
                    # to be present and agree before it can be journaled.
                    rest_id = str(tweet.get("rest_id", "")) if isinstance(tweet, dict) else ""
                    if (post_id.isdecimal() and author_id.isdecimal()
                            and legacy.get("id_str") and legacy.get("user_id_str")
                            and rest_id == post_id and str(core_author) == author_id):
                        remember(post_id, author_id, eligible_x(legacy))
                    return False
                if not post_id.isdecimal() or not author_id.isdecimal():
                    return reject_x_wrapper(value)
                if core_author is not None and str(core_author) != author_id:
                    return reject_x_wrapper(value)
                remember(post_id, author_id, eligible_x(legacy))
                observe_x(legacy, author_id, ordinary)
                if not legacy.get("id_str") or not legacy.get("user_id_str") or core_author is None:
                    if author_id == source_id and post_id not in result["failed_ids"]:
                        result["failed_ids"].append(post_id)
                    recover_x_payloads(value)
                    return False
                if author_id == source_id and eligible_x(legacy) and "quoted_by_id_str" not in legacy:
                    original_unquoted_legacy[post_id] = legacy
                return True

            def recover_x_payloads(value):
                # Module children can still have safe payloads when their parent
                # wrapper is malformed; inspect those solely for recovery IDs.
                if isinstance(value, dict):
                    validate_x_tweet(value, recovery_only=True)
                    for child in value.values():
                        recover_x_payloads(child)
                elif isinstance(value, list):
                    for child in value:
                        recover_x_payloads(child)

            def reject_x_wrapper(value, code="discovery_incomplete", guard=None):
                # Every rejected container may still hold corroborated owned
                # payloads. Recover them before the native wrapper is discarded.
                invalid(code, guard)
                recover_x_payloads(value)
                return False

            def contains_x_payload(value, include_modules=True):
                if isinstance(value, dict):
                    return ("tweet_results" in value or (include_modules and "items" in value)
                            or any(contains_x_payload(child, include_modules) for child in value.values()))
                if isinstance(value, list):
                    return any(contains_x_payload(child, include_modules) for child in value)
                return False

            def inspect(value, module_child=False):
                nonlocal response_cursor, all_old
                if isinstance(value, dict):
                    # Recognized parent modules extend these payloads directly
                    # into the native tweet list; children need no entryId.
                    if module_child:
                        return validate_x_tweet(value)
                    if value.get("type") == "TimelinePinEntry" and not ext.pinned:
                        # The native paginator omits this explicitly disabled
                        # context. Its ID must not become a failed candidate;
                        # ordinary occurrences remain independently inspected.
                        coverage["ignored_pins"] += 1
                        return True
                    entry_id = value.get("entryId", "")
                    if not isinstance(entry_id, str):
                        return reject_x_wrapper(value)
                    # X interleaves user recommendations with tweets. Native
                    # gallery-dl skips this recognized module; content.items
                    # alone must not make it a malformed tweet wrapper. Never
                    # exempt a module that actually contains tweet payloads.
                    recommendation = value.get("content")
                    if (entry_id.startswith("who-to-follow-")
                            and isinstance(recommendation, dict)
                            and isinstance(recommendation.get("items"), list)
                            and not contains_x_payload(value, include_modules=False)):
                        return True
                    # Only content/item containers are wrappers. Recursively
                    # visited itemContent and tweet_results dictionaries are
                    # normal payloads and do not need their own entryId.
                    wrapper = (("content" in value or "item" in value)
                               and contains_x_payload(value.get("content") or value.get("item")))
                    if not entry_id and wrapper:
                        return reject_x_wrapper(value)
                    if entry_id.startswith("cursor-bottom-"):
                        content = value.get("content", {})
                        content = content.get("itemContent", content) if isinstance(content, dict) else None
                        if not isinstance(content, dict):
                            return reject_x_wrapper(value)
                        bottom = content.get("value")
                        if bottom is not None and (not isinstance(bottom, str) or len(bottom)>8192):
                            return reject_x_wrapper(value, "cursor_invalid")
                        if cursor is not None and bottom == cursor and not result.get("empty_cursor_repeat"):
                            response_cursor = bottom
                            return reject_x_wrapper(value, "cursor_invalid", "x_repeated_cursor")
                        if bottom:
                            if response_cursor is not None and response_cursor != bottom:
                                return reject_x_wrapper(value)
                            response_cursor = bottom
                        return True
                    prefixes = ("tweet-", "tombstone-", "profile-grid-", "search-grid-", "communities-grid-", "homeConversation-", "profile-conversation-", "conversationthread-")
                    if entry_id.startswith(prefixes):
                        container = value.get("content") or value.get("item") or {}
                        if not isinstance(container, dict):
                            return reject_x_wrapper(value)
                        if "items" in container:
                            if not isinstance(container["items"], list):
                                return reject_x_wrapper(value)
                            inspect(container["items"], module_child=True)
                            return True
                        if not validate_x_tweet(value, ordinary=entry_id.startswith("tweet-") and value.get("type") != "TimelinePinEntry"):
                            # Remove only an identified malformed native entry;
                            # otherwise the paginator silently skips or retries
                            # it and never exposes its ID to durable recovery.
                            return False
                    elif wrapper:
                        return reject_x_wrapper(value)
                    elif entry_id:
                        # A new X wrapper is not automatically a benign
                        # context. Unknown coverage must never become a neutral
                        # gap or contribute to a completed time boundary.
                        if entry_id.startswith("cursor-top-"):
                            top = value.get("content", {})
                            top = top.get("itemContent", top) if isinstance(top, dict) else {}
                            if isinstance(top, dict) and top.get("cursorType") == "Top":
                                return True
                        return reject_x_wrapper(value)
                    # Native TimelineAddToModule.moduleItems remains a list of
                    # top-level entries; only recognized content.items above
                    # enters the context that accepts payload-only children.
                    for child in value.values():
                        inspect(child)
                elif isinstance(value, list):
                    value[:] = [child for child in value if inspect(child, module_child=module_child)]
                return True
            inspect(data)
            for error in data.get("errors", ()):
                message = str(error.get("message", "")).lower()
                if cursor is not None and "cursor" in message and any(word in message for word in ("invalid", "expired")):
                    invalid("cursor_invalid")
            if response_error is not None:
                raise response_error
            return data
        ext.api._call = checked_call
    if is_x:
        if cursor is not None and (not isinstance(cursor, str) or not cursor or len(cursor) > 8192):
            raise AdapterError("cursor_invalid")
        config.set(("extractor", "twitter"), "cursor", cursor or True)
        config.set(("extractor", "twitter"), "showreplies", False)
        ext = twitter.TwitterWithRepliesExtractor.from_url("https://x.com/id:" + source_id + "/with_replies")
    elif source["platform"] == "pixiv":
        ext = pixiv.PixivArtworksExtractor.from_url("https://www.pixiv.net/users/" + source_id + "/artworks")
    else:
        raise AdapterError("source_unresolved")
    ext.initialize()
    pager = None
    if is_x:
        install_x_checks(ext)
    if is_x:
        def completed(next_cursor):
            # 1.32.11 reports None on an empty page before examining its
            # nonempty bottom cursor. Keep the validated response cursor only
            # here, after the full native page has been consumed.
            next_cursor = next_cursor or response_cursor
            if result.get("empty_cursor_repeat"):
                result["next"] = None
                result["terminal"] = True
                result["diagnostic"] = {"guard": "x_empty_cursor_repeat", "same_cursor": "true",
                    "request_cursor_length": str(len(cursor)), "response_cursor_length": str(len(response_cursor))}
                raise PageDone()
            if next_cursor is not None and next_cursor == cursor:
                raise AdapterError("cursor_invalid")
            result["next"] = next_cursor
            result["terminal"] = next_cursor is None
            raise PageDone()
        ext._update_cursor = completed
        original = ext.tweets
        slot = "tweets"
    else:
        native_extract_ajax = ext._extract_ajax
        def typed_extract_ajax(work, body):
            artwork_type = body.get("illustType") if isinstance(body, dict) else None
            if (type(artwork_type) is not int or artwork_type not in (0, 1, 2)
                    or str(body.get("id")) != str(work.get("id"))
                    or type(body.get("pageCount")) is not int or not 1 <= body["pageCount"] <= 1000):
                raise ValueError("native AJAX did not resolve artwork identity/type")
            pager.date(body.get("createDate"))
            pager.identifier(body.get("userId"))
            if pager.phase == "app" and not pager.same_publication_time(work.get("create_date"), body["createDate"]):
                raise AdapterError("discovery_incomplete")
            files = native_extract_ajax(work, body)
            work["type"] = ("illust", "manga", "ugoira")[artwork_type]
            return () if artwork_type == 2 else files
        ext._extract_ajax = typed_extract_ajax
        wait = ext.wait
        def rate_limit_wait(*args, **kwargs):
            if kwargs.get("seconds") == 300:
                raise AdapterError("rate_limited")
            return wait(*args, **kwargs)
        ext.wait = rate_limit_wait
        pager = PixivPager(ext, source, cursor, result, pixiv_cursor, AdapterError, PageDone, remember)
        original = pager.works
        slot = "works"
    # Preserve native enumeration, login, media and metadata transformation.
    # Isolate conversion per post so malformed metadata does not close the
    # native page generator and discard later post IDs.
    iterator = None
    byte_count = 0
    seen_ids = set()
    try:
        iterator = original()
        for raw in iterator:
            if is_x:
                legacy = raw.get("legacy", raw)
                post_id = str(legacy.get("id_str", raw.get("rest_id", "")))
                owner = str(legacy.get("user_id_str", ""))
                user = ext._user_obj
                if user and str(user.get("rest_id")) != source_id:
                    raise AdapterError("source_identity_conflict")
            else:
                post_id = str(raw.get("id", ""))
                owner = str(raw.get("user", {}).get("id", ""))
            if not post_id.isdecimal() or (is_x and not owner.isdecimal()):
                raise AdapterError("discovery_incomplete")
            if is_x and not native_checked:
                observe_x(legacy, owner, ordinary=True)
            if is_x and owner != source_id:
                continue
            # _extend_sanity inserts source-profile IDs with a synthetic user
            # and limit URL. Native items() resolves their author through AJAX.
            initial_user = raw.get("user") if not is_x else None
            sanity_placeholder = bool(not is_x and owner == "1"
                and raw.get("type") == raw.get("id")
                and raw.get("meta_single_page", {}).get("original_image_url") == ext.limit_url)
            # Native quote expansion mutates the same legacy dict that can
            # also appear as an ordinary owned timeline post. Restore only
            # synthetic quote markers on that exact previously verified object;
            # genuine quote-context and retweet exclusions remain unchanged.
            if (is_x and original_unquoted_legacy.get(post_id) is legacy
                    and "quoted_by_id_str" in legacy):
                legacy = dict(legacy)
                legacy.pop("quoted_by", None)
                legacy.pop("quoted_by_id_str", None)
                raw = dict(raw, legacy=legacy)
            # Mirror gallery-dl 1.32.11's native exclusions before conversion
            # and coverage accounting. quoted_by marks expanded context;
            # quoted_status marks a quote referenced by an eligible post.
            if is_x and not eligible_x(legacy):
                continue
            remember(post_id, source_id if sanity_placeholder else owner)
            if post_id in seen_ids:
                continue
            seen_ids.add(post_id)
            if len(seen_ids)>1000:
                raise AdapterError("limit_reached")
            setattr(ext, slot, lambda: iter((raw,)))
            try:
                records = []
                for kind, url, metadata in ext.items():
                    if kind == 2:
                        records.append([2, {k: v for k,v in metadata.items() if not k.startswith("_")}])
                    elif kind == 3:
                        records.append([3, url, {k: v for k,v in metadata.items() if not k.startswith("_")}])
                    else:
                        raise ValueError("unexpected native message")
                if not is_x:
                    pager.validate_resolved(raw)
                    user = raw.get("user")
                    owner = str(user.get("id", "")) if isinstance(user, dict) else ""
                    if (not owner.isdecimal() or owner == "0"
                            or (sanity_placeholder and user is initial_user)):
                        raise ValueError("native conversion did not resolve source author")
                    if owner != source_id:
                        handled_ids.add(post_id)
                        continue
                    # Native AJAX can resolve a minute-truncated list timestamp
                    # outside this fixed window. Do not emit it or mark it seen
                    # in the successful baseline for the next incremental run.
                    if pager.defer_if_future(post_id, raw["create_date"]) or not pager.in_window(raw["create_date"]):
                        handled_ids.add(post_id)
                        continue
                    remember(post_id, owner)
                    target_count += 1
                    try:
                        date = datetime.datetime.fromisoformat(raw["create_date"])
                        if cutoff is None or date >= cutoff:
                            all_old = False
                    except (KeyError, ValueError, TypeError):
                        all_old = False
                if is_x and not records and legacy.get("extended_entities", {}).get("media"):
                    raise ValueError("native media conversion returned no records")
                if is_x:
                    expected_photos = sum(media.get("type") == "photo" for media in legacy.get("extended_entities", {}).get("media", []))
                    converted_photos = sum(record[0] == 3 and record[-1].get("type") == "photo" for record in records)
                    if expected_photos != converted_photos:
                        raise ValueError("native conversion omitted source photos")
                # Native text-only X posts have no media and no records.
                if not is_x:
                    for record in records:
                        metadata = record[-1]
                        metadata["description"] = plain_caption(metadata.get("caption"))
                        # The bridge exposes plain source fields, never caption HTML.
                        metadata.pop("caption", None)
                encoded = json.dumps(records, default=str)
                byte_count += len(encoded.encode("utf-8"))
                if byte_count > 12 * 1024 * 1024 or len(result["records"]) + len(records) > 10000:
                    raise AdapterError("limit_reached")
                result["records"].extend(records)
                handled_ids.add(post_id)
            except AdapterError:
                raise
            except Exception as exc:
                result["diagnostic"] = safe_diagnostic(with_http_diagnostic(exc), "conversion")
                if safe_error(exc) == "rate_limited":
                    raise AdapterError("rate_limited") from None
                result["failed_ids"].append(post_id)
            finally:
                setattr(ext, slot, original)
        if result["failed_ids"] and pager is not None:
            raise AdapterError("discovery_incomplete")
        if pager is None:
            result["terminal"] = True
        else:
            pager.finish()
    except PageDone:
        pass
    except AdapterError as exc:
        raise incomplete(exc) from None
    except Exception as exc:
        result["diagnostic"] = safe_diagnostic(with_http_diagnostic(exc), "enumeration")
        raise incomplete(AdapterError(safe_error(exc, cursor is not None)), preserve_diagnostic=True) from None
    finally:
        active_error = sys.exc_info()[1]
        try:
            if iterator is not None:
                iterator.close()
        except Exception as exc:
            # Preserve the source-bound page error already being raised; a
            # generator's cleanup must not discard its durable recovery IDs.
            if active_error is None:
                result["diagnostic"] = safe_diagnostic(with_http_diagnostic(exc), "cleanup")
                raise incomplete(AdapterError(safe_error(exc, cursor is not None)), preserve_diagnostic=True) from None
    if is_x and ext._user_obj and str(ext._user_obj.get("rest_id")) != source_id:
        raise incomplete(AdapterError("source_identity_conflict"))
    if is_x:
        # A native paginator can silently skip a fully identified post (for
        # example a broken retweet expansion). Keep that owned ID recoverable.
        for post_id in observed_ids:
            if post_id not in handled_ids and post_id not in result["failed_ids"]:
                result["failed_ids"].append(post_id)
    result["boundary"] = bool(is_x and target_count and all_old and not result["failed_ids"] and not result["order_anomaly"])
    result["neutral"] = bool(is_x and not target_count and all_old
                             and not result["failed_ids"] and not result["order_anomaly"])
    result["page_complete"] = True
    return result


def stringify_ids(value):
    """Preserve platform identifiers across the JSON -> JavaScript boundary."""
    if isinstance(value, dict):
        return {key: str(item) if isinstance(item, int) and (key == "id" or key.endswith("_id")) else stringify_ids(item)
                for key, item in value.items()}
    if isinstance(value, list):
        return [stringify_ids(item) for item in value]
    return value


def main():
    diagnostic_secrets.clear()
    diagnostic_handler.messages.clear()
    logging.getLogger().addHandler(diagnostic_handler)
    logging.getLogger().setLevel(logging.WARNING)
    try:
        with open(sys.argv[1], encoding="utf-8") as file:
            request = json.load(file)
        config.load((request["config"],), strict=True)
        configure_diagnostics()
        config.set(("cache",), "file", request["cache"])
        config.set(("extractor",), "retries", 1)
        config.set(("extractor",), "timeout", 20)
        config.set(("extractor",), "sleep-request", 0)
        result = collect(request["source"], request.get("cursor"))
    except AdapterError as exc:
        result = exc.result if exc.result is not None else {"error": str(exc), "diagnostic": safe_diagnostic(exc, "startup_validation")}
    except Exception as exc:
        result = {"error": safe_error(exc), "diagnostic": safe_diagnostic(exc, "startup")}
    sys.stdout.write(json.dumps(stringify_ids(result), default=str, ensure_ascii=True))


if __name__ == "__main__":
    main()
