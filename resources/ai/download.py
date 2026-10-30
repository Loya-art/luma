"""Bounded, resumable downloads with full-file integrity checks.

HTTP range semantics: https://www.rfc-editor.org/rfc/rfc9110.html#name-range
Only explicitly requested model/bootstrap setup calls this module.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import re
import time
from threading import BoundedSemaphore
from urllib.error import HTTPError
from urllib.request import Request, urlopen

CHUNK_SIZE = 4 * 1024 * 1024
MAX_CONNECTIONS = 8
CONNECTIONS = BoundedSemaphore(MAX_CONNECTIONS)


@contextmanager
def connection(request, timeout):
    # Several model/wheel downloads may run together; cap the process-wide total.
    with CONNECTIONS:
        with urlopen(request, timeout=timeout) as response:
            yield response


def digest(file):
    value = hashlib.sha256()
    with open(file, "rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def download(url, target, expected, progress=lambda message: None):
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_file() and (not expected or digest(target) == expected):
        return digest(target)
    # Validate the actual GET response: some servers advertise ranges but ignore them.
    with connection(Request(url, headers={"Range": "bytes=0-0", "Accept-Encoding": "identity"}), timeout=90) as response:
        match = re.fullmatch(r"bytes 0-0/(\d+)", response.headers.get("Content-Range", ""))
        size = int(match.group(1)) if response.status == 206 and match else None
        etag = response.headers.get("ETag")
        ranged = bool(size and size >= CHUNK_SIZE and expected)
        if ranged:
            if len(response.read(2)) != 1:
                raise ValueError("下载服务返回了错误的字节范围")
        else:
            # Close this probe before opening a normal GET; do not retain duplicate bodies.
            size = None
    temporary = target.with_suffix(target.suffix + ".part")
    if ranged:
        chunks = target.with_suffix(target.suffix + ".parts")
        chunks.mkdir(exist_ok=True)
        count = (size + CHUNK_SIZE - 1) // CHUNK_SIZE

        def part(index):
            start = index * CHUNK_SIZE
            end = min(size - 1, start + CHUNK_SIZE - 1)
            length = end - start + 1
            complete = chunks / f"{index:05d}.chunk"
            partial = chunks / f"{index:05d}.partial"
            if complete.is_file() and complete.stat().st_size == length:
                return complete
            for attempt in range(3):
                offset = partial.stat().st_size if partial.exists() else 0
                if offset > length:
                    partial.unlink()
                    offset = 0
                if offset == length:
                    os.replace(partial, complete)
                    return complete
                headers = {"Range": f"bytes={start + offset}-{end}", "Accept-Encoding": "identity"}
                if etag:
                    headers["If-Range"] = etag
                try:
                    with connection(Request(url, headers=headers), timeout=180) as response:
                        expected_range = f"bytes {start + offset}-{end}/{size}"
                        if response.status != 206 or response.headers.get("Content-Range") != expected_range:
                            raise ValueError("下载服务返回了错误的字节范围，请重试")
                        with open(partial, "ab" if offset else "wb") as output:
                            received = offset
                            while True:
                                block = response.read(min(256 * 1024, length - received + 1))
                                if not block:
                                    break
                                received += len(block)
                                if received > length:
                                    raise ValueError("下载数据超过预期字节范围")
                                output.write(block)
                    if partial.stat().st_size != length:
                        raise ValueError("下载连接中断，已保留完成部分")
                    os.replace(partial, complete)
                    return complete
                except Exception:
                    if attempt == 2:
                        raise
                    time.sleep(attempt + 1)

        with ThreadPoolExecutor(max_workers=MAX_CONNECTIONS) as pool:
            tasks = [pool.submit(part, index) for index in range(count)]
            done = 0
            for task in as_completed(tasks):
                done += task.result().stat().st_size
                progress(f"{target.name} · {done // 1048576} / {size // 1048576} MB")
        with open(temporary, "wb") as output:
            for index in range(count):
                with open(chunks / f"{index:05d}.chunk", "rb") as source:
                    for block in iter(lambda: source.read(1024 * 1024), b""):
                        output.write(block)
    else:
        # A single stream is also resumable; never append a server's full response to a part.
        for attempt in range(3):
            try:
                offset = temporary.stat().st_size if temporary.exists() else 0
                headers = {"Accept-Encoding": "identity"}
                if offset:
                    headers["Range"] = f"bytes={offset}-"
                with connection(Request(url, headers=headers), timeout=180) as response:
                    content_range = response.headers.get("Content-Range", "")
                    match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", content_range)
                    append = bool(offset and response.status == 206 and match and int(match.group(1)) == offset)
                    if response.status == 206 and not append:
                        raise ValueError("下载服务返回了错误的字节范围")
                    if not append:
                        offset = 0
                    total = offset + int(response.headers.get("Content-Length", "0"))
                    received = offset
                    last = 0.0
                    with open(temporary, "ab" if append else "wb") as output:
                        for block in iter(lambda: response.read(256 * 1024), b""):
                            output.write(block)
                            received += len(block)
                            if time.monotonic() - last > 1:
                                progress(f"{target.name} · {received // 1048576} / {total // 1048576} MB")
                                last = time.monotonic()
                    if total and received != total:
                        raise ValueError("下载连接中断，已保留完成部分")
                break
            except HTTPError as error:
                if error.code == 416 and temporary.is_file():
                    # A previous attempt may have finished its bytes just before interruption.
                    if expected and digest(temporary) == expected:
                        os.replace(temporary, target)
                        return expected
                    temporary.unlink()
                if attempt == 2:
                    raise
                time.sleep(attempt + 1)
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(attempt + 1)
    actual = digest(temporary)
    if expected and actual != expected:
        temporary.unlink(missing_ok=True)
        if ranged:
            # Cached chunks may belong to an older response; discard only our numbered parts.
            for file in chunks.glob("*.chunk"):
                file.unlink()
        raise ValueError("下载文件校验失败，请重试: " + target.name)
    os.replace(temporary, target)
    if ranged:
        for file in chunks.glob("*.chunk"):
            file.unlink()
        try:
            chunks.rmdir()
        except OSError:
            pass
    return actual
