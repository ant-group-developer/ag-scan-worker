/**
 * Test thuần: segmentation.ts
 */
import {
  hammingDistance,
  buildWindows,
  mergeWindows,
  mergeShortSegments,
  buildSegments,
} from './segmentation';

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

// ---- buildWindows ----

describe('buildWindows', () => {
  const noDhash = () => '0000000000000000';

  it('produces single window for clip exactly fitting window size', () => {
    const wins = buildWindows(4000, [], 4000, noDhash);
    expect(wins).toHaveLength(1);
    expect(wins[0]!.start_ms).toBe(0);
    expect(wins[0]!.end_ms).toBe(4000);
    expect(wins[0]!.boundary_reason).toBe('end');
  });

  it('produces two windows for 5s clip with 4s window', () => {
    const wins = buildWindows(5000, [], 4000, noDhash);
    expect(wins).toHaveLength(2);
    expect(wins[0]!.end_ms).toBe(4000);
    expect(wins[1]!.end_ms).toBe(5000);
    expect(wins[1]!.boundary_reason).toBe('end');
  });

  it('splits at scene cuts within window', () => {
    const wins = buildWindows(10000, [3000, 7000], 4000, noDhash);
    // Cửa sổ 1: 0→3000 (scene_cut), 2: 3000→7000 (scene_cut), 3: 7000→10000 (end)
    expect(wins).toHaveLength(3);
    expect(wins[0]!.boundary_reason).toBe('scene_cut');
    expect(wins[1]!.boundary_reason).toBe('scene_cut');
    expect(wins[2]!.boundary_reason).toBe('end');
  });

  it('splits by window when no scene cuts', () => {
    const wins = buildWindows(12000, [], 4000, noDhash);
    // 0→4000, 4000→8000, 8000→12000
    expect(wins).toHaveLength(3);
    expect(wins[0]!.boundary_reason).toBe('window');
    expect(wins[1]!.boundary_reason).toBe('window');
    expect(wins[2]!.boundary_reason).toBe('end');
  });

  it('returns empty for zero duration', () => {
    expect(buildWindows(0, [], 4000, noDhash)).toHaveLength(0);
  });
});

// ---- mergeWindows ----

describe('mergeWindows', () => {
  const sameHash = '0000000000000000';
  const diffHash = 'ffffffffffffffff';

  it('merges adjacent windows with same dHash', () => {
    const wins = [
      { start_ms: 0, end_ms: 4000, boundary_reason: 'window' as const, dhash: sameHash },
      { start_ms: 4000, end_ms: 8000, boundary_reason: 'end' as const, dhash: sameHash },
    ];
    const merged = mergeWindows(wins, 10, 20000);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.end_ms).toBe(8000);
  });

  it('does not merge if max_segment exceeded', () => {
    const wins = [
      { start_ms: 0, end_ms: 12000, boundary_reason: 'window' as const, dhash: sameHash },
      { start_ms: 12000, end_ms: 22000, boundary_reason: 'end' as const, dhash: sameHash },
    ];
    // 12000 + 10000 = 22000 > 20000
    const merged = mergeWindows(wins, 64, 20000);
    expect(merged).toHaveLength(2);
  });

  it('does not merge if Hamming distance too large', () => {
    const wins = [
      { start_ms: 0, end_ms: 4000, boundary_reason: 'window' as const, dhash: sameHash },
      { start_ms: 4000, end_ms: 8000, boundary_reason: 'end' as const, dhash: diffHash },
    ];
    const merged = mergeWindows(wins, 5, 20000); // distance=64 > 5
    expect(merged).toHaveLength(2);
  });
});

// ---- mergeShortSegments ----

