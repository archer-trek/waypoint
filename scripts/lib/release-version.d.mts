export interface ParsedSemver {
  version: string;
  major: number;
  minor: number;
  patch: number;
}

export type VersionMap = Record<string, string | undefined>;

export function parseStrictSemver(rawVersion: string, label?: string): ParsedSemver;
export function compareSemver(a: string, b: string): number;
export function resolveNextVersion(currentVersion: string, targetInput: string): string;
export function getVersionFilePaths(rootDir?: string): {
  packageJsonPath: string;
  packageLockPath: string;
  tauriConfPath: string;
  cargoTomlPath: string;
  cargoLockPath: string;
};
export function readAllVersions(rootDir?: string): VersionMap;
export function assertConsistentVersions(rootDir?: string): string;
export function updateAllVersions(nextVersionRaw: string, rootDir?: string): string;
