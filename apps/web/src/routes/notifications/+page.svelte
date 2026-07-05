<script lang="ts">
  import type { AgentNotification } from '@dashboard/shared';
  import {
    fetchNotifications,
    markNotificationRead,
    markAllNotificationsRead,
  } from '$lib/notifications-api';
  import { refreshUnreadCount } from '$lib/notifications-store';

  let items = $state<AgentNotification[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let unreadOnly = $state(false);

  async function load() {
    loading = true;
    error = null;
    try {
      items = await fetchNotifications({ unreadOnly });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function onItemRead(n: AgentNotification) {
    if (n.readAt !== null) return;
    try {
      await markNotificationRead(n.id);
      items = items.map((x) => (x.id === n.id ? { ...x, readAt: Date.now() } : x));
      if (unreadOnly) items = items.filter((x) => x.id !== n.id);
      await refreshUnreadCount(); // keep the nav bell badge in sync
    } catch {
      // navigation still proceeds
    }
  }

  async function markAll() {
    try {
      await markAllNotificationsRead();
      if (unreadOnly) items = [];
      else {
        const now = Date.now();
        items = items.map((n) => ({ ...n, readAt: n.readAt ?? now }));
      }
      await refreshUnreadCount(); // keep the nav bell badge in sync
    } catch {
      // ignore
    }
  }

  function fmt(ts: number): string {
    return new Date(ts).toLocaleString();
  }

  // Reload on mount and whenever the unread filter flips.
  $effect(() => {
    void unreadOnly;
    load();
  });

  const anyUnread = $derived(items.some((n) => n.readAt === null));
</script>

<header class="notif-page-head">
  <h1>Notifications</h1>
  <div class="notif-page-actions">
    <label class="notif-filter">
      <input type="checkbox" bind:checked={unreadOnly} />
      Unread only
    </label>
    <button onclick={markAll} disabled={!anyUnread}>Mark all read</button>
  </div>
</header>

{#if loading}
  <p class="muted">Loading…</p>
{:else if error}
  <p class="error" role="alert">{error}</p>
{:else if items.length === 0}
  <p class="muted">{unreadOnly ? 'No unread notifications.' : 'Nothing here yet.'}</p>
{:else}
  <ul class="notif-page-list">
    {#each items as n (n.id)}
      <li class="notif-page-item" class:unread={n.readAt === null}>
        {#if n.ticketDisplayId}
          <a
            class="notif-page-link"
            href="/task-monitor/tickets/{n.ticketDisplayId}"
            onclick={() => onItemRead(n)}
          >
            <span class="notif-page-title">{n.title}</span>
            {#if n.body}<span class="notif-page-body">{n.body}</span>{/if}
            <span class="notif-page-time">{fmt(n.createdAt)}</span>
          </a>
        {:else}
          <button class="notif-page-link" onclick={() => onItemRead(n)}>
            <span class="notif-page-title">{n.title}</span>
            {#if n.body}<span class="notif-page-body">{n.body}</span>{/if}
            <span class="notif-page-time">{fmt(n.createdAt)}</span>
          </button>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style lang="scss" src="./+page.scss"></style>
