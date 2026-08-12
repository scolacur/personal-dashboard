<script lang="ts">
  import { pickupList, type BstListing } from '@dashboard/shared';
  import Collapsible from '$lib/Collapsible.svelte';

  // "Where they are" — the private pickup list, grouped so a sold item can be found.
  //
  // Moved here from inside the drafts panel. It was co-located with the drafts on the reasoning
  // that the post says *what* is for sale and this says where to go and find it — still true, and
  // it is why the drafts modal is a fair second home. But it is a property of the list, not of a
  // rendered post, so it belongs beside the list.
  //
  // **Never part of a post** (D-065): `location` is private. This renders it beside the gear
  // tables, not into any draft.
  let { listings }: { listings: BstListing[] } = $props();

  const pickups = $derived(pickupList(listings));
</script>

{#if pickups.length > 0}
  <Collapsible title="Where they are" count={pickups.length} open={false} storeKey="bst-pickup">
    <ul class="pickup-list">
      {#each pickups as p (p.item + p.location)}
        <li>
          <span class="pickup-item">{p.item}</span>
          <span class="pickup-where">{p.location}</span>
        </li>
      {/each}
    </ul>
  </Collapsible>
{/if}

<style lang="scss" src="./PickupList.scss"></style>
