/**
 * Test thuần: shots.ts. Ca `buildShots` chép từ ag-studio `packages/core/test/media/scene.test.ts` (giữ nguyên để
 * hai bên dựng cảnh như nhau); phần đọc mốc cắt theo `detectCuts` của Studio.
 */
import { buildShots, middleFrameTime, parseSceneCuts, sheetGroups } from './shots';

describe('buildShots', () => {
  it('with no cuts, splits the whole duration evenly when it exceeds max_shot_seconds', () => {
    const shots = buildShots([], 10, { min_shot_seconds: 1, max_shot_seconds: 4 });
    expect(shots).toHaveLength(3);
    expect(shots[0]!.in).toBe(0);
    expect(shots[2]!.out).toBe(10);
    // rounded to 3 decimals, so each part can be up to ~0.001s off from the exact 10/3 split
    for (const s of shots) expect(s.out - s.in).toBeCloseTo(10 / 3, 2);
  });

  it('merges a too-short first shot forward into the next one', () => {
    const shots = buildShots([0.4, 5], 10, { min_shot_seconds: 1, max_shot_seconds: 20 });
    expect(shots).toEqual([
      { in: 0, out: 5 },
      { in: 5, out: 10 },
    ]);
  });

  it('merges a too-short last shot into the previous one', () => {
    const shots = buildShots([9.7], 10, { min_shot_seconds: 1, max_shot_seconds: 20 });
    expect(shots).toEqual([{ in: 0, out: 10 }]);
  });

  it('drops cuts outside the open interval (0, duration)', () => {
    const shots = buildShots([-1, 0, 10, 15], 10, { min_shot_seconds: 1, max_shot_seconds: 20 });
    expect(shots).toEqual([{ in: 0, out: 10 }]);
  });

  it('returns [] when duration is 0 or negative, regardless of cuts', () => {
    expect(buildShots([1, 2], 0, { min_shot_seconds: 1, max_shot_seconds: 20 })).toEqual([]);
    expect(buildShots([], -5, { min_shot_seconds: 1, max_shot_seconds: 20 })).toEqual([]);
  });

  it('rounds in/out to 3 decimal places', () => {
    const shots = buildShots([], 10, { min_shot_seconds: 1, max_shot_seconds: 3 });
    for (const s of shots) {
      expect(s.in).toBe(Math.round(s.in * 1000) / 1000);
      expect(s.out).toBe(Math.round(s.out * 1000) / 1000);
    }
    // 10 / ceil(10/3)=4 parts -> 2.5s each
    expect(shots).toEqual([
      { in: 0, out: 2.5 },
      { in: 2.5, out: 5 },
      { in: 5, out: 7.5 },
      { in: 7.5, out: 10 },
    ]);
  });

  it('keeps a middle shot as-is when it is within [min, max]', () => {
    const shots = buildShots([3, 6], 10, { min_shot_seconds: 1, max_shot_seconds: 20 });
    expect(shots).toEqual([
      { in: 0, out: 3 },
      { in: 3, out: 6 },
      { in: 6, out: 10 },
    ]);
  });
});

describe('parseSceneCuts', () => {
  const log = [
    '[Parsed_showinfo_1 @ 0x1] n:   0 pts:  61440 pts_time:4.8     duration:512 pos: 1 fmt:yuv420p',
    '[Parsed_showinfo_1 @ 0x1] n:   1 pts: 150016 pts_time:11.72   duration:512 pos: 2 fmt:yuv420p',
    '[Parsed_showinfo_1 @ 0x1] n:   2 pts: 150528 pts_time:11.76   duration:512 pos: 3 fmt:yuv420p',
    '[Parsed_showinfo_1 @ 0x1] n:   3 pts:  25600 pts_time:2.04    duration:512 pos: 4 fmt:yuv420p',
    'frame=  300 fps=0.0 q=-0.0 Lsize=N/A time=00:00:12.00',
  ].join('\n');

  it('reads showinfo times on the 0.1 s grid, once each, ascending (like Studio)', () => {
    expect(parseSceneCuts(log)).toEqual([2, 4.8, 11.7, 11.8]);
    expect(parseSceneCuts('no cuts here')).toEqual([]);
  });

  it('counts from the start of the file when it does not start at 0', () => {
    expect(parseSceneCuts('pts_time:3.5\npts_time:10.04', 1.4)).toEqual([2.1, 8.6]);
  });
});

describe('middleFrameTime and sheetGroups', () => {
  it('takes the middle of a shot, rounded to the millisecond', () => {
    expect(middleFrameTime({ in: 0, out: 3 })).toBe(1.5);
    expect(middleFrameTime({ in: 3.333, out: 6.667 })).toBe(5);
    expect(middleFrameTime({ in: 1, out: 2.0004 })).toBe(1.5);
  });

  it('puts the shots on sheets in order, a full sheet before the next', () => {
    const shots = Array.from({ length: 35 }, (_, i) => i + 1);
    const groups = sheetGroups(shots, 16);
    expect(groups.map((g) => g.length)).toEqual([16, 16, 3]);
    expect(groups[1]![0]).toBe(17);
    expect(sheetGroups([], 16)).toEqual([]);
  });
});
