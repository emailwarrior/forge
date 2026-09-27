// Test helper: assemble minimal JPEG / TIFF byte arrays carrying EXIF date tags in either byte order.

const ascii = (s) => [...Buffer.from(s, 'latin1'), 0];

/**
 * TIFF structure: header | IFD0 | Exif sub-IFD | value data.
 * opts: { order: 'II'|'MM', dateTimeOriginal, dateTimeDigitized, dateTime, badExifPointer, hugeCount }
 */
export function buildTiff({ order = 'II', dateTimeOriginal, dateTimeDigitized, dateTime, badExifPointer = false, hugeCount = false } = {}) {
  const le = order === 'II';
  const ifd0 = [{ tag: 0x010f, type: 2, bytes: ascii('FORGE') }]; // Make
  if (dateTime) ifd0.push({ tag: 0x0132, type: 2, bytes: ascii(dateTime) });
  const exif = [];
  if (dateTimeOriginal) exif.push({ tag: 0x9003, type: 2, bytes: ascii(dateTimeOriginal) });
  if (dateTimeDigitized) exif.push({ tag: 0x9004, type: 2, bytes: ascii(dateTimeDigitized) });
  exif.push({ tag: 0xa002, type: 4, count: 1, long: 4032 }); // PixelXDimension
  ifd0.push({ tag: 0x8769, type: 4, count: 1, pointer: true });
  ifd0.sort((a, b) => a.tag - b.tag);
  exif.sort((a, b) => a.tag - b.tag);

  const ifdSize = (n) => 2 + 12 * n + 4;
  const ifd0Off = 8;
  const exifOff = ifd0Off + ifdSize(ifd0.length);
  let dataOff = exifOff + ifdSize(exif.length);
  const size = dataOff + [...ifd0, ...exif].reduce((s, e) => s + (e.bytes && e.bytes.length > 4 ? e.bytes.length + (e.bytes.length % 2) : 0), 0);
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  const w16 = (o, v) => dv.setUint16(o, v, le);
  const w32 = (o, v) => dv.setUint32(o, v >>> 0, le);

  buf[0] = buf[1] = le ? 0x49 : 0x4d;
  w16(2, 42);
  w32(4, ifd0Off);
  const writeIfd = (off, entries) => {
    w16(off, hugeCount ? 0xffff : entries.length);
    entries.forEach((e, i) => {
      const p = off + 2 + i * 12;
      w16(p, e.tag); w16(p + 2, e.type);
      if (e.pointer) { w32(p + 4, 1); w32(p + 8, badExifPointer ? 0x7ffffff0 : exifOff); return; }
      if (e.long != null) { w32(p + 4, e.count || 1); w32(p + 8, e.long); return; }
      w32(p + 4, e.bytes.length);
      if (e.bytes.length <= 4) { buf.set(e.bytes, p + 8); return; }
      w32(p + 8, dataOff);
      buf.set(e.bytes, dataOff);
      dataOff += e.bytes.length + (e.bytes.length % 2);
    });
    w32(off + 2 + entries.length * 12, 0); // next IFD
  };
  writeIfd(ifd0Off, ifd0);
  writeIfd(exifOff, exif);
  return buf;
}

/** A JPEG: SOI, optional APP0 (JFIF), APP1 (Exif + TIFF), DQT, SOS with a few scan bytes, EOI. */
export function buildJpeg(tiffOpts = {}, { app0 = true, xmpFirst = false } = {}) {
  const tiff = buildTiff(tiffOpts);
  const parts = [[0xff, 0xd8]];
  if (app0) parts.push([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  if (xmpFirst) {
    const xmp = [...Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>', 'latin1')];
    const len = xmp.length + 2;
    parts.push([0xff, 0xe1, len >> 8, len & 0xff, ...xmp]);
  }
  const app1Len = 2 + 6 + tiff.length;
  parts.push([0xff, 0xe1, app1Len >> 8, app1Len & 0xff, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]);
  parts.push([0xff, 0xdb, 0x00, 0x04, 0x00, 0x01]);
  parts.push([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0x34, 0x56, 0xff, 0x00, 0x78]);
  parts.push([0xff, 0xd9]);
  return Uint8Array.from(parts.flat());
}
