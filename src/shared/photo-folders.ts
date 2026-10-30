export type PhotoFolderKind = 'photo' | 'screenshot' | 'ai-output' | 'utility';
export interface PhotoFolderClassification { kind: PhotoFolderKind; reason?: string }

const chatDirectories = new Set(['wechat', 'wechat files', 'wechatfiles', 'weixin', 'xwechat_files', 'tencent files', 'qq', 'qqfile_recv', 'qq_images', 'qqpic', 'mobileqq', 'com.tencent.mm', 'com.tencent.mobileqq', '聊天记录', '聊天图片', '聊天缓存']);
const cacheDirectories = new Set(['cache', 'caches', '.cache', 'imagecache', 'image_cache', 'cache_images', 'thumbnail', 'thumbnails', 'thumbs', '.thumbnails', 'gpu_cache', 'gpucache', 'code cache', 'mediacache', '.shiguang-staging']);
const dependencyDirectories = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv', 'python_embeded', '.obsidian', '.next', '.nuxt', '.codex', '.agents', '.claude', 'site-packages', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'test-results', 'playwright-report']);
const assetDirectories = new Set(['asset', 'assets', 'texture', 'textures', 'material', 'materials', 'sprite', 'sprites', 'icon', 'icons', 'shader', 'shaders', 'mesh', 'meshes', 'resources', 'resource', 'streamingassets', 'uitextures', 'ui', '贴图', '材质', '游戏贴图', '界面素材', '软件素材', '图标']);
const installedApplicationDirectories = new Set(['windows', 'program files', 'program files (x86)', 'programdata', 'appdata', 'steamapps']);
const comfyInternalDirectories = new Set(['custom_nodes', 'web', 'temp', 'input', 'models', 'comfy', 'comfy_api', 'comfy_api_nodes', 'comfy_extras', 'tests', 'tests-unit', 'script_examples', 'python_embeded', 'update', 'docs']);
const screenshotDirectory = /^(?:screenshots?|screen[ _-]?captures?|截[屏图]|游戏截图|屏幕截图)$/i;
const comfyDirectory = /^(?:comfyui|comfyui[_-](?:windows[_-])?portable)$/i;

/** Folder-role hints, not a judgement based on image dimensions or filenames.
 * Explicit creative outputs and captures take priority over generic asset names;
 * dependency, chat-storage and cache trees remain excluded even if nested inside them.
 * Also accepts the phone:<device>:/storage/... aliases used by the album home. */
export function classifyPhotoFolder(directory: string): PhotoFolderClassification {
  const parts = directory.replace(/\\/g, '/').split('/').filter(Boolean).map(part => part.toLowerCase());
  if (parts.some(part => chatDirectories.has(part) || /^(?:wxid_|nt_qq_)[^/]+$/.test(part))) return { kind: 'utility', reason: '聊天软件的图片或聊天存储目录' };
  if (parts.some(part => cacheDirectories.has(part))) return { kind: 'utility', reason: '缓存或缩略图目录' };
  if (parts.some(part => dependencyDirectories.has(part))) return { kind: 'utility', reason: '软件依赖或内部配置目录' };
  let comfyIndex = -1;
  for (let index = parts.length - 1; index >= 0; index--) if (comfyDirectory.test(parts[index])) { comfyIndex = index; break; }
  if (comfyIndex >= 0) {
    const child = parts[comfyIndex + 1];
    if (child === 'output') return { kind: 'ai-output' };
    if (child && comfyInternalDirectories.has(child)) return { kind: 'utility', reason: 'ComfyUI 内部素材或工作目录，默认保留 output 输出' };
  }
  if (parts.some(part => screenshotDirectory.test(part))) return { kind: 'screenshot' };
  if (parts.some(part => installedApplicationDirectories.has(part))) return { kind: 'utility', reason: '系统或已安装应用程序目录' };
  if (parts.some(part => assetDirectories.has(part))) return { kind: 'utility', reason: '游戏贴图或软件界面素材目录' };
  return { kind: 'photo' };
}

/** A recommendation is deliberately narrower than a file-format match. Other
 * candidate directories stay available for explicit selection in the scanner. */
export function recommendPhotoFolder(directory: string): { recommended: boolean; recommendation: string } {
  const role = classifyPhotoFolder(directory);
  if (role.kind === 'screenshot') return { recommended: true, recommendation: '游戏或屏幕截图目录' };
  if (role.kind === 'ai-output') return { recommended: true, recommendation: 'ComfyUI 创作输出' };
  if (role.kind === 'utility') return { recommended: false, recommendation: role.reason! };
  const parts = directory.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.some(part => /^(?:dcim|camera)$/i.test(part))) return { recommended: true, recommendation: '相机照片目录' };
  if (parts.some(part => /^(?:src|public|static|dist|build|docs?|examples?|tests?|lib|libs|site-packages|vendor|packages|plugins?|extensions?|\.vscode)$/i.test(part))) return { recommended: false, recommendation: '可能是项目素材，请预览后选择' };
  if (parts.some(part => /^(?:photos?|pictures?|albums?|dcim|camera|screenshots?|wallpapers?)$/i.test(part) || /照片|相册|相簿|摄影|旅行|旅游|图集|壁纸|创作|绘画/.test(part))) return { recommended: true, recommendation: '照片或个人创作目录' };
  return { recommended: false, recommendation: '用途待确认，请预览后选择' };
}
