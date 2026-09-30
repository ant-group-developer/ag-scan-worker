/**
 * Tiện ích phụ: chỉ còn hàm tính khoảng cách Hamming giữa hai dHash 64-bit.
 * Các hàm chia đoạn cũ (buildWindows, mergeWindows, mergeShortSegments, buildSegments)
 * đã được bỏ theo giao thức v2 – scan.extract không còn chia đoạn mà chỉ phát hiện cảnh.
 */

// ---- dHash Hamming distance ----

/**
 * Tính khoảng cách Hamming giữa hai dHash 64-bit (16 ký tự hex).
 * Trả về -1 nếu một trong hai hash không hợp lệ.
 */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== 16 || b.length !== 16) return -1;
  let dist = 0;
  for (let i = 0; i < 16; i += 4) {
    const wordA = parseInt(a.slice(i, i + 4), 16);
    const wordB = parseInt(b.slice(i, i + 4), 16);
    if (!Number.isFinite(wordA) || !Number.isFinite(wordB)) return -1;
    let xor = wordA ^ wordB;
    // Đếm bit 1 (popcount)
    while (xor) { dist += xor & 1; xor >>= 1; }
  }
  return dist;
}
