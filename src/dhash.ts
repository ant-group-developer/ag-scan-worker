/**
 * dHash: grayscale 9×8 → 64 bit difference hash → hex string 16 chars.
 * Dùng sharp.
 */
import sharp from 'sharp';

/**
 * Tính dHash của file ảnh hoặc buffer.
 * Trả về 16 ký tự hex (64 bit).
 */
export async function computeDhash(input: string | Buffer): Promise<string> {
  // Resize về 9×8 grayscale
  const pixels = await sharp(input)
    .resize(9, 8, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer();

  // pixels: 9×8 = 72 bytes, row-major
  let bits = BigInt(0);
  let bitIdx = 0;

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left = pixels[row * 9 + col];
      const right = pixels[row * 9 + col + 1];
      if (left === undefined || right === undefined) continue;
      if (left > right) bits |= BigInt(1) << BigInt(bitIdx);
      bitIdx++;
    }
  }

  return bits.toString(16).padStart(16, '0');
}

/**
 * Tính dHash từ file video ở thời điểm t_sec (dùng sharp pipeline trên buffer ảnh đã trích).
 * inputBuffer là JPEG/PNG buffer của frame đó.
 */
export async function dhashFromBuffer(imageBuffer: Buffer): Promise<string> {
  return computeDhash(imageBuffer);
}
