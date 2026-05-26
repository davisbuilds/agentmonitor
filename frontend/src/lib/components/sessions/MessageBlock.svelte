<script lang="ts">
  import type { Message, ContentBlock } from '../../api/client';
  import { formatTimeOfDay, agentDisplayName } from '../../format';
  import { parseSessionText } from '../../session-text';
  import { classifyMessageAuthor } from '../../session-roles';
  import { Badge } from '../ui';

  interface Props {
    message: Message;
    agent?: string;
    highlighted?: boolean;
    pinned?: boolean;
    pinning?: boolean;
    onpin?: (() => void) | undefined;
    onunpin?: (() => void) | undefined;
  }
  let {
    message,
    agent = 'unknown',
    highlighted = false,
    pinned = false,
    pinning = false,
    onpin,
    onunpin,
  }: Props = $props();

  let blocks = $derived.by<ContentBlock[]>(() => {
    try {
      return JSON.parse(message.content);
    } catch {
      return [{ type: 'text', text: message.content }];
    }
  });

  let thinkingExpanded = $state(false);
  let toolExpanded = $state<Record<string, boolean>>({});

  function toggleTool(id: string) {
    toolExpanded = { ...toolExpanded, [id]: !toolExpanded[id] };
  }

  // Shared classifier keeps the label in sync with the viewer's author filter.
  const author = $derived(classifyMessageAuthor(message));
  const roleLabel = $derived(
    author === 'tool' ? 'Tool' : author === 'you' ? 'You' : agentDisplayName(agent),
  );
  // You = the one interactive accent; assistant = ok; tool output = neutral.
  const roleColor = $derived(
    author === 'tool' ? 'text-text-muted' : author === 'you' ? 'text-accent' : 'text-ok',
  );
  const borderColor = $derived(
    author === 'tool' ? 'border-line' : author === 'you' ? 'border-accent/30' : 'border-ok/30',
  );

  function togglePin() {
    if (pinning) return;
    if (pinned) {
      onunpin?.();
      return;
    }
    onpin?.();
  }
</script>

<div
  class={`rounded-r-sm border-l-2 px-3 py-2 transition-colors ${
    borderColor
  } ${
    highlighted ? 'bg-accent/5 ring-1 ring-accent/20' : ''
  }`}
  data-message-ordinal={message.ordinal}
>
  <!-- Role header -->
  <div class="mb-1 flex items-center gap-2">
    <span class="text-meta font-medium {roleColor}">{roleLabel}</span>
    {#if message.timestamp}
      <span class="tabular font-mono text-meta text-text-faint">{formatTimeOfDay(message.timestamp)}</span>
    {/if}
    {#if message.has_thinking}
      <Badge tone="neutral">thinking</Badge>
    {/if}
    {#if message.has_tool_use}
      <Badge tone="neutral">tools</Badge>
    {/if}
    {#if onpin || onunpin}
      <button
        type="button"
        class={`ml-auto rounded-sm border px-2 py-0.5 text-meta transition-colors ${
          pinned
            ? 'border-warn/40 bg-warn/10 text-warn hover:border-warn'
            : 'border-line text-text-muted hover:border-line-strong hover:text-text'
        } ${pinning ? 'cursor-wait opacity-70' : ''}`}
        disabled={pinning}
        onclick={togglePin}
      >
        {pinning ? 'Saving…' : pinned ? 'Pinned' : 'Pin'}
      </button>
    {/if}
  </div>

  <!-- Content blocks -->
  {#each blocks as block, i}
    {#if block.type === 'text' && block.text}
      {@const parsedText = parseSessionText(block.text)}
      {#if parsedText?.kind === 'caveat'}
        <div class="rounded-sm border border-accent/30 bg-accent/10 px-3 py-2 text-meta text-accent">
          Local command transcript follows. Claude marked this output as contextual-only unless explicitly requested.
        </div>
      {:else if parsedText?.kind === 'command'}
        <div class="rounded-sm border border-line bg-surface-2 px-3 py-2">
          <div class="mb-1 text-meta uppercase tracking-wide text-text-faint">Local Command</div>
          <div class="font-mono text-body text-text">{parsedText.name || parsedText.message}</div>
          {#if parsedText.args}
            <div class="mt-1 whitespace-pre-wrap break-words text-meta text-text-muted">{parsedText.args}</div>
          {/if}
        </div>
      {:else if parsedText?.kind === 'output'}
        <div class="rounded-sm border border-line bg-surface-2 px-3 py-2">
          <div class="mb-1 text-meta uppercase tracking-wide {parsedText.stream === 'stderr' ? 'text-danger' : 'text-text-faint'}">
            {parsedText.stream}
          </div>
          <div class="whitespace-pre-wrap break-words text-body leading-relaxed text-text-muted">
            {parsedText.text || '(no output)'}
          </div>
        </div>
      {:else}
        <div class="whitespace-pre-wrap break-words text-body leading-relaxed text-text">
          {parsedText?.text || block.text}
        </div>
      {/if}

    {:else if block.type === 'thinking' && block.thinking}
      <div class="my-1">
        <button
          class="text-meta text-text-muted transition-colors hover:text-text"
          onclick={() => thinkingExpanded = !thinkingExpanded}
        >
          {thinkingExpanded ? '▾' : '▸'} Thinking ({block.thinking.length} chars)
        </button>
        {#if thinkingExpanded}
          <div class="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-sm bg-surface-2 p-2 text-meta text-text-muted">
            {block.thinking}
          </div>
        {/if}
      </div>

    {:else if block.type === 'tool_use' && block.name}
      <div class="my-1 rounded-sm border border-line bg-surface-2 p-2">
        <button
          class="flex items-center gap-1 text-meta text-text-muted transition-colors hover:text-text"
          onclick={() => toggleTool(block.id || String(i))}
        >
          <span>{toolExpanded[block.id || String(i)] ? '▾' : '▸'}</span>
          <span class="font-mono text-text">{block.name}</span>
        </button>
        {#if toolExpanded[block.id || String(i)] && block.input}
          <pre class="mt-1 max-h-48 overflow-x-auto overflow-y-auto text-meta text-text-muted">{JSON.stringify(block.input, null, 2)}</pre>
        {/if}
      </div>

    {:else if block.type === 'tool_result'}
      <div class="my-1 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-sm bg-surface-2 p-2 text-meta {block.is_error ? 'text-danger' : 'text-text-muted'}">
        {block.content || '(empty result)'}
      </div>
    {/if}
  {/each}
</div>
