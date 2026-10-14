/**
 * Dựng cảnh cho scan.prep theo ĐÚNG luật của Studio, để cảnh ag-go chuẩn bị trùng với cảnh Studio tự cắt:
 * - `buildShots`: chép từ ag-studio `packages/core/src/media/scene.ts` (bộ test chép theo ở `shots.spec.ts`).
 * - `parseSceneCuts`: cách đọc mốc cắt của ag-studio `packages/studio-engine/src/cut-ffmpeg.ts` (`detectCuts`):
 *   `pts_time` của showinfo, làm tròn lưới 0,1 s, bỏ trùng, tăng dần.
 * Sửa luật ở đây thì sửa cả bên Studio (và ngược lại).
 */

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Turns raw scene-cut times into one source's shot list.
 *
 * Boundaries = `[0, ...cuts strictly inside (0, duration) sorted ascending, duration]`, which produces the
 * initial (unmerged, unsplit) shots. Then:
 * - a shot shorter than `min_shot_seconds` merges into the *previous* shot; the very first shot has no
 *   previous, so it merges *forward* into the next one instead (possibly repeatedly, if that next shot is
 *   itself still short once combined -- this only ever chases forward, never backward, so it terminates).
 * - a shot longer than `max_shot_seconds` splits evenly into `ceil(length / max_shot_seconds)` equal parts
 *   (this happens after merging, so a long run of merged-forward short shots gets split back down too).
 *
 * All returned `in`/`out` values are rounded to 3 decimal places. `duration <= 0` (nothing to shoot) returns
 * `[]` without looking at `cuts`.
 */
export function buildShots(
  cuts: number[],
  duration: number,
  o: { min_shot_seconds: number; max_shot_seconds: number },
): { in: number; out: number }[] {
  if (duration <= 0) return [];

  const inRange = cuts.filter((c) => c > 0 && c < duration).sort((a, b) => a - b);
  const boundaries = [0, ...inRange, duration];

  const initial: { in: number; out: number }[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    initial.push({ in: boundaries[i]!, out: boundaries[i + 1]! });
  }

  // Merge shots shorter than min_shot_seconds into the previous shot -- or, for the first shot (no previous),
  // forward into the next one; `initial[i + 1]` is mutated in place so a chain of short shots at the head
  // collapses correctly as the loop advances into it.
  const merged: { in: number; out: number }[] = [];
  for (let i = 0; i < initial.length; i++) {
    const s = initial[i]!;
    const length = s.out - s.in;
    if (length < o.min_shot_seconds) {
      if (merged.length === 0) {
        if (i + 1 < initial.length) {
          initial[i + 1] = { in: s.in, out: initial[i + 1]!.out };
          continue;
        }
        merged.push(s); // the only shot there is: nothing to merge into either direction
      } else {
        merged[merged.length - 1] = { in: merged[merged.length - 1]!.in, out: s.out };
      }
    } else {
      merged.push(s);
    }
  }

  // Split shots longer than max_shot_seconds into ceil(length / max) equal parts.
  const out: { in: number; out: number }[] = [];
  for (const s of merged) {
    const length = s.out - s.in;
    if (length > o.max_shot_seconds) {
      const parts = Math.ceil(length / o.max_shot_seconds);
      const partLen = length / parts;
      for (let i = 0; i < parts; i++) {
        const partIn = s.in + i * partLen;
        const partOut = i === parts - 1 ? s.out : s.in + (i + 1) * partLen;
        out.push({ in: round3(partIn), out: round3(partOut) });
      }
    } else {
      out.push({ in: round3(s.in), out: round3(s.out) });
    }
  }
  return out;
}

/**
 * Mốc cắt (giây, tăng dần, lưới 0,1 s) từ log `showinfo` của `select='gt(scene\,T)',showinfo`, như Studio.
 * `startTimeS`: `start_time` của file; trừ đi để mốc theo timeline bắt đầu từ 0 (file Studio cắt luôn bắt đầu ở 0,
 * nên với nó hai cách cho cùng kết quả).
 */
export function parseSceneCuts(stderr: string, startTimeS = 0): number[] {
  const times = new Set<number>();
  for (const m of stderr.matchAll(/pts_time:([0-9.]+)/g)) {
    const t = Number(m[1]) - startTimeS;
    if (Number.isFinite(t)) times.add(Math.round(t * 10) / 10);
  }
  return [...times].sort((a, b) => a - b);
}

/** Thời điểm lấy khung đại diện của cảnh: giữa cảnh, làm tròn ms (như Studio). */
export function middleFrameTime(shot: { in: number; out: number }): number {
  return Math.round(((shot.in + shot.out) / 2) * 1000) / 1000;
}

/** Chia cảnh theo thứ tự thành các tờ, mỗi tờ tối đa `perSheet` cảnh. */
export function sheetGroups<T>(shots: T[], perSheet: number): T[][] {
  const groups: T[][] = [];
  for (let k = 0; k < shots.length; k += perSheet) groups.push(shots.slice(k, k + perSheet));
  return groups;
}
