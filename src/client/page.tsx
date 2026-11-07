// SPDX-License-Identifier: LGPL-3.0-or-later
/** Guided internal-mail setup with optional connection and automation controls. */
import { Button, SettingsForm, SettingsValueField, SettingsSecretField, Switch, Tag, Toast, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState } from 'react'
import { validIntegerText } from '../config-schema.ts'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MailPageFace } from './controller.ts'
import type { MailLocaleKey } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

type PageProps = PropsRuntime<'plugins.row.config'> & PropsLocale<'plugins.mail'> & InjectFace<MailPageFace>

/** @param props Framework-bound configuration and actions. @returns Mailbox setup and its optional controls. */
export function MailPage(props: PageProps) {
  const { t } = props
  const state = props.useMailPage(value => value)
  useEffect(() => props.view === 'page' ? props.watchStatus() : undefined, [props.view])
  const draft = state.draft
  const account = draft?.accounts.find(value => value.id === state.accountId)
  const rules = draft?.rules.filter(value => value.account === account?.id) ?? []
  const rule = rules.find(value => value.id === state.ruleId) ?? rules[0]
  const policy = rule ? draft?.senderPolicies[rule.authorization.policy] : undefined
  const body = `---\nworkspace: ${rule?.task.workspacePath ?? t('examplePath')}\n---\n${rule?.match.bodyContains ? `${rule.match.bodyContains}\n` : ''}${t('exampleBody')}`
  const [copy, setCopy] = useState<{ body: string; ok: boolean }>()
  const copyBody = async (): Promise<void> => {
    try { setCopy({ body, ok: await writeClipboard(body) }) }
    catch (_error) { setCopy({ body, ok: false }) }
  }
  if (props.view === 'summary') return t('description')
  const disabled = !state.writable || state.saving || state.connecting
  const primaryConnection = account?.receive ?? account?.send
  const password = primaryConnection ? state.credentials[primaryConnection.auth.credentialRef] : undefined
  const incomplete = state.incomplete.map(key => t(key))
  const ready = incomplete.length === 0 && Boolean(rule) && !state.invalid
  const running = state.status?.phase === 'running'
  const pausing = running && draft?.enabled === false
  const subject = [rule?.match.subjectPrefix, rule?.match.subjectContains, t('exampleSubject')].filter(Boolean).join(' ')
  const field = (id: string, label: MailLocaleKey, value: string | number, edit: (text: string) => void, numeric = false, hint?: string) => (
    <div key={id} className="mail-field"><SettingsValueField id={`dsh-mail-${id}`} label={t(label)} text={state.fields[id] ?? String(value)} numeric={numeric}
      disabled={disabled} invalid={numeric && state.fields[id] !== undefined && !validIntegerText(state.fields[id]!)}
      {...hint ? { hint } : {}} invalidLabel={t('invalid')} overridden={false} overriddenLabel={t('overridden')} resetLabel={t('reset')} onEdit={edit} onReset={() => edit(String(value))} /></div>
  )
  const accountField = (key: string, label: MailLocaleKey, value: string | number, numeric = false, hint?: string) => field(`account.${account!.id}.${key}`, label, value, text => props.editAccount(key, text), numeric, hint)
  const ruleField = (key: string, label: MailLocaleKey, value: string | number, numeric = false, hint?: string) => field(`rule.${rule!.id}.${key}`, label, value, text => props.editRule(key, text), numeric, hint)
  const options = (label: MailLocaleKey, value: string, choices: readonly { id: string; label: string }[], edit: (text: string) => void) => (
    <label className="mail-control"><span>{t(label)}</span><select disabled={disabled} value={value} onChange={event => edit(event.target.value)}>{choices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}</select></label>
  )
  const secret = (ref: string | undefined, id: string, label: MailLocaleKey) => {
    const value = ref ? state.credentials[ref] : undefined
    return <div className="mail-field"><SettingsSecretField id={id} label={t(label)} hint={value?.remove ? t('codeWillRemove') : !account ? t('passwordFirst') : t('codeHint')}
      text={value?.text ?? ''} configured={value?.configured ?? false} disabled={disabled || !value?.ready || !value.writable}
      stateLabel={t(!account ? 'codeUnset' : !value?.ready ? 'codeLoading' : value.configured ? 'codeSet' : 'codeUnset')}
      onEdit={text => { if (ref) props.editCredential(ref, text) }} /></div>
  }
  const checkedAccount = draft?.accounts.find(value => value.id === state.checkAccountId)
  return <div className="dsh-mail"><SettingsForm
    state={{ ...state, saving: state.saving || state.connecting, invalid: !ready || !state.writable, dirty: state.dirty || !running }}
    labels={{ unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t(pausing ? 'savePause' : running ? 'save' : 'saveStart'), saving: t(state.connecting ? 'connecting' : 'saving') }}
    onSave={pausing ? props.save : props.start} onDiscard={props.discard}>
    <div className="mail-stack">
      <div className="mail-summary" role="status"><div className="mail-row"><Tag tone={running ? 'success' : 'neutral'}>{t(state.status?.phase ?? 'paused')}</Tag>
        <Button size="sm" disabled={state.connecting} onClick={props.refresh}>{t('refresh')}</Button></div>
        {running && <p className="mail-hint">{t('runningHint')}</p>}
        {Object.values(state.status?.health ?? {}).some(value => value !== 'healthy') && <p className="mail-hint">{t('healthFailed')}</p>}
      </div>
      <section className="mail-section" aria-label={t('connectTitle')}>
        <header className="mail-section-heading"><span className="mail-number" aria-hidden="true">1</span><div><h3>{t('connectTitle')}</h3><p className="mail-hint">{t('connectHint')}</p></div></header>
        {draft && draft.accounts.length > 1 && options('accounts', state.accountId, draft.accounts.map(value => ({ id: value.id, label: value.address || value.id })), props.selectAccount)}
        <div className="mail-grid">
          {field('setup-address', 'address', account?.address ?? '', text => props.editSetup('address', text))}
          {field('setup-server', state.separateServers ? 'incomingServer' : 'mailServer', primaryConnection?.host ?? '', text => props.editSetup('server', text))}
        </div>
        <p className="mail-hint">{t('serverHint')}</p>
        {secret(primaryConnection?.auth.credentialRef, 'mail-setup-password', 'password')}
        <details><summary>{t('connectionOptions')}</summary><div className="mail-stack">
          {account ? <>
            {options('mode', account.receive && account.send ? 'both' : account.receive ? 'receive' : 'send', [{ id: 'both', label: t('both') }, { id: 'receive', label: t('receiveOnly') }, { id: 'send', label: t('sendOnly') }], text => props.editAccount('mode', text))}
            {account.receive && account.send && <>
              <div className="mail-row"><span>{t('sameServer')}</span><Switch label={t('sameServer')} checked={!state.separateServers} disabled={disabled} onChange={checked => props.setSeparateServers(!checked)} /></div>
              {state.separateServers && accountField('send.host', 'outgoingServer', account.send.host)}
            </>}
            {account.receive && options('receiveProtocol', account.receive.protocol, [{ id: 'imap', label: 'IMAP' }, { id: 'pop3', label: 'POP3' }], text => props.editAccount('receive.protocol', text))}
            <div className="mail-grid">{(['receive', 'send'] as const).map(side => {
              const connection = account[side]
              if (!connection) return null
              return <section key={side}><h3>{t(side)}</h3>
                <div className="mail-grid">{accountField(`${side}.port`, 'port', connection.port, true)}
                  {options('tls', connection.tls, [{ id: 'direct', label: t('direct') }, { id: 'starttls', label: t('starttls') }], text => props.editAccount(`${side}.tls`, text))}</div>
                {accountField(`${side}.user`, 'user', connection.auth.user, false, t('loginHint'))}
                <label className="mail-control"><span>{t('caCertificate')}</span><textarea aria-label={t('caCertificate')} disabled={disabled} value={connection.ca ?? ''} onChange={event => props.editAccount(`${side}.ca`, event.target.value)} /></label>
              </section>
            })}</div>
            <p className="mail-hint">{t('caHint')}</p>
            {account.receive && account.send && <>
              <div className="mail-row"><span>{t('sharedCode')}</span><Switch label={t('sharedCode')} checked={account.receive.auth.credentialRef === account.send.auth.credentialRef} disabled={disabled} onChange={checked => props.editAccount('sharedCredential', String(checked))} /></div>
              {account.receive.auth.credentialRef !== account.send.auth.credentialRef && secret(account.send.auth.credentialRef, 'mail-outgoing-password', 'outgoingCode')}
            </>}
            {password?.configured && primaryConnection && <div><Button size="sm" disabled={disabled || !password.writable} onClick={() => props.removeCredential(primaryConnection.auth.credentialRef)}>{t(password.remove ? 'undoRemoveCode' : 'removeCode')}</Button></div>}
            {account.receive?.protocol === 'imap' && accountField('receive.folders', 'folders', account.receive.folders.join(', '))}
            {account.receive?.protocol === 'pop3' && <p className="mail-hint">{t('pop3Hint')}</p>}
            <div><Button variant="outline" size="sm" disabled={state.dirty || state.checking || disabled} onClick={props.checkConnection}>{t(state.checking ? 'checking' : 'check')}</Button></div>
          </> : <p className="mail-hint">{t('passwordFirst')}</p>}
        </div></details>
        {state.check && <div className="mail-connection-result" role="status">
          {draft && draft.accounts.length > 1 && <span>{checkedAccount?.address}</span>}
          <span>{t('receiveShort')}: {t(state.check.pop3 ?? state.check.imap)}</span><span>{t('sendShort')}: {t(state.check.smtp)}</span>
          {(state.check.imap === 'failed' || state.check.pop3 === 'failed' || state.check.smtp === 'failed') && <p className="mail-hint">{t('connectionFailedHint')}</p>}
        </div>}
      </section>
      <section className="mail-section" aria-label={t('senderTitle')}>
        <header className="mail-section-heading"><span className="mail-number" aria-hidden="true">2</span><div><h3>{t('senderTitle')}</h3><p className="mail-hint">{t('senderHint')}</p></div></header>
        {rules.length > 1 && options('rules', rule?.id ?? '', rules.map((value, index) => ({ id: value.id, label: `${t('ruleLabel')} ${index + 1}` })), props.selectRule)}
        {field('setup-sender', 'yourAddress', state.fields['setup-sender'] ?? rule?.authorization.allowedSenders.join(', ') ?? '', text => props.editSetup('sender', text))}
        {rule?.reply.to && <p className="mail-hint">{t('replyDestination')} <strong>{rule.reply.to}</strong></p>}
        {(!rule || !rule.task.agentPreset && !rule.task.model) && <p className="mail-hint">{t('inheritDsh')}</p>}
        <p className="mail-hint">{t(!rule || rule.task.permissionPreset === 'danger-full-access' ? 'permissionHint' : 'customPermissionHint')}</p>
        <details><summary>{t('automationOptions')}</summary><div className="mail-stack">
          {rule && draft ? <>
            <div className="mail-grid">{ruleField('subjectPrefix', 'subjectPrefix', rule.match.subjectPrefix ?? '')}{ruleField('replyTo', 'replyTo', rule.reply.to)}</div>
            <div className="mail-grid">{options('receiveAccount', rule.account, draft.accounts.filter(value => value.receive).map(value => ({ id: value.id, label: value.address || value.id })), text => props.editRule('account', text))}
              {options('replyAccount', rule.reply.account, draft.accounts.filter(value => value.send).map(value => ({ id: value.id, label: value.address || value.id })), text => props.editRule('replyAccount', text))}</div>
            <div className="mail-grid">{ruleField('subjectContains', 'subjectContains', rule.match.subjectContains ?? '')}{ruleField('bodyContains', 'bodyContains', rule.match.bodyContains ?? '')}</div>
            {options('policy', rule.authorization.policy, Object.keys(draft.senderPolicies).map(id => ({ id, label: id })), text => props.editRule('policy', text))}
            {options('verification', policy?.evidence ?? 'local-signature', [{ id: 'local-signature', label: t('signature') }, { id: 'trusted-mta', label: t('trustedMta') }], text => props.editRule('evidence', text))}
            {policy?.evidence === 'local-signature' && ruleField('trustedSenders', 'trustedSenders', policy.trustedSenders?.join(', ') ?? '', false, t('trustedSendersHint'))}
            {policy?.evidence === 'trusted-mta' && <>{ruleField('authservIds', 'authservIds', policy.authservIds.join(', '))}<p className="mail-hint">{t('trustedHint')}</p></>}
            <div className="mail-grid">{ruleField('agentPreset', 'agentPreset', rule.task.agentPreset ?? '', false, `${t('agentPresetHint')}${state.status?.defaultAgentPreset ? ` (${state.status.defaultAgentPreset})` : ''}`)}{ruleField('permissionPreset', 'permissionPreset', rule.task.permissionPreset)}
              {ruleField('timeoutMs', 'timeoutMs', rule.task.timeoutMs, true)}{ruleField('maxSteps', 'maxSteps', rule.task.maxSteps, true)}</div>
            <label className="mail-control"><span>{t('template')}</span><textarea disabled={disabled} value={draft.templates[rule.task.template] ?? ''} onChange={event => props.editRule('template', event.target.value)} /></label>
            <div className="mail-row"><span>{t('attachments')}</span><Switch label={t('attachments')} checked={rule.task.attachmentTypes.length > 0} disabled={disabled} onChange={checked => props.editRule('attachments', String(checked))} /></div>
          </> : <p className="mail-hint">{t('senderFirst')}</p>}
        </div></details>
      </section>
      <section className="mail-section" aria-label={t('notificationsTitle')}>
        <div className="mail-row"><h3>{t('notificationsTitle')}</h3><Switch label={t('notificationsTitle')} checked={draft?.notifications.enabled ?? false} disabled={disabled || !draft?.rules.length} onChange={props.setNotifications} /></div>
        <p className="mail-hint">{t('notificationsHint')}</p>
        {draft?.notifications.enabled && <p className="mail-hint">{t('replyDestination')} <strong>{(draft.rules.find(rule => rule.id === draft.notifications.rule) ?? draft.rules[0])?.reply.to}</strong></p>}
      </section>
      <section className="mail-section" aria-label={t('useTitle')}>
        <header className="mail-section-heading"><span className="mail-number" aria-hidden="true">3</span><div><h3>{t('useTitle')}</h3><p className="mail-hint">{t('useHint')}</p></div></header>
        <dl className="mail-addresses"><dt>{t('exampleTo')}</dt><dd>{(rule?.match.to ?? account?.address) || t('exampleMailbox')}</dd><dt>{t('exampleSubjectLabel')}</dt><dd>{subject}</dd></dl>
        <div className="mail-example"><div className="mail-row"><span>{t('exampleBodyLabel')}</span><Button size="sm" onClick={copyBody}>{t(copy?.body === body && copy.ok ? 'copied' : 'copyBody')}</Button></div><pre tabIndex={0}>{body}</pre>{copy?.body === body && !copy.ok && <p className="mail-hint" role="status">{t('copyFailed')}</p>}</div>
        <p className="mail-hint">{t('workspaceHint')}</p><p className="mail-hint">{t('conversationHint')}</p>
      </section>
      <details className="mail-more"><summary>{t('manageOptions')}</summary><div className="mail-stack">
        <div className="mail-row"><Button size="sm" disabled={disabled} onClick={props.addAccount}>{t('addAccount')}</Button><Button size="sm" disabled={disabled || !account} onClick={props.removeAccount}>{t('removeAccount')}</Button></div>
        <div className="mail-row"><Button size="sm" disabled={disabled || !account?.receive} onClick={props.addRule}>{t('addRule')}</Button><Button size="sm" disabled={disabled || !rule} onClick={props.removeRule}>{t('removeRule')}</Button></div>
        {draft && <div className="mail-grid">{field('maxReplyBytes', 'maxReplyBytes', draft.runtime.maxReplyBytes, text => props.editSetting('maxReplyBytes', text), true)}{field('maxConcurrentTasks', 'maxConcurrentTasks', draft.runtime.maxConcurrentTasks, text => props.editSetting('maxConcurrentTasks', text), true)}</div>}
        <div className="mail-row"><span>{t('enabled')}</span><Switch checked={draft?.enabled ?? false} label={t('enabled')} disabled={disabled || !ready} onChange={props.setEnabled} /></div>
        <div><Button size="sm" disabled={disabled || !state.dirty || state.invalid} onClick={props.save}>{t('saveOnly')}</Button></div>
      </div></details>
      {!ready && <p className="mail-hint" role="status">{incomplete.length ? `${t('stillNeeded')} ${incomplete.join(t('listSeparator'))}` : t('invalid')}</p>}
      {running && state.dirty && <p className="mail-hint">{t('enabledHint')}</p>}
    </div>
  </SettingsForm></div>
}

type ToastProps = PropsRuntime<'shell.overlay'> & PropsLocale<'plugins.mail'> & InjectFace<MailPageFace>
/** @param props Application-lifetime feedback source. @returns A portal toast that survives leaving the form. */
export function MailToast(props: ToastProps) {
  const toast = props.useMailPage(state => state.toast)
  return toast ? <Toast key={toast.id} text={props.t(toast.message)} {...toast.success ? { tone: 'success' as const } : {}} onDone={props.dismissToast} /> : null
}
