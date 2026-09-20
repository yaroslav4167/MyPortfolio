import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

/**
 * Whether a PNG actually uses transparency.
 *
 * Having an alpha channel means nothing on its own: screenshots almost always carry
 * one while every pixel stays opaque — those can safely become JPEG, which is a
 * tenfold difference in weight. Transparency matters only where it is really used:
 * stickers, the avatar, rounded objects sitting over the scene.
 *
 * @param {string} file
 * @returns {boolean}
 */
export function usesTransparency(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) return false; // not a PNG

  let width = 0;
  let height = 0;
  let colorType = 0;
  let bitDepth = 8;
  const idat = [];

  for (let at = 8; at < buf.length - 8; ) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString('ascii', at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + length);

    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      // Palette tRNS and 16-bit PNGs are not parsed — treated as transparent.
      if (colorType !== 6 && colorType !== 4) return colorType === 3;
      if (bitDepth !== 8) return true;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }

  if (!idat.length) return true;

  const raw = inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : 2; // RGBA, or gray with alpha
  const stride = width * channels;
  const line = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);

  for (let y = 0, at = 0; y < height; y++) {
    const filter = raw[at++];
    raw.copy(line, 0, at, at + stride);
    at += stride;

    // Undo the row filter, otherwise the alpha bytes read as noise.
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? line[i - channels] : 0;
      const up = prev[i];
      const upLeft = i >= channels ? prev[i - channels] : 0;
      switch (filter) {
        case 1: line[i] = (line[i] + left) & 0xff; break;
        case 2: line[i] = (line[i] + up) & 0xff; break;
        case 3: line[i] = (line[i] + ((left + up) >> 1)) & 0xff; break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          line[i] = (line[i] + pred) & 0xff;
          break;
        }
        default: break;
      }
    }

    for (let i = channels - 1; i < stride; i += channels) {
      if (line[i] < 250) return true;
    }
    line.copy(prev);
  }

  return false;
}
