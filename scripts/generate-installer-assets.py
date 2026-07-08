#!/usr/bin/env python3
"""Generates NSIS installer branding images (header + sidebar banners) that
match the app's own dark-purple theme (see src/App.css's --sidebar-bg/
--titlebar-bg gradients) instead of shipping Tauri/NSIS's stock default.
Run once (or whenever src-tauri/icons/icon.png changes) and commit the
output — these are small, stable brand assets, not build artifacts.

NSIS requires plain 24-bit BMP (no alpha channel) at exact pixel dimensions:
  header.bmp  150x57  (shown atop every installer page except welcome/finish)
  sidebar.bmp 164x314 (shown on the welcome/finish pages)
"""
from PIL import Image
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON_PATH = os.path.join(ROOT, "src-tauri", "icons", "icon.png")
OUT_DIR = os.path.join(ROOT, "src-tauri", "installer")


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def vertical_gradient(size, stops):
    """stops: list of (position 0..1, RGB) matching a CSS linear-gradient(180deg, ...)."""
    w, h = size
    img = Image.new("RGB", size)
    px = img.load()
    for y in range(h):
        t = y / max(h - 1, 1)
        seg = next(i for i in range(len(stops) - 1) if stops[i + 1][0] >= t)
        (t0, c0), (t1, c1) = stops[seg], stops[seg + 1]
        local_t = 0 if t1 == t0 else (t - t0) / (t1 - t0)
        color = lerp(c0, c1, local_t)
        for x in range(w):
            px[x, y] = color
    return img


def horizontal_gradient(size, stops):
    w, h = size
    img = Image.new("RGB", size)
    px = img.load()
    for x in range(w):
        t = x / max(w - 1, 1)
        seg = next(i for i in range(len(stops) - 1) if stops[i + 1][0] >= t)
        (t0, c0), (t1, c1) = stops[seg], stops[seg + 1]
        local_t = 0 if t1 == t0 else (t - t0) / (t1 - t0)
        color = lerp(c0, c1, local_t)
        for y in range(h):
            px[x, y] = color
    return img


def paste_icon(base, icon, target_size, position):
    resized = icon.resize(target_size, Image.LANCZOS)
    base.paste(resized, position, resized)  # icon's own alpha as mask, flattened onto base
    return base


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    icon = Image.open(ICON_PATH).convert("RGBA")

    # --sidebar-bg: linear-gradient(180deg, #43104a 0%, #1c1a29 55%, #370d3a 100%)
    sidebar = vertical_gradient(
        (164, 314),
        [(0.0, (0x43, 0x10, 0x4A)), (0.55, (0x1C, 0x1A, 0x29)), (1.0, (0x37, 0x0D, 0x3A))],
    )
    icon_w = 96
    paste_icon(sidebar, icon, (icon_w, icon_w), ((164 - icon_w) // 2, 40))
    sidebar.convert("RGB").save(os.path.join(OUT_DIR, "sidebar.bmp"), "BMP")

    # --titlebar-bg: linear-gradient(90deg, #33093a 0%, #43104a 40%, #370d3a 100%)
    header = horizontal_gradient(
        (150, 57),
        [(0.0, (0x33, 0x09, 0x3A)), (0.4, (0x43, 0x10, 0x4A)), (1.0, (0x37, 0x0D, 0x3A))],
    )
    icon_h = 40
    paste_icon(header, icon, (icon_h, icon_h), (10, (57 - icon_h) // 2))
    header.convert("RGB").save(os.path.join(OUT_DIR, "header.bmp"), "BMP")

    print(f"Wrote {OUT_DIR}\\sidebar.bmp (164x314) and {OUT_DIR}\\header.bmp (150x57)")


if __name__ == "__main__":
    main()
