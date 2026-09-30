/**
 * Test thuần: segmentation.ts (chỉ còn hammingDistance sau v2).
 * Các hàm buildWindows/mergeWindows/mergeShortSegments/buildSegments đã bị bỏ khi
 * chuyển sang giao thức v2 (không còn chia đoạn dựa trên cửa sổ).
 */
import { hammingDistance } from './segmentation';

// ---- dHash Hamming ----

describe('hammingDistance', () => {
  it('returns 0 for identical hashes', () => {
    expect(hammingDistance('0000000000000000', '0000000000000000')).toBe(0);
    expect(hammingDistance('ffffffffffffffff', 'ffffffffffffffff')).toBe(0);
  });

  it('returns correct count for one bit diff', () => {
    // 0x0001 vs 0x0000 → 1 bit
    expect(hammingDistance('0001000000000000', '0000000000000000')).toBe(1);
  });

  it('returns 64 for fully inverted', () => {
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
  });

  it('returns -1 for invalid length', () => {
    expect(hammingDistance('abc', 'abc')).toBe(-1);
    expect(hammingDistance('0000000000000000', 'short')).toBe(-1);
  });
});

// Các hàm buildWindows / mergeWindows / mergeShortSegments / buildSegments đã bị bỏ trong v2.
// Test tương ứng đã được xoá.
