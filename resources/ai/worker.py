"""Local-only photo indexing. Downloads happen exclusively in the explicit setup command.

PaddleOCR models, run through RapidOCR's ONNX implementation:
https://rapidai.github.io/RapidOCRDocs/main/en/install_usage/rapidocr/usage/
ChineseCLIP feature API:
https://huggingface.co/OFA-Sys/chinese-clip-vit-base-patch16
"""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import sys

VERSION = "ppocr5-mobile-chineseclip-b16-20261028-v1"
CLIP_REVISION = "36e679e65c2a2fead755ae21162091293ad37834"
MODEL_FILES = [
    ("ocr/det.onnx", "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.4.0/onnx/PP-OCRv5/det/ch_PP-OCRv5_mobile_det.onnx", "4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae"),
    ("ocr/rec.onnx", "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.4.0/onnx/PP-OCRv5/rec/ch_PP-OCRv5_rec_mobile_infer.onnx", "5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5"),
    ("ocr/cls.onnx", "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.4.0/onnx/PP-OCRv4/cls/ch_ppocr_mobile_v2.0_cls_infer.onnx", "e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c"),
]
for name in ["config.json", "preprocessor_config.json", "vocab.txt", "pytorch_model.bin"]:
    MODEL_FILES.append(("clip/" + name, f"https://huggingface.co/OFA-Sys/chinese-clip-vit-base-patch16/resolve/{CLIP_REVISION}/{name}", "7b7b583c210c867410bc6bdb8a55fe14eec62999e0a9ea31ff222dc501f9cfbe" if name == "pytorch_model.bin" else None))

CATEGORIES = {
    "人物": ["有人、人物、人像或者合照的图片", "没有人的物品、风景或者文字图片"],
    "风景": ["自然风景、山川、海边、天空或者城市风光的照片", "人物近照、文字文档、室内物品的图片"],
    "动物": ["动物、猫、狗、鸟或者宠物的照片", "没有动物的图片"],
    "美食": ["美食、饭菜、饮料或者水果的照片", "没有食物的图片"],
    "截图": ["手机或者电脑屏幕截图，软件界面、网页或者聊天记录", "相机拍摄的真实自然风景照片"],
    "文档": ["书籍、试卷、文件、发票、文字笔记或者文档照片", "没有文字的自然风景照片"],
    "证件": ["身份证、护照、驾驶证、学生证等身份证件的照片", "风景、人物合照、食物或者动物的照片"],
}

def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n")
    sys.stdout.flush()

