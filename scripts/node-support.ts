// SPDX-License-Identifier: LGPL-3.0-or-later
/** Node release eligibility shared by compatibility checks and their fixed-date tests. */

/** Official Node release and end-of-life dates, keyed by major version. */
export type NodeSchedule = Record<string, { start: string; end: string }>

/** Select maintained, stable Node releases accepted by the chosen DSH version.
 * @param version Executable's Node version.
 * @param required DSH's Node engines range.
 * @param schedule Official Node release schedule.
 * @param today UTC date in YYYY-MM-DD format.
 * @returns The rejection reason, or undefined for an eligible runtime.
 */
export function nodeSupportReason(version: string, required: string, schedule: NodeSchedule, today: string): string | undefined {
  const major = /^v?(\d+)\.\d+\.\d+$/.exec(version)?.[1]
  if (!major) return 'not a stable Node release'
  const release = schedule[`v${major}`]
  if (!release || release.start > today) return 'not an officially released Node major'
  if (release.end <= today) return 'Node release has reached EOL'
  if (!Bun.semver.satisfies(version, required)) return `DSH requires Node ${required}`
}
