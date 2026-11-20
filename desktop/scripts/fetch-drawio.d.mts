/** Types for the build script, which the server's tests import. */
export const DRAWIO_VERSION: string
export function drawioUrl(version?: string): string
/** True when a zip entry name could be written outside the target folder. */
export function unsafeEntry(name: string): boolean
export function listZip(archive: string): string[]
export function fetchDrawio(options?: { version?: string; target?: string }): Promise<void>
