"""Edit actual desktop capture: concise captions and original quiet ambient audio."""
from pathlib import Path
import json
import math
import subprocess
import wave
import numpy as np

project = Path(__file__).resolve().parents[1]
work = project / 'promo' / '.work'
report = json.loads((work / 'recording.json').read_text(encoding='utf-8'))
if report.get('status') != 'recorded':
    raise RuntimeError('A complete real application recording is required.')
duration = report['duration']
ffmpeg = project / 'resources' / 'binaries' / 'ffmpeg.exe'

def stamp(seconds):
    centiseconds = int(round(seconds * 100))
    return f'{centiseconds//360000}:{centiseconds//6000%60:02}:{centiseconds//100%60:02}.{centiseconds%100:02}'

header = '''[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Title,Microsoft YaHei,42,&H00FFFFFF,&H00FFFFFF,&H90000000,&H80000000,-1,0,0,0,100,100,1,0,3,12,0,7,58,58,78,1
Style: Note,Microsoft YaHei,20,&H30FFFFFF,&H30FFFFFF,&H90000000,&H80000000,0,0,0,0,100,100,0,0,1,1,1,9,36,42,40,1
Style: Brand,Microsoft YaHei,28,&H00FFFFFF,&H00FFFFFF,&H90000000,&H80000000,-1,0,0,0,100,100,1,0,1,1,1,1,52,52,34,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
'''
events = [f'Dialogue: 0,0:00:00.00,{stamp(duration)},Note,,0,0,0,,实际录屏 · 示例图库', f'Dialogue: 0,0:00:00.00,{stamp(duration)},Brand,,0,0,0,,Luma']
for scene in report['scenes']:
    title = scene['title']
    if title == 'Luma · 开源':
        title = r'Luma · 开源\N{\fs25\b0}github.com/Loya-art/luma\N{\fs22}灵感来源：Folia'
    events.append(f'Dialogue: 1,{stamp(scene["start"]+.12)},{stamp(scene["end"]-.1)},Title,,0,0,0,,{{\\fad(160,200)}}{title}')
(work / 'captions.ass').write_text(header + '\n'.join(events) + '\n', encoding='utf-8-sig')

rate = 48000
count = int(duration * rate)
t = np.arange(count, dtype=np.float64) / rate
sound = np.zeros((count, 2), dtype=np.float64)
chords = [(146.832, 174.614, 220.0), (116.541, 146.832, 174.614), (130.813, 174.614, 220.0), (130.813, 164.814, 195.998)]
for start in np.arange(0, duration, 6.0):
    local = t - start
    length = 7.0
    envelope = np.clip(local / 1.0, 0, 1) * np.clip((length - local) / 1.4, 0, 1)
    envelope[(local < 0) | (local > length)] = 0
    chord = chords[int(start // 6) % len(chords)]
    for note, hz in enumerate(chord):
        pad = np.sin(2 * math.pi * hz * local) + .18 * np.sin(2 * math.pi * hz * 2.001 * local)
        sound[:, note % 2] += .011 * pad * envelope
        sound[:, (note+1) % 2] += .007 * pad * envelope
    bell_env = np.exp(-np.maximum(local, 0) * 1.6) * (local >= 0) * np.minimum(np.maximum(local, 0) / .02, 1)
    bell = .017 * (np.sin(2 * math.pi * chord[1] * 4 * local) + .22 * np.sin(2 * math.pi * chord[1] * 8.01 * local)) * bell_env
    sound += bell[:, None]
fade = np.minimum(t / 1.5, 1) * np.minimum((duration - t) / 2.0, 1)
sound *= np.clip(fade, 0, 1)[:, None]
with wave.open(str(work / 'ambient.wav'), 'wb') as output:
    output.setnchannels(2); output.setsampwidth(2); output.setframerate(rate)
    output.writeframes((np.clip(sound, -1, 1) * 32767).astype('<i2').tobytes())

subprocess.run([str(ffmpeg), '-y', '-i', 'luma-raw.mp4', '-i', 'ambient.wav', '-vf', 'subtitles=captions.ass', '-c:v', 'libx264', '-preset', 'medium', '-threads', '6', '-crf', '19', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', '-metadata', 'title=Luma — actual desktop demonstration', '-metadata', 'comment=Actual installed application, separate public-media library. Inspiration: Folia.', '../luma-demo.mp4'], cwd=work, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
print(json.dumps({'video': str(project / 'promo' / 'luma-demo.mp4'), 'duration': duration, 'resolution': '1920x1080', 'fps': 30}))
