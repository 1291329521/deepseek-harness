/**
 * The terminology settings card: the master toggle, the explain chord, the
 * editable global layer, and the read-only project layer the workspace file
 * owns. Every value reaches the card through the published snapshot and every
 * edit leaves through an injected callback.
 */
import { useState } from 'react'
import clsx from 'clsx'
import type { KeyboardEvent } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { TerminologyCardInjected, TerminologyCardState } from './card-policy.ts'
import { NS } from './locales.ts'
import type { GlossaryTerm } from '../types.ts'
import css from './TerminologyCard.module.css'

/** Composed props of the keyed `settings.plugin.item` terminology entry. */
export type TerminologyCardProps = PropsRuntime<'settings.plugin.item'>
  & PropsLocale<typeof NS>
  & InjectFace<TerminologyCardInjected>

type Translate = TerminologyCardProps['t']

/** Locale copy for the card's last failed action, by its discriminant. */
function errorText(t: Translate, error: NonNullable<TerminologyCardState['error']>): string {
  if (error.kind === 'conflict') return t('card.terms.conflict')
  if (error.kind === 'shortcut') return t('card.shortcut.invalid')
  return t('card.project.openFailed')
}

/**
 * One editable global-layer row. The pair is held as a draft and committed on
 * blur or Enter, so one edit is one settings write.
 */
function TermRow({ entry, editable, t, onSave, onRemove }: {
  entry: GlossaryTerm
  editable: boolean
  t: Translate
  onSave: (term: string, explanation: string) => void
  onRemove: () => void
}) {
  const [term, setTerm] = useState(entry.term)
  const [explanation, setExplanation] = useState(entry.explanation)
  const commit = (): void => {
    const next = { term: term.trim(), explanation: explanation.trim() }
    if (next.term === '' || next.explanation === '') return
    if (next.term === entry.term && next.explanation === entry.explanation) return
    onSave(next.term, next.explanation)
  }
  const onEnter = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') event.currentTarget.blur()
  }
  return (
    <div className={css.termRow}>
      <Input
        className={clsx(css.term)}
        aria-label={t('card.terms.term')}
        value={term}
        disabled={!editable}
        onChange={(event) => { setTerm(event.target.value) }}
        onBlur={commit}
        onKeyDown={onEnter}
      />
      <Input
        className={clsx(css.explanation)}
        aria-label={t('card.terms.explanation')}
        value={explanation}
        disabled={!editable}
        onChange={(event) => { setExplanation(event.target.value) }}
        onBlur={commit}
        onKeyDown={onEnter}
      />
      <Button variant="ghost" size="sm" disabled={!editable} onClick={onRemove}>
        {t('card.terms.remove')}
      </Button>
    </div>
  )
}

/**
 * Render the terminology settings card.
 * @param props - the published card snapshot, the write callbacks, and the dictionary.
 * @returns the card, or nothing while the namespace is not served.
 */
export function TerminologyCard(props: TerminologyCardProps) {
  const card = props.useTerminologyCard(state => state)
  const [draft, setDraft] = useState<GlossaryTerm>({ term: '', explanation: '' })
  if (!card.ready) return null
  const editable = card.writable
  const draftReady = draft.term.trim() !== '' && draft.explanation.trim() !== ''
  return (
    <section className={css.card}>
      <h3 className={css.title}>{props.t('card.title')}</h3>
      {card.error !== undefined && <p role="alert" className={css.error}>{errorText(props.t, card.error)}</p>}
      <label className={css.row}>
        <input
          type="checkbox"
          checked={card.enabled}
          disabled={!editable}
          onChange={(event) => { props.setEnabled(event.target.checked) }}
        />
        {props.t('card.enabled')}
      </label>
      <div className={css.row}>
        <span className={css.fieldLabel}>{props.t('card.shortcut')}</span>
        <Input
          className={clsx(css.field)}
          aria-label={props.t('card.shortcut')}
          key={`shortcut:${card.shortcut}`}
          defaultValue={card.shortcut}
          disabled={!editable}
          onBlur={(event) => { props.setShortcut(event.target.value) }}
        />
      </div>

      <fieldset className={css.group}>
        <legend className={css.groupTitle}>{props.t('card.terms.title')}</legend>
        {card.globalTerms.length === 0 && <p className={css.empty}>{props.t('card.terms.empty')}</p>}
        {card.globalTerms.map((entry, index) => (
          <TermRow
            // Keyed by content: a write that lands reseeds the row from what
            // the Host holds, and another client's edit replaces the draft.
            key={`term:${index}:${entry.term}:${entry.explanation}`}
            entry={entry}
            editable={editable}
            t={props.t}
            onSave={(term, explanation) => { props.updateTerm(index, term, explanation) }}
            onRemove={() => { props.removeTerm(index) }}
          />
        ))}
        <div className={css.termRow}>
          <Input
            className={clsx(css.term)}
            aria-label={props.t('card.terms.newTerm')}
            placeholder={props.t('card.terms.term')}
            value={draft.term}
            disabled={!editable}
            onChange={(event) => { setDraft(current => ({ ...current, term: event.target.value })) }}
          />
          <Input
            className={clsx(css.explanation)}
            aria-label={props.t('card.terms.newExplanation')}
            placeholder={props.t('card.terms.explanation')}
            value={draft.explanation}
            disabled={!editable}
            onChange={(event) => { setDraft(current => ({ ...current, explanation: event.target.value })) }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!editable || !draftReady}
            onClick={() => {
              props.addTerm(draft.term.trim(), draft.explanation.trim())
              setDraft({ term: '', explanation: '' })
            }}
          >
            {props.t('card.terms.add')}
          </Button>
        </div>
      </fieldset>

      <fieldset className={css.group}>
        <legend className={css.groupTitle}>{props.t('card.project.title')}</legend>
        {card.projectError !== undefined && (
          <p role="alert" className={css.error}>{props.t('card.project.error', { message: card.projectError })}</p>
        )}
        {card.projectTerms.length === 0 && <p className={css.empty}>{props.t('card.project.empty')}</p>}
        <ul className={css.projectList}>
          {card.projectTerms.map(entry => (
            <li className={css.termRow} key={entry.term}>
              <span className={css.term}>{entry.term}</span>
              <span className={css.explanation}>{entry.explanation}</span>
            </li>
          ))}
        </ul>
        <p className={css.note}>{props.t('card.project.readonly')}</p>
        <p className={css.path}>{card.projectPath}</p>
        <Button variant="outline" size="sm" onClick={props.openProjectFile}>
          {props.t('card.project.open')}
        </Button>
      </fieldset>
    </section>
  )
}
