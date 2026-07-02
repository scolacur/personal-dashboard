<script lang="ts">
  let { size = 16 }: { size?: number } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 16 16"
  fill="none"
  stroke="currentColor"
  stroke-width="1.5"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  <path d="M2 4h12" />
  <path d="M5.5 4V3a.5.5 0 01.5-.5h4a.5.5 0 01.5.5v1" />
  <path d="M3 4l.75 9a1 1 0 001 1h6.5a1 1 0 001-1L13 4" />
  <path d="M6 7v4M10 7v4" />
</svg>
