export const COMPRESSED_BODY_LIMIT_BYTES   = 256 * 1024;        // 256 KiB
export const DECOMPRESSED_BODY_LIMIT_BYTES = 2   * 1024 * 1024; // 2 MiB

export function buildServerOpts(): { bodyLimit: number } {
  return { bodyLimit: COMPRESSED_BODY_LIMIT_BYTES };
}
