import hashlib
import importlib.util
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import socket
import tempfile
import threading
import unittest

spec = importlib.util.spec_from_file_location("model_download", Path(__file__).resolve().parent.parent / "resources/ai/download.py")
download = importlib.util.module_from_spec(spec)
spec.loader.exec_module(download)
DATA = bytes(range(256)) * (132 * 1024)
HASH = hashlib.sha256(DATA).hexdigest()


class Handler(BaseHTTPRequestHandler):
    counts = {}

    def log_message(self, *_):
        pass

    def do_GET(self):
        data = DATA[:4096] if self.path == "/small" else DATA
        key = (self.path, self.headers.get("Range"))
        Handler.counts[key] = Handler.counts.get(key, 0) + 1
        match = re.fullmatch(r"bytes=(\d+)-(\d*)", self.headers.get("Range", ""))
        start, end = (int(match[1]), int(match[2] or len(data) - 1)) if match else (0, len(data) - 1)
        if start >= len(data):
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{len(data)}")
            self.end_headers()
            return
        ranged = bool(match and self.path != "/ignore")
        if not ranged:
            start, end = 0, len(data) - 1
        self.send_response(206 if ranged else 200)
        self.send_header("Content-Length", str(end - start + 1))
        if ranged:
            self.send_header("Content-Range", f"bytes {start + (1 if self.path == '/wrong' and end else 0)}-{end}/{len(data)}")
        self.send_header("ETag", '"test-file-v1"')
        self.end_headers()
        body = data[start:end + 1]
        if self.path == "/interrupted" and end > start and Handler.counts[key] == 1 and start == 0:
            self.wfile.write(body[:len(body) // 2])
            self.wfile.flush()
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
        else:
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass


class Downloads(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def exercise(self, endpoint):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "model.bin"
            digest = download.download(f"http://127.0.0.1:{self.server.server_port}/{endpoint}", target, HASH)
            self.assertEqual(digest, HASH)
            self.assertEqual(hashlib.sha256(target.read_bytes()).hexdigest(), HASH)
            self.assertFalse(target.with_suffix(".bin.parts").exists())

    def test_parallel_range_download(self):
        self.exercise("range")

    def test_server_ignoring_range_falls_back_without_appending(self):
        self.exercise("ignore")

    def test_interruption_resumes_only_missing_bytes(self):
        self.exercise("interrupted")
        self.assertTrue(any(path == "/interrupted" and key and "2097152-" in key for path, key in Handler.counts))

    def test_wrong_range_never_publishes(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "model.bin"
            with self.assertRaises(ValueError):
                download.download(f"http://127.0.0.1:{self.server.server_port}/wrong", target, HASH)
            self.assertFalse(target.exists())

    def test_wrong_hash_never_publishes(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "model.bin"
            with self.assertRaises(ValueError):
                download.download(f"http://127.0.0.1:{self.server.server_port}/range", target, "0" * 64)
            self.assertFalse(target.exists())

    def test_completed_single_stream_part_is_validated_before_reusing(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "model.bin"
            target.with_suffix(".bin.part").write_bytes(DATA[:4096])
            expected = hashlib.sha256(DATA[:4096]).hexdigest()
            self.assertEqual(download.download(f"http://127.0.0.1:{self.server.server_port}/small", target, expected), expected)
            self.assertEqual(target.read_bytes(), DATA[:4096])


if __name__ == "__main__":
    unittest.main()
