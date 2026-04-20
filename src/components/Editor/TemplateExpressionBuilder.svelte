<script lang="ts">
  // Visual builder for `{{ … }}` template expressions (#301). Opens from the
  // editor's right-click menu. The user composes a chain of members driven
  // by `vaultApiDescriptor.ts`; the live preview at the bottom shows the
  // expression the evaluator will see.
  //
  // Stays deliberately compact: one `<select>` per chain step, an inline
  // condition row for lambda-taking methods, Cancel / Insert buttons. No
  // arbitrary JS. Matches `UrlInputModal.svelte` visually so it feels native.

  import { tick } from "svelte";
  import {
    emptyChain,
    addStep,
    setStepLambda,
    removeStepsFrom,
    chainTypeAt,
    renderExpression,
    wrapAsTemplate,
    type BuilderChain,
    type BinaryOp,
    type LiteralKind,
  } from "../../lib/templateExpressionBuilder";
  import {
    membersOf,
    collectionElementType,
    type MemberDescriptor,
    type TypeRef,
  } from "../../lib/vaultApiDescriptor";

  interface Props {
    open: boolean;
    /** Frontmatter keys drawn from the active document, surfaced in the
     *  lambda's property picker so users can reach `n.property.<key>`
     *  without typing. Empty array is fine (free-text fallback). */
    dynamicPropertyKeys?: readonly string[];
    onInsert: (dsl: string) => void;
    onCancel: () => void;
  }

  let { open, dynamicPropertyKeys = [], onInsert, onCancel }: Props = $props();

  let chain = $state<BuilderChain>(emptyChain());
  let firstSelectEl = $state<HTMLSelectElement | undefined>();

  $effect(() => {
    if (open) {
      chain = emptyChain();
      void tick().then(() => firstSelectEl?.focus());
    }
  });

  function handleKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }

  function elementNameAt(type: TypeRef): TypeRef {
    return collectionElementType(type) ?? type;
  }

  function availableMembersAt(position: number): MemberDescriptor[] {
    const type = chainTypeAt(chain, position - 1);
    if (type === null) return [];
    return membersOf(type);
  }

  function labelFor(member: MemberDescriptor): string {
    return member.kind === "method" ? `${member.name}()` : member.name;
  }

  function pickMember(position: number, event: Event) {
    const select = event.currentTarget as HTMLSelectElement;
    const name = select.value;
    if (!name) return;
    // Find the descriptor so we know whether this is a method or a property.
    const prevType = chainTypeAt(chain, position - 1);
    if (prevType === null) return;
    const member = membersOf(prevType).find((m) => m.name === name);
    if (!member) return;

    let next = removeStepsFrom(chain, position);
    next = addStep(next, {
      kind: member.kind === "method" ? "method" : "property",
      name: member.name,
    });
    if (member.kind === "method" && member.lambdaParam) {
      next = setStepLambda(next, position, {
        propertyPath: ["name"],
        op: "==",
        literal: "",
        literalKind: "string",
      });
    }
    chain = next;
    // Reset the select so subsequent re-picks fire the change handler.
    select.value = "";
  }

  function updateLambda(
    stepIndex: number,
    patch: Partial<{
      propertyPath: string[];
      op: BinaryOp;
      literal: string;
      literalKind: LiteralKind;
    }>,
  ) {
    const step = chain.steps[stepIndex - 1];
    if (!step || !step.lambda) return;
    chain = setStepLambda(chain, stepIndex, { ...step.lambda, ...patch });
  }

  function noteMemberOptions(): string[] {
    // The lambda parameter is typed as the Collection's element; for the
    // common cases (notes, bookmarks) this is Note, but we also expose
    // Folder / Tag members when relevant. Since the descriptor models this
    // via `lambdaParam`, we read members of the current step's lambdaParam.
    return ["name", "path", "title", "content", "property"];
  }

  const operators: BinaryOp[] = ["==", "!=", ">", "<", ">=", "<="];
  const literalKinds: LiteralKind[] = ["string", "number", "boolean"];
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="vc-template-builder-backdrop vc-modal-scrim"
    onclick={onCancel}
    role="presentation"
  ></div>
  <div
    class="vc-template-builder vc-modal-surface"
    role="dialog"
    aria-modal="true"
    aria-label="Insert template expression"
    tabindex="-1"
    onkeydown={handleKey}
  >
    <h2 class="vc-template-builder-title">Insert template expression</h2>
    <p class="vc-template-builder-hint">
      Build a query by picking each step. The preview below shows what will be inserted.
    </p>

    <div class="vc-template-builder-chain">
      <!-- Root scope — fixed label, not a select. -->
      <span class="vc-template-builder-root">{chain.rootName}</span>

      {#each chain.steps as step, i (i)}
        <span class="vc-template-builder-dot">·</span>
        <span class="vc-template-builder-step-label">{step.name}{step.kind === "method" ? "(…)" : ""}</span>

        {#if step.lambda}
          {@const elementType = elementNameAt(chainTypeAt(chain, i) ?? "Note")}
          {@const lambdaParam = elementType === "Folder" ? "f" : elementType === "Tag" ? "t" : "n"}
          <div class="vc-template-builder-lambda">
            <span class="vc-template-builder-lambda-param">{lambdaParam} =&gt; {lambdaParam}.</span>
            <select
              class="vc-template-builder-lambda-field"
              value={step.lambda.propertyPath[0] ?? "name"}
              onchange={(e) => {
                const v = (e.currentTarget as HTMLSelectElement).value;
                updateLambda(i + 1, { propertyPath: v === "property" ? ["property", ""] : [v] });
              }}
            >
              {#each noteMemberOptions() as opt (opt)}
                <option value={opt}>{opt}</option>
              {/each}
            </select>

            {#if step.lambda.propertyPath[0] === "property"}
              {#if dynamicPropertyKeys.length > 0}
                <select
                  class="vc-template-builder-lambda-key"
                  value={step.lambda.propertyPath[1] ?? ""}
                  onchange={(e) => {
                    const k = (e.currentTarget as HTMLSelectElement).value;
                    updateLambda(i + 1, { propertyPath: ["property", k] });
                  }}
                >
                  <option value="" disabled>key…</option>
                  {#each dynamicPropertyKeys as k (k)}
                    <option value={k}>{k}</option>
                  {/each}
                </select>
              {:else}
                <input
                  class="vc-template-builder-lambda-key"
                  type="text"
                  placeholder="key"
                  value={step.lambda.propertyPath[1] ?? ""}
                  oninput={(e) => {
                    const k = (e.currentTarget as HTMLInputElement).value;
                    updateLambda(i + 1, { propertyPath: ["property", k] });
                  }}
                />
              {/if}
            {/if}

            <select
              class="vc-template-builder-lambda-op"
              value={step.lambda.op}
              onchange={(e) => {
                updateLambda(i + 1, { op: (e.currentTarget as HTMLSelectElement).value as BinaryOp });
              }}
            >
              {#each operators as op (op)}
                <option value={op}>{op}</option>
              {/each}
            </select>

            <select
              class="vc-template-builder-lambda-kind"
              value={step.lambda.literalKind}
              onchange={(e) => {
                updateLambda(i + 1, {
                  literalKind: (e.currentTarget as HTMLSelectElement).value as LiteralKind,
                });
              }}
            >
              {#each literalKinds as k (k)}
                <option value={k}>{k}</option>
              {/each}
            </select>

            {#if step.lambda.literalKind === "boolean"}
              <select
                class="vc-template-builder-lambda-literal"
                value={step.lambda.literal === "true" ? "true" : "false"}
                onchange={(e) => {
                  updateLambda(i + 1, { literal: (e.currentTarget as HTMLSelectElement).value });
                }}
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            {:else}
              <input
                class="vc-template-builder-lambda-literal"
                type={step.lambda.literalKind === "number" ? "number" : "text"}
                placeholder={step.lambda.literalKind === "string" ? "value" : "0"}
                value={step.lambda.literal}
                oninput={(e) => {
                  updateLambda(i + 1, { literal: (e.currentTarget as HTMLInputElement).value });
                }}
              />
            {/if}
          </div>
        {/if}
      {/each}

      {#if availableMembersAt(chain.steps.length + 1).length > 0}
        <span class="vc-template-builder-dot">·</span>
        <select
          class="vc-template-builder-step"
          bind:this={firstSelectEl}
          value=""
          onchange={(e) => pickMember(chain.steps.length + 1, e)}
        >
          <option value="" disabled>add step…</option>
          {#each availableMembersAt(chain.steps.length + 1) as m (m.name)}
            <option value={m.name}>{labelFor(m)}</option>
          {/each}
        </select>
      {:else}
        <span class="vc-template-builder-dead-end">(no further members)</span>
      {/if}
    </div>

    <div class="vc-template-builder-preview">
      {wrapAsTemplate(chain)}
    </div>

    <div class="vc-template-builder-actions">
      <button
        type="button"
        class="vc-template-builder-cancel"
        onclick={onCancel}
      >Cancel</button>
      <button
        type="button"
        class="vc-template-builder-insert"
        onclick={() => onInsert(renderExpression(chain))}
      >Insert</button>
    </div>
  </div>
{/if}

<style>
  .vc-template-builder-backdrop {
    z-index: 200;
  }

  .vc-template-builder {
    position: fixed;
    top: 15%;
    left: 50%;
    transform: translateX(-50%);
    width: 560px;
    max-width: calc(100vw - 32px);
    max-height: 70vh;
    z-index: 201;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
    overflow: auto;
  }

  .vc-template-builder-title {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--color-text);
  }

  .vc-template-builder-hint {
    margin: 0;
    font-size: 12px;
    color: var(--color-text-muted);
  }

  .vc-template-builder-chain {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 10px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px;
  }

  .vc-template-builder-root {
    color: var(--color-accent);
    font-weight: 600;
  }

  .vc-template-builder-dot {
    color: var(--color-text-muted);
    user-select: none;
  }

  .vc-template-builder-step-label {
    color: var(--color-text);
  }

  .vc-template-builder-step,
  .vc-template-builder-lambda-field,
  .vc-template-builder-lambda-key,
  .vc-template-builder-lambda-op,
  .vc-template-builder-lambda-kind,
  .vc-template-builder-lambda-literal {
    height: 26px;
    padding: 0 6px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: var(--color-surface);
    color: var(--color-text);
    font: inherit;
    outline: none;
  }

  .vc-template-builder-step:focus,
  .vc-template-builder-lambda-field:focus,
  .vc-template-builder-lambda-key:focus,
  .vc-template-builder-lambda-op:focus,
  .vc-template-builder-lambda-kind:focus,
  .vc-template-builder-lambda-literal:focus {
    border-color: var(--color-accent);
  }

  .vc-template-builder-lambda {
    display: flex;
    flex-basis: 100%;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    margin-left: 20px;
    padding: 6px 8px;
    background: var(--color-accent-bg);
    border-radius: 4px;
  }

  .vc-template-builder-lambda-param {
    color: var(--color-text-muted);
    user-select: none;
  }

  .vc-template-builder-dead-end {
    color: var(--color-text-muted);
    font-style: italic;
  }

  .vc-template-builder-preview {
    padding: 10px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px;
    color: var(--color-text);
    word-break: break-all;
  }

  .vc-template-builder-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .vc-template-builder-cancel,
  .vc-template-builder-insert {
    font-size: 13px;
    padding: 6px 12px;
    border-radius: 4px;
    cursor: pointer;
    border: 1px solid var(--color-border);
    background: var(--color-surface);
    color: var(--color-text);
  }

  .vc-template-builder-insert {
    background: var(--color-accent);
    color: var(--color-accent-contrast, #fff);
    border-color: var(--color-accent);
  }
</style>
