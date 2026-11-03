// SPDX-License-Identifier: LGPL-3.0-or-later
/** Mail configuration inside DSH's existing installed-plugin detail page. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { MailSettings } from '../settings.ts'
import type { MailStatus } from '../ui-types.ts'
import type { ConnectionCheck } from '../check.ts'
import remote from '../remote.ts'
import { MailPageController } from './controller.ts'
import { MailPage, MailToast } from './page.tsx'
import { en, zh, type MailLocaleKey } from './locales.ts'
import { style } from './style.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'plugins.mail': MailLocaleKey } }
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap { mailAutomation: { getStatus(): Promise<RemoteResult<MailStatus>>; checkConnection(accountId: string): Promise<RemoteResult<ConnectionCheck>> } }
}

/** Client services already provided by the standard DSH Web composition. */
export const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.credentials']

/** Register the page while its Host settings namespace is available.
 * @param ctx The browser plugin's Cordis context.
 */
export async function apply(ctx: Context): Promise<void> {
  ctx.effect(() => ctx.locale.register('plugins.mail', { en, zh }))
  ctx.effect(() => { const element = document.createElement('style'); element.dataset.plugin = 'dsh-mail'; element.textContent = style; document.head.appendChild(element); return () => element.remove() })
  const off = await ctx.remote.$mount(remote)
  ctx.effect(() => off)
  ctx.inject(['remote.mailAutomation'], ctx => {
    const page = new MailPageController(ctx.configForms.get<MailSettings>('mail-automation'), {
      describe: refs => ctx.remote.credentials.describe(refs), set: (ref, value) => ctx.remote.credentials.set(ref, value), unset: ref => ctx.remote.credentials.unset(ref),
      getStatus: () => ctx.remote.mailAutomation.getStatus(), checkConnection: id => ctx.remote.mailAutomation.checkConnection(id),
    })
    ctx.effect(() => () => page.dispose())
    ctx.effect(() => ctx.remote.$on('credentials/reference-updated', () => { void page.refreshCredentials() }))
    ctx.on('connection/reset', () => { void page.refresh(); void page.refreshCredentials() })
    ctx.effect(() => ctx.configForms.whileServed(['mail-automation'], () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
      name: 'plugins.row.config', key: 'dsh-mail#mail-automation', locale: 'plugins.mail', inject: () => page.face(),
    }, MailPage))))
    ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'mail-feedback', locale: 'plugins.mail', inject: () => page.face() }, MailToast)))
  })
}
