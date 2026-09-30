/**
 * REMOVED in v2.
 *
 * run_golden.ts đánh giá mô tả theo từng đoạn (SegmentDescription) và
 * đã bị bỏ khi chuyển sang giao thức v2: scan.ai giờ mô tả CẢ video
 * (AssetDescription) thay vì từng đoạn riêng. Adapting it is not
 * reasonable because:
 *   - SegmentDescriptionSchema no longer exists in @ag-farm/protocol
 *   - The golden file format (segment_id, per-segment keyframe_paths) does
 *     not map cleanly to the new asset-level single description
 *   - A new golden evaluation tool should be written that takes an asset_id
 *     plus a folder of keyframes and compares the resulting AssetDescription
 *
 * Action: write a new eval/run_golden_v2.ts when the schema and prompt
 * are stable.
 */

export {};
