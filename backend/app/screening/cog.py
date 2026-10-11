"""Minimal Cloud-Optimized GeoTIFF reader: reads only the tiles a window needs, via HTTP range requests.

Enough for the rasters EarthOS uses (HLS v2 NDVI / Fmask, ESA WorldCover): tiled, single band,
DEFLATE or LZW, optional horizontal predictor, north-up. No GDAL needed.
"""

from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass

import httpx
import numpy as np

_TYPES = {1: ("B", 1), 2: ("s", 1), 3: ("H", 2), 4: ("I", 4), 6: ("b", 1), 8: ("h", 2), 9: ("i", 4),
          11: ("f", 4), 12: ("d", 8), 16: ("Q", 8)}
_DTYPES = {(1, 8): "u1", (1, 16): "u2", (1, 32): "u4", (2, 8): "i1", (2, 16): "i2", (2, 32): "i4",
           (3, 32): "f4", (3, 64): "f8"}


class CogError(RuntimeError):
    pass


@dataclass
class Cog:
    url: str
    headers: dict
    width: int
    height: int
    tile_w: int
    tile_h: int
    offsets: list[int]
    counts: list[int]
    compression: int
    predictor: int
    dtype: np.dtype
    origin_x: float
    origin_y: float
    res_x: float
    res_y: float
    epsg: int | None
    nodata: float | None
    gdal_metadata: str = ""

    def scale_offset(self) -> tuple[float, float]:
        """Band scale/offset from GDAL metadata (1, 0 when absent)."""
        import re
        sc = re.search(r'name="(?:SCALE|scale_factor)"[^>]*>([^<]+)<', self.gdal_metadata, re.I)
        of = re.search(r'name="(?:OFFSET|add_offset)"[^>]*>([^<]+)<', self.gdal_metadata, re.I)
        return (float(sc.group(1)) if sc else 1.0), (float(of.group(1)) if of else 0.0)

    def pixel(self, x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Map coordinates (in the file's CRS) -> fractional column, row."""
        return (x - self.origin_x) / self.res_x, (self.origin_y - y) / self.res_y


async def _range(client: httpx.AsyncClient, url: str, headers: dict, start: int, length: int) -> bytes:
    r = await client.get(url, headers={**headers, "Range": f"bytes={start}-{start + length - 1}"},
                         timeout=60, follow_redirects=True)
    r.raise_for_status()
    if r.status_code == 200 and len(r.content) > length:  # server ignored Range
        return r.content[start:start + length]
    return r.content


async def open_cog(client: httpx.AsyncClient, url: str, headers: dict | None = None) -> Cog:
    headers = headers or {}
    # Protected archives (NASA LP DAAC) answer with a redirect to a short-lived signed URL: follow it once and
    # read every tile from the final URL without the credentials.
    r = await client.get(url, headers={**headers, "Range": "bytes=0-65535"}, timeout=60, follow_redirects=True)
    r.raise_for_status()
    head = r.content[:65536]
    if str(r.url) != url:
        url, headers = str(r.url), {k: v for k, v in headers.items() if k.lower() != "authorization"}
    if head[:2] == b"II":
        bo = "<"
    elif head[:2] == b"MM":
        bo = ">"
    else:
        raise CogError(f"not a TIFF: {url}")
    magic = struct.unpack(bo + "H", head[2:4])[0]
    big = magic == 43
    if big:
        ifd = struct.unpack(bo + "Q", head[8:16])[0]
    else:
        ifd = struct.unpack(bo + "I", head[4:8])[0]

    async def need(off: int, size: int) -> bytes:
        nonlocal head
        if off + size <= len(head):
            return head[off:off + size]
        return await _range(client, url, headers, off, size)

    if big:
        n = struct.unpack(bo + "Q", await need(ifd, 8))[0]
        entry, base, ptr = 20, ifd + 8, "Q"
    else:
        n = struct.unpack(bo + "H", await need(ifd, 2))[0]
        entry, base, ptr = 12, ifd + 2, "I"
    raw = await need(base, n * entry)
    tags: dict[int, tuple] = {}
    for i in range(n):
        e = raw[i * entry:(i + 1) * entry]
        if big:
            tag, typ, cnt = struct.unpack(bo + "HHQ", e[:12])
            val = e[12:20]
        else:
            tag, typ, cnt = struct.unpack(bo + "HHI", e[:8])
            val = e[8:12]
        if typ not in _TYPES:
            continue
        fmt, size = _TYPES[typ]
        total = cnt * size
        data = val[:total] if total <= len(val) else await need(struct.unpack(bo + ptr, val)[0], total)
        if typ == 2:
            tags[tag] = (data.rstrip(b"\0").decode("latin1"),)
        else:
            tags[tag] = struct.unpack(f"{bo}{cnt}{fmt}", data)

    def one(t: int, default=None):
        return tags[t][0] if t in tags else default

    if 322 in tags:
        tile_w, tile_h, offsets, counts = one(322), one(323), list(tags[324]), list(tags[325])
    elif 273 in tags:
        # Striped TIFF: treat each strip as a full-width tile RowsPerStrip high.
        tile_w, tile_h = one(256), min(one(278, one(257)), one(257))
        offsets, counts = list(tags[273]), list(tags[279])
    else:
        raise CogError("TIFF has neither tiles nor strips")
    bits = one(258, 8)
    fmt = one(339, 1)
    if (fmt, bits) not in _DTYPES:
        raise CogError(f"unsupported sample format {fmt}/{bits}")
    scale = tags.get(33550)
    tie = tags.get(33922)
    if not scale or not tie:
        raise CogError("no georeferencing (ModelPixelScale/ModelTiepoint)")
    epsg = None
    keys = tags.get(34735)
    if keys:
        for k in range(1, keys[3] + 1):
            key_id, loc, _cnt, value = keys[4 * k:4 * k + 4]
            if key_id in (3072, 2048) and loc == 0 and value not in (0, 32767):
                epsg = value
                if key_id == 3072:
                    break
    nodata = None
    if 42113 in tags:
        try:
            nodata = float(tags[42113][0])
        except ValueError:
            pass
    return Cog(
        url=url, headers=headers, width=one(256), height=one(257), tile_w=tile_w, tile_h=tile_h,
        offsets=offsets, counts=counts, compression=one(259, 1), predictor=one(317, 1),
        dtype=np.dtype(bo + _DTYPES[(fmt, bits)]),
        origin_x=tie[3] - tie[0] * scale[0], origin_y=tie[4] + tie[1] * scale[1],
        res_x=scale[0], res_y=scale[1], epsg=epsg, nodata=nodata, gdal_metadata=one(42112, "") or "",
    )


def _lzw(data: bytes) -> bytes:
    """TIFF-flavoured LZW (MSB-first codes, early change)."""
    out = bytearray()
    table = [bytes([i]) for i in range(256)] + [b"", b""]
    width, bitpos, nbits = 9, 0, len(data) * 8
    prev = None
    while bitpos + width <= nbits:
        byte = bitpos >> 3
        chunk = int.from_bytes(data[byte:byte + 4].ljust(4, b"\0"), "big")
        code = (chunk >> (32 - width - (bitpos & 7))) & ((1 << width) - 1)
        bitpos += width
        if code == 256:
            table = table[:258]
            width, prev = 9, None
            continue
        if code == 257:
            break
        if prev is None:
            entry = table[code]
        elif code < len(table):
            entry = table[code]
            table.append(prev + entry[:1])
        else:
            entry = prev + prev[:1]
            table.append(entry)
        out += entry
        prev = entry
        if len(table) + 1 >= (1 << width) and width < 12:
            width += 1
    return bytes(out)


def _decode(cog: Cog, data: bytes) -> np.ndarray:
    if cog.compression in (8, 32946):
        raw = zlib.decompress(data)
    elif cog.compression == 5:
        raw = _lzw(data)
    elif cog.compression == 1:
        raw = data
    else:
        raise CogError(f"unsupported compression {cog.compression}")
    n = min(len(raw) // cog.dtype.itemsize, cog.tile_w * cog.tile_h)  # the last strip may be shorter
    n -= n % cog.tile_w
    tile = np.frombuffer(raw, dtype=cog.dtype, count=n).reshape(-1, cog.tile_w)
    if cog.predictor == 2:
        tile = np.cumsum(tile, axis=1, dtype=cog.dtype)
    elif cog.predictor == 3:
        raise CogError("floating-point predictor not supported")
    return tile


async def read_window(client: httpx.AsyncClient, cog: Cog, col0: int, row0: int, col1: int, row1: int) -> np.ndarray:
    """Pixels [row0:row1, col0:col1] (clipped to the image; outside -> nodata or 0)."""
    fill = cog.nodata if cog.nodata is not None else 0
    out = np.full((row1 - row0, col1 - col0), fill, dtype=cog.dtype.newbyteorder("="))
    across = (cog.width + cog.tile_w - 1) // cog.tile_w
    down = (cog.height + cog.tile_h - 1) // cog.tile_h
    tc0, tc1 = max(col0 // cog.tile_w, 0), min((col1 - 1) // cog.tile_w, across - 1)
    tr0, tr1 = max(row0 // cog.tile_h, 0), min((row1 - 1) // cog.tile_h, down - 1)
    need = [(tr * across + tc, tr, tc) for tr in range(tr0, tr1 + 1) for tc in range(tc0, tc1 + 1)
            if cog.counts[tr * across + tc]]
    # Fetch neighbouring blocks in one request (strips are usually stored back to back).
    need.sort(key=lambda t: cog.offsets[t[0]])
    batches: list[list[tuple[int, int, int]]] = []
    for item in need:
        i = item[0]
        if batches:
            last = batches[-1][-1][0]
            start = cog.offsets[batches[-1][0][0]]
            gap = cog.offsets[i] - (cog.offsets[last] + cog.counts[last])
            if 0 <= gap < 256_000 and cog.offsets[i] + cog.counts[i] - start < 16_000_000:
                batches[-1].append(item)
                continue
        batches.append([item])
    for batch in batches:
        start = cog.offsets[batch[0][0]]
        end = max(cog.offsets[i] + cog.counts[i] for i, _, _ in batch)
        blob = await _range(client, cog.url, cog.headers, start, end - start)
        for i, tr, tc in batch:
            tile = _decode(cog, blob[cog.offsets[i] - start:cog.offsets[i] - start + cog.counts[i]])
            y0, x0 = tr * cog.tile_h, tc * cog.tile_w
            sy0, sy1 = max(row0, y0), min(row1, y0 + tile.shape[0], cog.height)
            sx0, sx1 = max(col0, x0), min(col1, x0 + tile.shape[1], cog.width)
            if sy0 < sy1 and sx0 < sx1:
                out[sy0 - row0:sy1 - row0, sx0 - col0:sx1 - col0] = tile[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0]
    return out


async def sample(client: httpx.AsyncClient, cog: Cog, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Nearest-pixel values at coordinates (x, y) in the file's CRS (arrays of any shape)."""
    fc, fr = cog.pixel(x, y)
    c, r = np.floor(fc).astype(int), np.floor(fr).astype(int)
    c0, c1, r0, r1 = int(c.min()), int(c.max()) + 1, int(r.min()), int(r.max()) + 1
    win = await read_window(client, cog, c0, r0, c1, r1)
    return win[r - r0, c - c0]
