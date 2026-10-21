"""Fetch one narrowly scoped signed repair object; never run PDF tools here."""
from __future__ import annotations

import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import ssl
import sys
import time
from urllib.parse import urlsplit

MAX_REFERENCE = 16 * 1024
MAX_REQUEST = 12 * 1024 * 1024
FETCH_DEADLINE = 15
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
PATH = re.compile(r"/storage/v1/object/sign/documents/" + UUID + "/" + UUID + "/" + UUID +
                  "/native-pdf-request-" + UUID + r"\.json\Z")
TOKEN = re.compile(r"token=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\Z")
EXIT_CODES = {"native_pdf_invalid_plan": 2, "native_pdf_worker_failed": 3,
              "native_pdf_timeout": 4, "pdf_complexity_limit": 5}


class TransportError(Exception):
    def __init__(self, code="native_pdf_invalid_plan"):
        self.code = code if code in EXIT_CODES else "native_pdf_worker_failed"
        super().__init__(self.code)


def origin_hostname(origin):
    if not isinstance(origin, str) or not re.fullmatch(r"https://[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", origin):
        raise TransportError("native_pdf_worker_failed")
    parts = urlsplit(origin)
    if parts.hostname != parts.netloc or "." not in parts.netloc or ".." in parts.netloc:
        raise TransportError("native_pdf_worker_failed")
    return parts.hostname


def unique_pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise TransportError()
        value[key] = item
    return value


def validate_reference(body, origin):
    hostname = origin_hostname(origin)
    if not isinstance(body, bytes) or not 0 < len(body) <= MAX_REFERENCE:
        raise TransportError()
    try:
        value = json.loads(body, object_pairs_hook=unique_pairs)
    except (ValueError, UnicodeError):
        raise TransportError() from None
    if (not isinstance(value, dict) or set(value) != {"requestUrl", "requestSha256", "requestBytes"}
            or type(value["requestBytes"]) is not int or not 1 <= value["requestBytes"] <= MAX_REQUEST
            or not isinstance(value["requestSha256"], str)
            or not re.fullmatch(r"[0-9a-f]{64}", value["requestSha256"])):
        raise TransportError()
    url = value["requestUrl"]
    if (not isinstance(url, str) or not url.isascii() or len(url) > MAX_REFERENCE
            or any(char.isspace() or ord(char) < 32 for char in url)
            or any(char in url for char in ("%", "\\", "#"))):
        raise TransportError()
    try:
        parts = urlsplit(url)
    except ValueError:
        raise TransportError() from None
    if (parts.scheme != "https" or parts.netloc != hostname or parts.username or parts.password
            or parts.port is not None or parts.fragment or not PATH.fullmatch(parts.path)
            or not TOKEN.fullmatch(parts.query)):
        raise TransportError()
    return value, hostname, parts.path + "?" + parts.query


def fetch_request(body, origin):
    value, hostname, target = validate_reference(body, origin)
    deadline = time.monotonic() + FETCH_DEADLINE
    # HTTPConnection does not consult proxy variables or follow redirects.
    # The child has no inherited SSL_CERT_FILE or application credentials.
    connection = http.client.HTTPSConnection(hostname, timeout=FETCH_DEADLINE,
                                              context=ssl.create_default_context())
    try:
        connection.request("GET", target, headers={"Accept": "application/json", "Accept-Encoding": "identity"})
        response = connection.getresponse()
        if response.status != 200:
            raise TransportError("native_pdf_worker_failed")
        if response.getheader("Content-Encoding", "identity").lower() != "identity":
            raise TransportError("native_pdf_worker_failed")
        lengths = response.headers.get_all("Content-Length", [])
        if lengths and (len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit()
                        or len(lengths[0]) > 10 or int(lengths[0]) != value["requestBytes"]):
            raise TransportError("pdf_complexity_limit")
        data, digest = bytearray(), hashlib.sha256()
        while True:
            if time.monotonic() >= deadline:
                raise TransportError("native_pdf_timeout")
            # The supervisor also kills this process group at the absolute
            # deadline, covering stalled DNS, headers and partial body reads.
            block = response.read(min(65536, MAX_REQUEST + 1 - len(data)))
            if not block:
                break
            data.extend(block)
            if len(data) > MAX_REQUEST or len(data) > value["requestBytes"]:
                raise TransportError("pdf_complexity_limit")
            digest.update(block)
        if len(data) != value["requestBytes"] or digest.hexdigest() != value["requestSha256"]:
            raise TransportError()
        return bytes(data)
    except TimeoutError:
        raise TransportError("native_pdf_timeout") from None
    except TransportError:
        raise
    except Exception:
        raise TransportError("native_pdf_worker_failed") from None
    finally:
        connection.close()


def main():
    if len(sys.argv) != 4:
        raise TransportError()
    request, result, origin = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
    if os.name == "posix":
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 ** 2, 256 * 1024 ** 2))
        resource.setrlimit(resource.RLIMIT_CPU, (10, 12))
        resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_REQUEST, MAX_REQUEST))
        resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    if request.stat().st_size > MAX_REFERENCE:
        raise TransportError()
    with result.open("xb") as output:
        output.write(fetch_request(request.read_bytes(), origin))


if __name__ == "__main__":
    try:
        main()
    except BaseException as error:
        # Never print a URL, token, response body or networking exception.
        sys.exit(EXIT_CODES.get(error.code, 3) if isinstance(error, TransportError) else 3)
