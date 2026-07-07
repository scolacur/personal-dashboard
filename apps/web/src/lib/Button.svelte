<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';

  type Props = Omit<HTMLButtonAttributes, 'children'> & {
    variant: 'primary' | 'ghost' | 'icon';
    accent?: boolean;
    children: Snippet;
  };

  let {
    variant,
    type = 'button',
    disabled = false,
    title,
    accent = false,
    children,
    ...rest
  }: Props = $props();
</script>

<button
  class="btn btn-{variant}"
  class:accent
  {type}
  {disabled}
  {title}
  {...rest}
>
  {@render children()}
</button>

<style lang="scss" src="./Button.scss"></style>
