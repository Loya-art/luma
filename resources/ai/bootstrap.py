"""Download the pinned Windows CPU wheel before uv resolves its small dependencies.

Wheel SHA-256 is published by the official CPU index:
https://download.pytorch.org/whl/cpu/torch/
"""
import json
from importlib.metadata import PackageNotFoundError, version as installed_version
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import re
import sys
from urllib.parse import urlparse
from urllib.request import urlopen
from download import download

sys.stdout.reconfigure(encoding="utf-8")
root = Path(sys.argv[1]).resolve()


def emit(message):
    print(json.dumps({"progress": message}, ensure_ascii=False), flush=True)


def compatible(name):
    if name.endswith(("-py3-none-any.whl", "-cp311-cp311-win_amd64.whl")):
        return True
    stable = re.search(r"-cp(\d+)-abi3-win_amd64\.whl$", name)
    return bool(stable and 35 <= int(stable[1]) <= 311)


if len(sys.argv) > 2 and sys.argv[2] == "deps":
    # Official version metadata supplies immutable wheel URLs and SHA-256 hashes:
    # https://docs.pypi.org/api/json/#get-a-release
    wheels = []
    root.mkdir(parents=True, exist_ok=True)
    for line in Path(__file__).with_name("requirements.txt").read_text().splitlines():
        match = re.fullmatch(r"([A-Za-z0-9_-]+)==([A-Za-z0-9_.+]+)", line.strip())
        if not match:
            continue
        package, version = match.groups()
        try:
            if installed_version(package) == version:
                emit("识别组件已安装 · " + package)
                continue
        except PackageNotFoundError:
            pass
        metadata_path = root / f"pypi-{package}-{version}.json"
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            metadata = None
        if metadata is None:
            emit("解析已固定的识别组件 · " + package)
            with urlopen(f"https://pypi.org/pypi/{package}/{version}/json", timeout=90) as response:
                metadata = json.load(response)
            metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
        if metadata.get("info", {}).get("version") != version:
            raise ValueError("识别组件版本信息不匹配: " + package)
        candidates = [item for item in metadata["urls"] if item.get("packagetype") == "bdist_wheel" and compatible(item["filename"])]
        if not candidates:
            raise ValueError("没有找到适用于当前 Windows 的识别组件: " + package)
        wheel = candidates[0]
        parsed = urlparse(wheel["url"])
        if parsed.scheme != "https" or parsed.hostname != "files.pythonhosted.org" or Path(wheel["filename"]).name != wheel["filename"] or not re.fullmatch(r"[0-9a-f]{64}", wheel["digests"]["sha256"]):
            raise ValueError("识别组件下载地址无效")
        wheels.append(wheel)
    with ThreadPoolExecutor(max_workers=3) as pool:
        tasks = [pool.submit(download, wheel["url"], root / wheel["filename"], wheel["digests"]["sha256"], lambda message: emit("下载识别组件 · " + message)) for wheel in wheels]
        for task in as_completed(tasks):
            task.result()
else:
    name = "torch-2.6.0+cpu-cp311-cp311-win_amd64.whl"
    download(
        "https://download-r2.pytorch.org/whl/cpu/torch-2.6.0%2Bcpu-cp311-cp311-win_amd64.whl",
        root / name,
        "24c9d3d13b9ea769dd7bd5c11cfa1fc463fd7391397156565484565ca685d908",
        lambda message: emit("下载 CPU 识别组件 · " + message),
    )
