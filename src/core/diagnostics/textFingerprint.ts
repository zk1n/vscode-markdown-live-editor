/**
 * A stable, non-content diagnostic fingerprint. It is for correlation only,
 * not cryptographic integrity or security decisions.
 */
export function textFingerprint(text: string): string {
  let forward = 0x811c9dc5;
  let reverse = 0x01000193;
  for (let index = 0; index < text.length; index += 1) {
    forward = Math.imul(forward ^ text.charCodeAt(index), 0x01000193);
    reverse = Math.imul(reverse ^ text.charCodeAt(text.length - 1 - index), 0x811c9dc5);
  }
  return `${text.length.toString(16)}:${(forward >>> 0).toString(16)}:${(reverse >>> 0).toString(16)}`;
}
