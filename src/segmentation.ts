/**
 * Thuần module chia đoạn: chia cửa sổ, gộp theo dHash, gộp đoạn ngắn vào bên cạnh giống hơn.
 * KHÔNG phụ thuộc ffmpeg/sharp, dễ test.
 */

export type BoundaryReason = 'scene_cut' | 'window' | 'max_length' | 'end' | 'still';

export interface RawWindow {
  /** Thời điểm bắt đầu (ms). */
  start_ms: number;
  /** Thời điểm kết thúc (ms). */
  end_ms: number;
  /** Lý do kết thúc cửa sổ. */
  boundary_reason: BoundaryReason;
  /** dHash 64-bit của keyframe đại diện. */
  dhash: string;
}

export interface Segment {
  index: number;
  start_ms: number;
  end_ms: number;
  boundary_reason: BoundaryReason;
  dhash: string;
}

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

// ---- Chia cửa sổ ban đầu ----

export interface SplitOptions {
  /** Thời lượng file (ms). */
  duration_ms: number;
  /** Thời điểm cắt cảnh (ms). */
  scene_cuts_ms: number[];
  /** Cửa sổ cơ bản (ms). */
  window_ms: number;
  /** Trần độ dài sau gộp (ms). */
  max_segment_ms: number;
  /** Đoạn ngắn hơn (ms) gộp vào bên cạnh giống hơn. */
  min_segment_ms: number;
  /** Khoảng cách Hamming tối đa để gộp hai cửa sổ. */
  merge_dhash_max_distance: number;
  /** Callback tính dHash cho một thời điểm (ms). */
  getDhash: (t_ms: number) => string;
}

/**
 * Tạo danh sách cửa sổ ban đầu: cắt tại scene change hoặc sau window_ms.
 */
export function buildWindows(
  duration_ms: number,
  scene_cuts_ms: number[],
  window_ms: number,
  getDhash: (t_ms: number) => string,
): RawWindow[] {
  if (duration_ms <= 0) return [];

  const cuts = [...new Set([0, ...scene_cuts_ms, duration_ms])].sort((a, b) => a - b);

  const windows: RawWindow[] = [];
  let segStart = 0;

  while (segStart < duration_ms) {
    const nextCut = cuts.find((c) => c > segStart);
    const windowEnd = segStart + window_ms;

    let end_ms: number;
    let boundary: BoundaryReason;

    if (nextCut !== undefined && nextCut <= windowEnd) {
      end_ms = nextCut;
      boundary = nextCut === duration_ms ? 'end' : 'scene_cut';
    } else if (windowEnd >= duration_ms) {
      end_ms = duration_ms;
      boundary = 'end';
    } else {
      end_ms = windowEnd;
      boundary = 'window';
    }

    const midpoint = Math.round((segStart + end_ms) / 2);
    windows.push({
      start_ms: segStart,
      end_ms,
      boundary_reason: boundary,
      dhash: getDhash(midpoint),
    });

    segStart = end_ms;
  }

  return windows;
}

/**
 * Gộp các cửa sổ liền kề có dHash gần nhau (≤ merge_dhash_max_distance),
 * không vượt max_segment_ms.
 */
export function mergeWindows(
  windows: RawWindow[],
  mergeMaxDistance: number,
  max_segment_ms: number,
): RawWindow[] {
  if (windows.length === 0) return [];

  const result: RawWindow[] = [];
  let current = { ...windows[0]! };

  for (let i = 1; i < windows.length; i++) {
    const next = windows[i]!;
    const currentLen = current.end_ms - current.start_ms;
    const nextLen = next.end_ms - next.start_ms;
    const dist = hammingDistance(current.dhash, next.dhash);
    const wouldBeTooLong = currentLen + nextLen > max_segment_ms;

    if (!wouldBeTooLong && dist >= 0 && dist <= mergeMaxDistance) {
      // Gộp: giữ boundary của next, dHash là trung bình (lấy dhash của midpoint merged)
      current = {
        start_ms: current.start_ms,
        end_ms: next.end_ms,
        boundary_reason: next.boundary_reason,
        // Giữ dhash của cửa sổ lớn hơn sau khi merge
        dhash: next.dhash,
      };
    } else {
      result.push(current);
      current = { ...next };
    }
  }
  result.push(current);
  return result;
}