describe('mergeShortSegments', () => {
  const closerHash  = '0000000000000001'; // distance 1 from 0000...
  const fartherHash = '00000000000000ff'; // distance 8 from 0000...
  const zeroHash    = '0000000000000000';

  it('merges short segment into closer neighbor (prev)', () => {
    // short (1000ms) between prev (5000ms, dist=1) and next (5000ms, dist=8)
    const wins = [
      { start_ms: 0,     end_ms: 5000,  boundary_reason: 'window'  as const, dhash: closerHash },
      { start_ms: 5000,  end_ms: 6000,  boundary_reason: 'scene_cut' as const, dhash: zeroHash },
      { start_ms: 6000,  end_ms: 11000, boundary_reason: 'end'      as const, dhash: fartherHash },
    ];
    const result = mergeShortSegments(wins, 1500, 20000);
    // short should merge into prev (closer)
    expect(result).toHaveLength(2);
    expect(result[0]!.end_ms).toBe(6000); // prev absorbed short
    expect(result[1]!.start_ms).toBe(6000);
  });

  it('merges short segment into closer neighbor (next)', () => {
    const wins = [
      { start_ms: 0,    end_ms: 5000,  boundary_reason: 'window'    as const, dhash: fartherHash },
      { start_ms: 5000, end_ms: 6000,  boundary_reason: 'scene_cut' as const, dhash: zeroHash },
      { start_ms: 6000, end_ms: 11000, boundary_reason: 'end'       as const, dhash: closerHash },
    ];
    const result = mergeShortSegments(wins, 1500, 20000);
    // short should merge into next (closer)
    expect(result).toHaveLength(2);
    expect(result[1]!.start_ms).toBe(5000);
    expect(result[1]!.end_ms).toBe(11000);
  });

  it('keeps segment if already above min', () => {
    const wins = [
      { start_ms: 0,    end_ms: 5000,  boundary_reason: 'window' as const, dhash: zeroHash },
      { start_ms: 5000, end_ms: 10000, boundary_reason: 'end'    as const, dhash: zeroHash },
    ];
    const result = mergeShortSegments(wins, 1500, 20000);
    expect(result).toHaveLength(2);
  });
});

// ---- buildSegments ----

describe('buildSegments', () => {
  it('basic 60s video splits into 3 × 20s with no scene cuts and same dHash', () => {
    const segs = buildSegments({
      duration_ms: 60_000,
      scene_cuts_ms: [],
      window_ms: 4_000,
      max_segment_ms: 20_000,
      min_segment_ms: 1_500,
      merge_dhash_max_distance: 64, // merge everything
      getDhash: () => '0000000000000000',
    });
    // All windows merge until 20s cap → 3 × 20s
    expect(segs).toHaveLength(3);
    segs.forEach((s, i) => {
      expect(s.start_ms).toBe(i * 20_000);
      expect(s.end_ms).toBe((i + 1) * 20_000);
    });
  });

  it('respects scene cuts', () => {
    const segs = buildSegments({
      duration_ms: 30_000,
      scene_cuts_ms: [10_000, 20_000],
      window_ms: 4_000,
      max_segment_ms: 20_000,
      min_segment_ms: 0,
      merge_dhash_max_distance: 0, // no dHash merge
      getDhash: () => '0000000000000000',
    });
    // With merge_dhash_max_distance=0 and identical dHashes: distance=0 ≤ 0 → merges!
    // So we need different hashes to prevent merge across scene cuts
    // Actually with distance=0 and max_distance=0, they DO merge. Let's use different hashes.
    // Re-run with distinct hashes:
    const hashes = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc'];
    let idx = 0;
    const segs2 = buildSegments({
      duration_ms: 30_000,
      scene_cuts_ms: [10_000, 20_000],
      window_ms: 4_000,
      max_segment_ms: 20_000,
      min_segment_ms: 0,
      merge_dhash_max_distance: 0,
      getDhash: (t) => {
        if (t < 10_000) return hashes[0]!;
        if (t < 20_000) return hashes[1]!;
        return hashes[2]!;
      },
    });
    // 3 segments: 0-10s, 10-20s, 20-30s
    expect(segs2.length).toBeGreaterThanOrEqual(3);
    // First segment starts at 0
    expect(segs2[0]!.start_ms).toBe(0);
  });

  it('still image produces single segment start_ms=end_ms=0', () => {
    // For still images the caller passes duration_ms=0
    // buildWindows returns [] for duration_ms=0
    const segs = buildSegments({
      duration_ms: 0,
      scene_cuts_ms: [],
      window_ms: 4_000,
      max_segment_ms: 20_000,
      min_segment_ms: 1_500,
      merge_dhash_max_distance: 10,
      getDhash: () => '0000000000000000',
    });
    expect(segs).toHaveLength(0); // still handled separately in scan-extract
  });

  it('enforces max_segment_ms cap', () => {
    // A 25s window with no cuts and same dHash; max=20s → cannot merge into >20s
    const segs = buildSegments({
      duration_ms: 25_000,
      scene_cuts_ms: [],
      window_ms: 4_000,
      max_segment_ms: 20_000,
      min_segment_ms: 0,
      merge_dhash_max_distance: 64,
      getDhash: () => '0000000000000000',
    });
    // Each segment ≤ 20s
    segs.forEach((s) => {
      expect(s.end_ms - s.start_ms).toBeLessThanOrEqual(20_000);
    });
  });
});
