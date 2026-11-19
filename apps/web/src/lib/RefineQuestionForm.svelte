<script lang="ts">
  import type { RefineAnswerSet, RefineQuestionRound } from '@dashboard/shared';
  import Button from './Button.svelte';
  import {
    acceptAllRecommendations,
    draftIsSendable,
    draftToAnswerSet,
    emptyDraft,
    unansweredCount,
    type DraftAnswer,
  } from './refine-form-logic';

  // The structured-question form (PD-745, D-096 §4): a Refine round answered with clicks. Shared —
  // the ticket thread renders it now, and the Decisions inbox (PD-746) will render it per ticket.
  // `formId` namespaces the control ids so several forms can share a page.
  // The parent keys this component by round, so a new round always starts from an empty draft.
  const {
    round,
    formId,
    onSubmit,
  }: {
    round: RefineQuestionRound;
    formId: string | number;
    onSubmit: (answers: RefineAnswerSet) => Promise<void>;
  } = $props();

  // The round is fixed for this instance's lifetime (the parent re-keys on a new round), so reading
  // it once to seed the draft is intended.
  // svelte-ignore state_referenced_locally
  let draft = $state(emptyDraft(round));
  let sending = $state(false);
  let error = $state<string | null>(null);

  const remaining = $derived(unansweredCount(round, draft));
  const sendable = $derived(draftIsSendable(round, draft));

  function choose(questionId: string, answer: DraftAnswer) {
    draft.answers[questionId] = answer;
  }

  function otherText(questionId: string): string {
    const a = draft.answers[questionId];
    return a?.kind === 'other' ? a.text : '';
  }

  function toggleOverrule(i: number) {
    draft.overruled = draft.overruled.includes(i) ? draft.overruled.filter((x) => x !== i) : [...draft.overruled, i];
  }

  function acceptAll() {
    draft = acceptAllRecommendations(round, draft);
  }

  async function send() {
    if (!sendable || sending) return;
    sending = true;
    error = null;
    try {
      await onSubmit(draftToAnswerSet(round, draft));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      sending = false;
    }
  }

  const cid = (...parts: (string | number)[]) => `rq-${formId}-${parts.join('-')}`;
</script>

<form
  class="rq-form"
  aria-label="Questions from the Refine agent"
  onsubmit={(e) => {
    e.preventDefault();
    void send();
  }}
>
  {#each round.questions as q, qi (q.id)}
    {@const a = draft.answers[q.id]}
    <fieldset class="rq-question">
      <legend><span class="rq-num">{qi + 1}.</span> {q.question}</legend>
      <p class="rq-why">{q.why}</p>
      <div class="rq-options">
        {#each q.options as o, oi (oi)}
          <label class="rq-option" class:selected={a?.kind === 'choice' && a.index === oi} for={cid(q.id, oi)}>
            <input
              type="radio"
              id={cid(q.id, oi)}
              name={cid(q.id)}
              checked={a?.kind === 'choice' && a.index === oi}
              onchange={() => choose(q.id, { kind: 'choice', index: oi })}
            />
            <span class="rq-option-text">
              <span class="rq-option-label">
                {o.label}
                {#if oi === q.recommended}<span class="rq-rec">Recommended</span>{/if}
              </span>
              <span class="rq-option-desc">{o.description}</span>
            </span>
          </label>
        {/each}
        <label class="rq-option rq-other" class:selected={a?.kind === 'other'} for={cid(q.id, 'other')}>
          <input
            type="radio"
            id={cid(q.id, 'other')}
            name={cid(q.id)}
            checked={a?.kind === 'other'}
            onchange={() => choose(q.id, { kind: 'other', text: otherText(q.id) })}
          />
          <span class="rq-option-text">
            <span class="rq-option-label">Other</span>
            <input
              class="rq-other-input"
              type="text"
              id={cid(q.id, 'other-text')}
              aria-label="Other answer to: {q.question}"
              placeholder="Your own answer"
              value={otherText(q.id)}
              oninput={(e) => choose(q.id, { kind: 'other', text: e.currentTarget.value })}
            />
          </span>
        </label>
      </div>
    </fieldset>
  {/each}

  {#if round.assumptions.length > 0}
    <fieldset class="rq-assumptions">
      <legend>Assumptions the agent made</legend>
      <p class="rq-why">It settled these from the record instead of asking. Overrule any that are wrong.</p>
      <ul>
        {#each round.assumptions as asm, ai (ai)}
          <li class:overruled={draft.overruled.includes(ai)}>
            <label for={cid('asm', ai)}>
              <input type="checkbox" id={cid('asm', ai)} checked={draft.overruled.includes(ai)} onchange={() => toggleOverrule(ai)} />
              <span>
                <span class="rq-asm-text">{asm.text}</span>
                <span class="rq-asm-source">{asm.source}</span>
              </span>
              <span class="rq-asm-flag">{draft.overruled.includes(ai) ? 'Overruled' : 'Overrule'}</span>
            </label>
          </li>
        {/each}
      </ul>
    </fieldset>
  {/if}

  <label class="rq-note-label" for={cid('note')}>Anything else for the agent (optional)</label>
  <textarea id={cid('note')} class="rq-note" rows="2" bind:value={draft.note}></textarea>

  <div class="rq-actions">
    <Button variant="ghost" onclick={acceptAll} disabled={sending || remaining === 0}>Accept all recommendations</Button>
    <Button variant="primary" type="submit" disabled={!sendable || sending}>
      {sending ? 'Sending…' : 'Send answers'}
    </Button>
    <span class="rq-hint" role="status">
      {#if error}{error}{:else if remaining > 0}{remaining} of {round.questions.length} unanswered{/if}
    </span>
  </div>
</form>

<style lang="scss" src="./RefineQuestionForm.scss"></style>
