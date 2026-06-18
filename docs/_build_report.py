# encoding: utf-8
"""Build the complete nexus research report v5.0"""
import os

OUTPUT = r"D:\chat-A\docs\nexus-research-report.md"

# Header + TOC
HEADER = """# Nexus 完整研究报告

> **版本**: v5.0
> **项目**: `D:\\chat-A\\reference\\Nexus-full\\` (1265文件, v0.3.4-beta.4)
> **方法**: 逐文件阅读源码 + 结构分析 + 代码注释
> **覆盖**: 16 章

"""

TOC = """## 目录

1. [情绪引擎](#1-情绪引擎)
2. [记忆管线](#2-记忆管线)
3. [流式语音架构](#3-流式语音架构)
4. [插话打断机制](#4-插话打断机制)
5. [STT 语音识别引擎深度](#5-stt-语音识别引擎深度)
6. [人格护栏系统](#6-人格护栏系统)
7. [Voice 完整架构](#7-voice-完整架构)
8. [TTS Pipeline 帧驱动详解](#8-tts-pipeline-帧驱动详解)
9. [StreamAudioPlayer 音频引擎](#9-streamaudioplayer-音频引擎)
10. [Voice Hooks 编排层](#10-voice-hooks-编排层)
11. [Provider 管理与 Fallback](#11-provider-管理与-fallback)
12. [自主行为引擎](#12-自主行为引擎)
13. [叙事产物系统](#13-叙事产物系统)
14. [参考代码索引](#14-参考代码索引)
15. [Agent 工具调用系统](#15-agent-工具调用系统)
16. [Agent 自主循环系统](#16-agent-自主循环系统)

---
"""

with open(OUTPUT, "w", encoding="gbk") as f:
    f.write(HEADER)
    f.write(TOC)

print(f"Header+TOC written to {OUTPUT}")
os.system(f"dir {OUTPUT}")
