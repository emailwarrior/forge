import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readExifDate, timeFromFilename, prepareImage, makeThumb } from '../../js/ai/image.js';
import { buildJpeg, buildTiff } from './fixtures/exif.mjs';

const DTO = '2026:09:26 12:34:05';
const DT = '2026:09:20 08:00:00';

test('readExifDate: DateTimeOriginal from the Exif sub-IFD in both byte orders', () => {
  for (const order of ['II', 'MM']) {
    assert.equal(readExifDate(buildJpeg({ order, dateTimeOriginal: DTO, dateTime: DT })), '2026-09-26T12:34:05', order);
    assert.equal(readExifDate(buildJpeg({ order, dateTimeOriginal: DTO }, { app0: false })), '2026-09-26T12:34:05', order + ' no APP0');
    assert.equal(readExifDate(buildJpeg({ order, dateTimeOriginal: DTO }, { xmpFirst: true })), '2026-09-26T12:34:05', order + ' XMP first');
  }
});

test('readExifDate: falls back to DateTimeDigitized, then DateTime', () => {
  for (const order of ['II', 'MM']) {
    assert.equal(readExifDate(buildJpeg({ order, dateTime: DT })), '2026-09-20T08:00:00');
    assert.equal(readExifDate(buildJpeg({ order, dateTimeDigitized: '2026:09:21 09:15:30', dateTime: DT })), '2026-09-21T09:15:30');
    assert.equal(readExifDate(buildJpeg({ order, dateTimeOriginal: '0000:00:00 00:00:00', dateTime: DT })), '2026-09-20T08:00:00');
    assert.equal(readExifDate(buildJpeg({ order, dateTimeOriginal: '    :  :     :  :  ', dateTime: DT })), '2026-09-20T08:00:00');
    assert.equal(readExifDate(buildJpeg({ order, dateTime: DT, badExifPointer: true })), '2026-09-20T08:00:00');
    assert.equal(readExifDate(buildJpeg({ order })), null);
  }
});

test('readExifDate: accepts ArrayBuffer, offset views, plain arrays, bare TIFF and embedded Exif blocks', () => {
  const jpeg = buildJpeg({ order: 'MM', dateTimeOriginal: DTO });
  assert.equal(readExifDate(jpeg.buffer), '2026-09-26T12:34:05');
  const padded = new Uint8Array(jpeg.length + 13);
  padded.set(jpeg, 13);
  assert.equal(readExifDate(padded.subarray(13)), '2026-09-26T12:34:05');
  assert.equal(readExifDate(Buffer.from(jpeg)), '2026-09-26T12:34:05');
  assert.equal(readExifDate(Array.from(jpeg)), '2026-09-26T12:34:05');
  assert.equal(readExifDate(new DataView(jpeg.buffer)), '2026-09-26T12:34:05');
  assert.equal(readExifDate(buildTiff({ order: 'II', dateTimeOriginal: DTO })), '2026-09-26T12:34:05');
  // HEIC-like container: junk, then "Exif\0\0" + TIFF
  const tiff = buildTiff({ order: 'MM', dateTimeOriginal: DTO });
  const heic = new Uint8Array(300 + 6 + tiff.length);
  heic.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
  heic.set([0x45, 0x78, 0x69, 0x66, 0, 0], 300);
  heic.set(tiff, 306);
  assert.equal(readExifDate(heic), '2026-09-26T12:34:05');
});

test('readExifDate: garbage, truncation and hostile structures return null without throwing', () => {
  for (const x of [null, undefined, '', 'not bytes', 42, {}, [], new Uint8Array(0), new Uint8Array([0xff, 0xd8]), new Uint8Array(64)]) {
    assert.equal(readExifDate(x), null);
  }
  const jpeg = buildJpeg({ order: 'II', dateTimeOriginal: DTO, dateTime: DT });
  for (let n = 0; n < jpeg.length; n++) {
    const r = readExifDate(jpeg.subarray(0, n));
    assert.ok(r === null || r === '2026-09-26T12:34:05' || r === '2026-09-20T08:00:00', `len ${n}: ${r}`);
  }
  assert.equal(readExifDate(buildJpeg({ order: 'MM', dateTimeOriginal: DTO, hugeCount: true })), '2026-09-26T12:34:05');
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed >>> 24; };
  for (let t = 0; t < 300; t++) {
    const len = 16 + (rand() * 4);
    const junk = Uint8Array.from({ length: len }, rand);
    if (t % 3 === 0) { junk[0] = 0xff; junk[1] = 0xd8; }
    if (t % 3 === 1) junk.set([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x40, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x49, 0x49, 0x2a, 0]);
    assert.equal(readExifDate(junk), null);
  }
  // flip bytes inside a valid file: never throws
  for (let i = 0; i < jpeg.length; i++) {
    const copy = jpeg.slice();
    copy[i] ^= 0xff;
    const r = readExifDate(copy);
    assert.ok(r === null || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(r));
  }
});

test('timeFromFilename: documented and common patterns', () => {
  const cases = {
    'meal_2026-09-26_12-34-05.jpg': '2026-09-26T12:34:05',
    'IMG_20260926_123405.jpg': '2026-09-26T12:34:05',
    '20260926T123405-0400.jpg': '2026-09-26T12:34:05',
    'PXL_20260926_123405123.jpg': '2026-09-26T12:34:05',
    'Screenshot 2026-09-26 at 9.05.12 PM.png': '2026-09-26T21:05:12',
    'Screenshot 2026-09-26 at 12.05.12 AM.png': '2026-09-26T00:05:12',
    'WhatsApp Image 2026-09-26 at 12.34.05.jpeg': '2026-09-26T12:34:05',
    'Screenshot_20260926-123405.png': '2026-09-26T12:34:05',
    'signal-2026-09-26-12-34-05-123.jpg': '2026-09-26T12:34:05',
    '/private/var/mobile/tmp/2026-09-26 07.08.09.jpg': '2026-09-26T07:08:09',
    'meal_2026-09-26_12-34.jpg': '2026-09-26T12:34:00',
  };
  for (const [name, want] of Object.entries(cases)) assert.equal(timeFromFilename(name), want, name);
  for (const name of ['IMG_4021.jpg', '2026-09-26.jpg', 'photo.jpg', '', null, undefined, 'IMG_20260231_123405.jpg', 'IMG_20261326_123405.jpg', 'IMG_20260926_256161.jpg', 12345]) {
    assert.equal(timeFromFilename(name), null, String(name));
  }
});

test('prepareImage/makeThumb: importable in Node, reject cleanly without a canvas', async () => {
  await assert.rejects(prepareImage(new Uint8Array(4)), (e) => e.name === 'AIError' && e.code === 'bad-request');
  await assert.rejects(makeThumb(new Uint8Array(4)), (e) => e.code === 'bad-request');
  await assert.rejects(prepareImage(null), (e) => e.code === 'bad-request');
});