/**
 * Gộp đoạn ngắn vào đoạn bên cạnh giống hơn (so dHash).
 * Đây là quy tắc MỚI: khác buildShots của harness (gộp vào đoạn liền trước).
 */
export function mergeShortSegments(
  windows: RawWindow[],
  min_segment_ms: number,
  max_segment_ms: number,
): RawWindow[] {
  if (windows.length === 0) return [];
  let segs = [...windows];
  let changed = true;

  while (changed) {
    changed = false;
    const next: RawWindow[] = [];
    let i = 0;

    while (i < segs.length) {
      const seg = segs[i]!;
      const len = seg.end_ms - seg.start_ms;

      if (len >= min_segment_ms || segs.length === 1) {
        next.push(seg);
        i++;
        continue;
      }

      // Đoạn ngắn: tìm bên cạnh giống hơn
      const prev = i > 0 ? segs[i - 1]! : null;
      const nextSeg = i < segs.length - 1 ? segs[i + 1]! : null;

      let mergeWith: 'prev' | 'next' | null = null;

      if (prev && nextSeg) {
        const distPrev = hammingDistance(seg.dhash, prev.dhash);
        const distNext = hammingDistance(seg.dhash, nextSeg.dhash);
        const prevLen = prev.end_ms - prev.start_ms;
        const nextLen = nextSeg.end_ms - nextSeg.start_ms;
        const canMergePrev = prevLen + len <= max_segment_ms;
        const canMergeNext = nextLen + len <= max_segment_ms;

        if (canMergePrev && canMergeNext) {
          mergeWith = distPrev <= distNext ? 'prev' : 'next';
        } else if (canMergePrev) {
          mergeWith = 'prev';
        } else if (canMergeNext) {
          mergeWith = 'next';
        }
      } else if (prev) {
        const prevLen = prev.end_ms - prev.start_ms;
        if (prevLen + len <= max_segment_ms) mergeWith = 'prev';
      } else if (nextSeg) {
        const nextLen = nextSeg.end_ms - nextSeg.start_ms;
        if (nextLen + len <= max_segment_ms) mergeWith = 'next';
      }

      if (!mergeWith) {
        // Không thể gộp (đều vượt max) → giữ nguyên
        next.push(seg);
        i++;
        continue;
      }

      if (mergeWith === 'prev' && next.length > 0) {
        const p = next[next.length - 1]!;
        next[next.length - 1] = {
          start_ms: p.start_ms,
          end_ms: seg.end_ms,
          boundary_reason: seg.boundary_reason,
          dhash: p.dhash, // Giữ dhash của đoạn lớn hơn
        };
        changed = true;
        i++;
      } else if (mergeWith === 'next' && nextSeg) {
        // Gộp vào next: skip cả seg và nextSeg, push merged
        segs[i + 1] = {
          start_ms: seg.start_ms,
          end_ms: nextSeg.end_ms,
          boundary_reason: nextSeg.boundary_reason,
          dhash: nextSeg.dhash,
        };
        changed = true;
        i++; // skip current seg
      } else {
        // Fallback: không merge được
        next.push(seg);
        i++;
      }
    }

    segs = next;
  }

  return segs;
}

// ---- API chính ----

/**
 * Chia video thành segments:
 * 1. Chia cửa sổ tại scene cut / window_ms
 * 2. Gộp cửa sổ liền kề có dHash gần nhau
 * 3. Gộp đoạn ngắn vào bên cạnh giống hơn
 */
export function buildSegments(options: SplitOptions): Segment[] {
  const { duration_ms, scene_cuts_ms, window_ms, max_segment_ms, min_segment_ms, merge_dhash_max_distance, getDhash } = options;

  const rawWindows = buildWindows(duration_ms, scene_cuts_ms, window_ms, getDhash);
  const merged = mergeWindows(rawWindows, merge_dhash_max_distance, max_segment_ms);
  const final = mergeShortSegments(merged, min_segment_ms, max_segment_ms);

  return final.map((w, idx) => ({
    index: idx,
    start_ms: w.start_ms,
    end_ms: w.end_ms,
    boundary_reason: w.boundary_reason,
    dhash: w.dhash,
  }));
}