def digest(file):
    h = hashlib.sha256()
    with open(file, "rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()

def download_models(root):
    from download import download
    manifest = {}
    for rel, url, expected in MODEL_FILES:
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.is_file() and (not expected or digest(target) == expected):
            manifest[rel] = digest(target)
            continue
        emit({"progress": "下载本地模型 · " + rel})
        manifest[rel] = download(url, target, expected, lambda message: emit({"progress": "下载本地模型 · " + message}))
    return manifest

class Engine:
    def __init__(self, root):
        # All inference is offline, even if an upstream package tries a fallback download.
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
        import socket
        def no_network(*args, **kwargs):
            raise RuntimeError("本地识别进程禁止联网；请在设置中重新安装缺失模型")
        socket.socket.connect = no_network
        socket.create_connection = no_network
        for rel, _, _ in MODEL_FILES:
            if not (root / rel).is_file():
                raise FileNotFoundError("模型缺失: " + rel)
        with contextlib.redirect_stdout(sys.stderr):
            import torch
            from transformers import ChineseCLIPModel, ChineseCLIPProcessor
            from rapidocr import RapidOCR, OCRVersion
            torch.set_num_threads(2)
            torch.set_num_interop_threads(1)
            self.torch = torch
            self.model = ChineseCLIPModel.from_pretrained(str(root / "clip"), local_files_only=True, trust_remote_code=False, weights_only=True).eval()
            self.processor = ChineseCLIPProcessor.from_pretrained(str(root / "clip"), local_files_only=True, use_fast=False)
            # RapidOCR constructs its optional visualizer even for plain-text OCR.
            # Set its documented local font path to prevent an implicit font download.
            # https://github.com/RapidAI/RapidOCR/blob/v3.4.2/python/rapidocr/config.yaml
            font_candidates = [
                Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts/msyh.ttc",
                Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts/arial.ttf",
                Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
                Path("/System/Library/Fonts/PingFang.ttc"),
            ]
            font = next((file for file in font_candidates if file.is_file()), None)
            if font is None:
                raise FileNotFoundError("未找到系统字体，请修复系统字体后重试本地识别")
            self.ocr = RapidOCR(params={
                "Global.log_level": "error", "Global.max_side_len": 3200,
                "Global.font_path": str(font),
                "Det.ocr_version": OCRVersion.PPOCRV5,
                "Rec.ocr_version": OCRVersion.PPOCRV5,
                "Det.model_path": str(root / "ocr/det.onnx"),
                "Rec.model_path": str(root / "ocr/rec.onnx"),
                "Cls.model_path": str(root / "ocr/cls.onnx"),
                "Det.limit_side_len": 1280,
                "Det.limit_type": "max",
                "EngineConfig.onnxruntime.intra_op_num_threads": 2,
                "EngineConfig.onnxruntime.inter_op_num_threads": 1,
            })
        self.category_vectors = {name: self.texts(prompts) for name, prompts in CATEGORIES.items()}

    def texts(self, texts):
        inputs = self.processor(text=texts, padding=True, truncation=True, max_length=512, return_tensors="pt")
        with self.torch.inference_mode():
            # ChineseCLIP has no BERT pooler. Match its official forward()/encode_text:
            # project the final CLS token; transformers 4.57.6 get_text_features()
            # incorrectly tries to project the absent pooler_output instead.
            # https://github.com/huggingface/transformers/blob/v4.57.6/src/transformers/models/chinese_clip/modeling_chinese_clip.py
            hidden = self.model.text_model(**inputs).last_hidden_state
            features = self.model.text_projection(hidden[:, 0, :])
            features = features / features.norm(p=2, dim=-1, keepdim=True)
        return features

    def analyze(self, file, filename=""):
        from PIL import Image, ImageOps
        with Image.open(file) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
        with contextlib.redirect_stdout(sys.stderr):
            result = self.ocr(image)
        lines = [str(text) for text, score in zip(result.txts or [], result.scores or []) if score >= 0.5]
        text = "\n".join(lines)[:200000]
        inputs = self.processor(images=image, return_tensors="pt")
        with self.torch.inference_mode():
            vector = self.model.get_image_features(**inputs)
            vector = vector / vector.norm(p=2, dim=-1, keepdim=True)
        tags = []
        for name, category in self.category_vectors.items():
            positive, negative = (vector @ category.T)[0].tolist()
            if positive >= 0.24 and positive - negative >= 0.035:
                tags.append(name)
        if any(word in text for word in ["居民身份证", "公民身份号码", "中华人民共和国护照", "机动车驾驶证"]):
            tags.append("证件")
        if len(text) >= 100:
            tags.append("文档")
        if any(word in filename.lower() for word in ["screenshot", "screen_shot", "截屏", "截图"]):
            tags.append("截图")
        return {"text": text, "tags": sorted(set(tags)), "vector": vector[0].tolist(), "version": VERSION}

def main():
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    root = Path(sys.argv[2]).resolve()
    if sys.argv[1] == "setup":
        manifest = download_models(root)
        emit({"progress": "校验本地文字识别和内容检索模型"})
        engine = Engine(root)
        engine.texts(["人物", "风景"])
        marker = root / "ready.json"
        temporary = root / "ready.json.part"
        temporary.write_text(json.dumps({"version": VERSION, "files": manifest}, ensure_ascii=False), encoding="utf-8")
        os.replace(temporary, marker)
        emit({"ready": True, "version": VERSION})
        return
    engine = Engine(root)
    emit({"ready": True, "version": VERSION})
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if request["method"] == "text":
                value = engine.texts([request["query"]])[0].tolist()
            elif request["method"] == "analyze":
                value = engine.analyze(request["path"], request.get("fileName", ""))
            else:
                raise ValueError("未知本地模型操作")
            emit({"id": request["id"], "value": value})
        except Exception as error:
            emit({"id": request.get("id", -1), "error": str(error)[:1000]})

if __name__ == "__main__":
    main()
