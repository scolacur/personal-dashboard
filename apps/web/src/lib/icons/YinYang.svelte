<script lang="ts">
  let { size = 24 }: { size?: number } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 100 100"
  aria-hidden="true"
  focusable="false"
  xmlns="http://www.w3.org/2000/svg"
>
  <!-- Dark (yin) half: left semicircle + S-curve -->
  <path
    d="M50,0 A50,50,0,0,0,50,100 A25,25,0,0,1,50,50 A25,25,0,0,0,50,0 Z"
    fill="currentColor"
  />
  <!-- Light (yang) half: right semicircle + S-curve -->
  <path
    d="M50,0 A50,50,0,0,1,50,100 A25,25,0,0,0,50,50 A25,25,0,0,1,50,0 Z"
    fill="var(--bg)"
  />
  <!-- Dark dot in light half -->
  <circle cx="50" cy="75" r="8.33" fill="currentColor" />
  <!-- Light dot in dark half -->
  <circle cx="50" cy="25" r="8.33" fill="var(--bg)" />
  <!-- Outer ring -->
  <circle cx="50" cy="50" r="48" fill="none" stroke="currentColor" stroke-width="4" />
</svg>
