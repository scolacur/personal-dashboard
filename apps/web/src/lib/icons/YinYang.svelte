<script lang="ts">
  // Dashboard logo / mobile nav toggle. Reuses the real yin-yang app icon —
  // the same image installed as the iPhone home-screen shortcut
  // (static/apple-touch-icon.png, served from the site root).
  let { size = 22 }: { size?: number } = $props();
</script>

<img
  src="/apple-touch-icon.png"
  alt="Da Steve Zone"
  width={size}
  height={size}
  style="border-radius: 50%; display: block;"
/>
