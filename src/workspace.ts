// SPDX-License-Identifier: LGPL-3.0-or-later
/** Workspace selection from authenticated email metadata and persisted task inputs. */
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { load, JSON_SCHEMA } from 'js-yaml'
import { z } from 'zod'
import type { Rule } from './config.ts'
import { MailError, type Mail, type TaskRecord } from './types.ts'

const metadataSchema = z.strictObject({ workspace: z.string().min(1).refine(value => isAbsolute(value) && !/[\r\n\0]/.test(value)) })

/**
 * Resolve an existing directory without creating directories or restricting roots.
 * @param requested - absolute path provided by the message or legacy rule.
 * @returns the directory's canonical path.
 */
export async function canonicalWorkspace(requested: string): Promise<string> {
  if (!isAbsolute(requested) || /[\r\n\0]/.test(requested)) throw new MailError('workspace-must-be-absolute')
  try {
    const path = await realpath(requested)
    if (!(await stat(path)).isDirectory()) throw new MailError('workspace-not-directory')
    return path
  } catch (error) {
    if (error instanceof MailError) throw error
    throw new MailError('workspace-unavailable', false, { cause: error })
  }
}

/**
 * Parse leading YAML metadata after sender authentication; the remaining body is task text.
 * @param mail - complete authenticated message.
 * @param rule - rule supplying an optional default directory.
 * @param maxMetadataBytes - deployment's task-input byte budget.
 * @returns the canonical workspace and message with its metadata removed.
 */
export async function emailWorkspace(mail: Mail, rule: Rule, maxMetadataBytes: number): Promise<{ workspacePath: string; mail: Mail }> {
  const body = mail.body.replace(/\r\n/g, '\n')
  let requested = rule.task.workspacePath
  let taskMail = mail
  if (body.split('\n', 1)[0] === '---') {
    const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(body)
    if (!match || !match[1] || Buffer.byteLength(match[1]) > maxMetadataBytes) throw new MailError('workspace-metadata-invalid')
    try {
      const metadata = metadataSchema.parse(load(match[1], { schema: JSON_SCHEMA }))
      requested = metadata.workspace
    } catch (error) { throw new MailError('workspace-metadata-invalid', false, { cause: error }) }
    taskMail = { ...mail, body: body.slice(match[0].length).replace(/^\n/, '') }
  }
  if (!requested) throw new MailError('workspace-required')
  return { workspacePath: await canonicalWorkspace(requested), mail: taskMail }
}

/**
 * Read the selected directory, retaining compatibility with fixed-directory task records.
 * @param task - durable task, including pre-selection records.
 * @returns the selected directory or the legacy rule's explicit directory.
 */
export function taskWorkspace(task: TaskRecord): string {
  if (task.workspacePath !== undefined) return task.workspacePath
  if (task.rule.task.workspacePath !== undefined) return task.rule.task.workspacePath
  throw new MailError('task-workspace-missing')
}
