"""
验收用的「**在自己进程里出声**的子进程」角色。

为什么需要它 —— 这是 `check-app-audio.cjs` 的 Case 3 绕不开的一环：

Windows 那边 `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE` 到底含到第几层，
实测下来的结论是「目标进程 + 它的**直接子进程**」：拿 Electron 冒充子应用不行，
因为 Electron 的音频是**渲染进程**放出来的，而渲染进程是浏览器进程的子进程 ——
对目标而言那是孙子，进不来。所以「父进程 + 子进程都被采集」这条要求，
必须用一个**自己就是音频生产者、且是目标的直接子进程**来验。

`winsound.PlaySound` 走的正是这条路：调用进程自己持有 waveOut 流，
于是进程树里它就是那一层。

用法（由 scripts/_probe-audio-app.cjs spawn，不单独跑）：
    <python> scripts/_probe-audio-tone.py <频率Hz> <WAV 落盘路径>

⚠️ 它只做两件事：生成一段 1 秒的无缝单频 WAV，然后循环播放到被杀掉。
生成物写在调用方给的路径里（本项目的约定：临时产物不放 C 盘）。
"""

import math
import os
import struct
import sys
import time
import wave

import winsound

freq = int(sys.argv[1])
wav_path = sys.argv[2]

RATE = 48000
AMP = 0.25 * 32767

# 一整秒里塞**整数个周期**，循环接缝才是连续的 —— 接缝上的咔哒声是宽带噪声，
# 而这一整套判据全靠「某个频率有没有能量」，一记咔哒足以把读数糊掉。
# 频率取整数值，于是 cycles 直接等于 freq，恰好够。
cycles = freq
os.makedirs(os.path.dirname(wav_path), exist_ok=True)
with wave.open(wav_path, 'wb') as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(RATE)
    frames = bytearray()
    for i in range(RATE):
        frames += struct.pack('<h', int(AMP * math.sin(2.0 * math.pi * cycles * i / RATE)))
    w.writeframes(bytes(frames))

winsound.PlaySound(
    wav_path,
    winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_LOOP | winsound.SND_NODEFAULT,
)

# 打 pid：验收脚本要靠它确认「进程树里那个直接子进程」就是它
print(f'[tone] pid={os.getpid()} freq={freq} wav={wav_path}', flush=True)

while True:
    time.sleep(1)
