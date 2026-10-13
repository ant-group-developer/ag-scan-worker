/**
 * Tên gói của worker này trong `/dist/latest.json` của hub (scripts/release.mjs phát hành dưới tên này). Worker tự cập
 * nhật theo nó (worker-sdk `selfUpdate`), installer cài vai trò `scan` từ gói cùng tên.
 */
export const RELEASE_PACKAGE = 'ag-scan-worker';
