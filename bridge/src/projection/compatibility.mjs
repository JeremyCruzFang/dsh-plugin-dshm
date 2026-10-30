// Enumerate verified carriers; a future prerelease is not implicitly compatible.
// Keep package metadata and the release gate aligned with the native test receipt.
export const supportedDSHVersions = Object.freeze(['0.2.1-rc.3', '0.2.1-rc.5'])
export const supportsDSH = version => supportedDSHVersions.includes(version)
