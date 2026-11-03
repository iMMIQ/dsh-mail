// SPDX-License-Identifier: LGPL-3.0-or-later
/** Mail settings rendered entirely from the registration's data and callbacks. */
import { Button, SettingsForm, SettingsValueField, SettingsSecretField, Switch, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MailPageFace } from './controller.ts'
import type { MailLocaleKey } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

type PageProps = PropsRuntime<'plugins.row.config'> & PropsLocale<'plugins.mail'> & InjectFace<MailPageFace>

/** @param props Framework-bound form state and actions. @returns The mailbox and rule editor. */
export function MailPage(props: PageProps) {
  const { t } = props
  const state = props.useMailPage(value => value)
  useEffect(() => props.view === 'page' ? props.watchStatus() : undefined, [])
  if (props.view === 'summary') return t('description')
  const draft = state.draft
  const disabled = !state.writable || state.saving
  const account = draft?.accounts.find(value => value.id === state.accountId)
  const rule = draft?.rules.find(value => value.id === state.ruleId)
  const policy = rule ? draft?.senderPolicies[rule.authorization.policy] : undefined
  const field = (id: string, label: MailLocaleKey, value: string | number, edit: (text: string) => void, numeric = false) => (
    <SettingsValueField key={id} id={`dsh-mail-${id}`} label={t(label)} text={state.fields[id] ?? String(value)} numeric={numeric}
      disabled={disabled} invalid={numeric && state.fields[id] !== undefined && (!/^\d+$/.test(state.fields[id]!) || Number(state.fields[id]) < 1)}
      invalidLabel={t('invalid')} overridden={false} overriddenLabel={t('overridden')} resetLabel={t('reset')} onEdit={edit} onReset={() => edit(String(value))} />
  )
  const accountField = (key: string, label: MailLocaleKey, value: string | number, numeric = false) => field(`account.${account!.id}.${key}`, label, value, text => props.editAccount(key, text), numeric)
  const ruleField = (key: string, label: MailLocaleKey, value: string | number, numeric = false) => field(`rule.${rule!.id}.${key}`, label, value, text => props.editRule(key, text), numeric)
  const options = (label: MailLocaleKey, value: string, choices: readonly { id: string; label: string }[], edit: (text: string) => void) => (
    <label className="mail-control"><span>{t(label)}</span><select disabled={disabled} value={value} onChange={event => edit(event.target.value)}>{choices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}</select></label>
  )
  return <div className="dsh-mail"><SettingsForm state={state} labels={{ unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }} onSave={props.save} onDiscard={props.discard}>
    <div className="mail-stack">
      <div className="mail-row"><span>{t('enabled')}</span><Switch checked={draft?.enabled ?? false} label={t('enabled')} disabled={disabled} onChange={props.setEnabled} /></div>
      <p className="mail-hint">{t('enabledHint')}</p>
      <div className="mail-status" role="status"><div className="mail-row"><span>{t(state.status?.phase ?? 'paused')}</span><Button size="sm" onClick={props.refresh}>{t('refresh')}</Button></div>
        {Object.entries(state.status?.health ?? {}).map(([name, status]) => <span key={name}>{name}: {status === 'healthy' ? t('ok') : t('failed')}</span>)}
      </div>
      <section><div className="mail-row"><h3>{t('accounts')}</h3><Button size="sm" disabled={disabled} onClick={props.addAccount}>{t('addAccount')}</Button></div>
        {draft?.accounts.length ? options('accounts', state.accountId, draft.accounts.map(value => ({ id: value.id, label: value.address || value.id })), props.selectAccount) : <p className="mail-hint">{t('emptyAccounts')}</p>}
        {account && <div className="mail-stack">
          {accountField('address', 'address', account.address)}
          {options('mode', account.receive && account.send ? 'both' : account.receive ? 'receive' : 'send', [{ id: 'both', label: t('both') }, { id: 'receive', label: t('receiveOnly') }, { id: 'send', label: t('sendOnly') }], text => props.editAccount('mode', text))}
          <div className="mail-grid">{(['receive', 'send'] as const).map(side => {
            const connection = account[side]
            if (!connection) return null
            const secret = state.credentials[connection.auth.credentialRef]
            const shared = side === 'send' && account.receive?.auth.credentialRef === connection.auth.credentialRef
            return <section key={side}><h3>{t(side)}</h3>
              {accountField(`${side}.host`, 'host', connection.host)}
              <div className="mail-grid">{accountField(`${side}.port`, 'port', connection.port, true)}
                {options('tls', connection.tls, [{ id: 'direct', label: t('direct') }, { id: 'starttls', label: t('starttls') }], text => props.editAccount(`${side}.tls`, text))}</div>
              {accountField(`${side}.user`, 'user', connection.auth.user)}
              {side === 'send' && account.receive && <div className="mail-row"><span>{t('sharedCode')}</span><Switch label={t('sharedCode')} checked={shared} disabled={disabled} onChange={checked => props.editAccount('sharedCredential', String(checked))} /></div>}
              {!shared && <SettingsSecretField id={`mail-${account.id}-${side}-code`} label={t('authorizationCode')} hint={secret?.remove ? t('codeWillRemove') : t('codeHint')} text={secret?.text ?? ''}
                configured={secret?.configured ?? false} disabled={disabled || !secret?.ready || !secret.writable} stateLabel={t(!secret?.ready ? 'codeLoading' : secret.configured ? 'codeSet' : 'codeUnset')}
                onEdit={text => props.editCredential(connection.auth.credentialRef, text)} />}
              {!shared && (secret?.configured || secret?.remove) && <Button size="sm" disabled={disabled || !secret.writable} onClick={() => props.removeCredential(connection.auth.credentialRef)}>{t(secret.remove ? 'undoRemoveCode' : 'removeCode')}</Button>}
            </section>
          })}</div>
          {account.receive && accountField('receive.folders', 'folders', account.receive.folders.join(', '))}
          <div className="mail-row"><Button variant="outline" size="sm" disabled={state.dirty || state.checking || state.saving} onClick={props.checkConnection}>{t(state.checking ? 'checking' : 'check')}</Button>
            <Button size="sm" disabled={disabled} onClick={props.removeAccount}>{t('removeAccount')}</Button></div>
          <p className="mail-hint">{t('checkHint')}</p>
          {state.check && <div className="mail-status" role="status"><span>{t('receive')}: {t(state.check.imap)}</span><span>{t('send')}: {t(state.check.smtp)}</span></div>}
        </div>}
      </section>
      <section><div className="mail-row"><h3>{t('rules')}</h3><Button size="sm" disabled={disabled || !draft?.accounts.length} onClick={props.addRule}>{t('addRule')}</Button></div>
        {draft?.rules.length ? options('rules', state.ruleId, draft.rules.map(value => ({ id: value.id, label: value.id })), props.selectRule) : <p className="mail-hint">{t('emptyRules')}</p>}
        {rule && draft && <div className="mail-stack">
          <div className="mail-grid">{options('receiveAccount', rule.account, draft.accounts.map(value => ({ id: value.id, label: value.address || value.id })), text => props.editRule('account', text))}
            {options('replyAccount', rule.reply.account, draft.accounts.map(value => ({ id: value.id, label: value.address || value.id })), text => props.editRule('replyAccount', text))}</div>
          {ruleField('allowedSenders', 'allowedSenders', rule.authorization.allowedSenders.join(', '))}
          <div className="mail-grid">{ruleField('subjectPrefix', 'subjectPrefix', rule.match.subjectPrefix ?? '')}{ruleField('replyTo', 'replyTo', rule.reply.to)}</div>
          <details><summary>{t('advanced')}</summary><div className="mail-stack">
            <div className="mail-grid">{ruleField('subjectContains', 'subjectContains', rule.match.subjectContains ?? '')}{ruleField('bodyContains', 'bodyContains', rule.match.bodyContains ?? '')}</div>
            {options('policy', rule.authorization.policy, Object.keys(draft.senderPolicies).map(id => ({ id, label: id })), text => props.editRule('policy', text))}
            {options('verification', draft.senderPolicies[rule.authorization.policy]?.evidence ?? 'local-signature', [{ id: 'local-signature', label: t('signature') }, { id: 'trusted-mta', label: t('trustedMta') }], text => props.editRule('evidence', text))}
            {policy?.evidence === 'trusted-mta' && <>
              {ruleField('authservIds', 'authservIds', policy.authservIds.join(', '))}
              <p className="mail-hint">{t('trustedHint')}</p></>}
            <div className="mail-grid">{ruleField('agentPreset', 'agentPreset', rule.task.agentPreset)}{ruleField('permissionPreset', 'permissionPreset', rule.task.permissionPreset)}
              {ruleField('timeoutMs', 'timeoutMs', rule.task.timeoutMs, true)}{ruleField('maxSteps', 'maxSteps', rule.task.maxSteps, true)}</div>
            <label className="mail-control"><span>{t('template')}</span><textarea disabled={disabled} value={draft.templates[rule.task.template] ?? ''} onChange={event => props.editRule('template', event.target.value)} /></label>
            <div className="mail-row"><span>{t('attachments')}</span><Switch label={t('attachments')} checked={rule.task.attachmentTypes.length > 0} disabled={disabled} onChange={checked => props.editRule('attachments', String(checked))} /></div>
          </div></details>
          <div><Button size="sm" disabled={disabled} onClick={props.removeRule}>{t('removeRule')}</Button></div>
        </div>}
      </section>
      {draft && <details><summary>{t('advanced')}</summary><div className="mail-stack">
        <div className="mail-grid">{field('maxReplyBytes', 'maxReplyBytes', draft.runtime.maxReplyBytes, text => props.editSetting('maxReplyBytes', text), true)}
          {field('maxConcurrentTasks', 'maxConcurrentTasks', draft.runtime.maxConcurrentTasks, text => props.editSetting('maxConcurrentTasks', text), true)}</div></div></details>}
      {state.invalid && <p className="mail-hint" role="status">{t('invalid')}</p>}
    </div>
  </SettingsForm></div>
}

type ToastProps = PropsRuntime<'shell.overlay'> & PropsLocale<'plugins.mail'> & InjectFace<MailPageFace>
/** @param props Application-lifetime feedback source. @returns A portal toast that survives leaving the form. */
export function MailToast(props: ToastProps) {
  const toast = props.useMailPage(state => state.toast)
  return toast ? <Toast key={toast.id} text={props.t(toast.message)} {...toast.success ? { tone: 'success' as const } : {}} onDone={props.dismissToast} /> : null
}
