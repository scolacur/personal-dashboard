<script lang="ts">
  import { onMount } from 'svelte';
  import { Bell } from 'lucide-svelte';
  import type { AgentNotification } from '@dashboard/shared';
  import { fetchNotifications, markNotificationRead, markAllNotificationsRead } from './notifications-api';
  import { unreadCount, refreshUnreadCount } from './notifications-store';

  let open = $state(false);
  let items = $state<AgentNotification[]>([]);
  let loading = $state(false);
  let rootRef = $state<HTMLElement | null>(null);

  // The dropdown shows only the most recent few; the full history lives at /notifications.
  const DROPDOWN_LIMIT = 10;

  async function loadList() {
    loading = true;
    try {
      items = await fetchNotifications({ limit: DROPDOWN_LIMIT });
    } catch {
      // leave the current list
    } finally {
      loading = false;
    }
  }

  async function toggle() {
    open = !open;
    if (open) await loadList();
  }

  async function onItemClick(n: AgentNotification) {
    open = false;
    if (n.readAt !== null) return;
    try {
      await markNotificationRead(n.id);
      items = items.map((x) => (x.id === n.id ? { ...x, readAt: Date.now() } : x));
      await refreshUnreadCount();
    } catch {
      // ignore — navigation still proceeds
    }
  }

  async function markAll() {
    try {
      await markAllNotificationsRead();
      const now = Date.now();
      items = items.map((n) => ({ ...n, readAt: n.readAt ?? now }));
      await refreshUnreadCount();
    } catch {
      // ignore
    }
  }

  function onWindowClick(e: MouseEvent) {
    if (open && rootRef && !rootRef.contains(e.target as Node)) open = false;
  }

  onMount(() => {
    // Refresh on mount + when the tab regains focus, plus a slow poll as a backstop.
    refreshUnreadCount();
    const onFocus = () => refreshUnreadCount();
    window.addEventListener('focus', onFocus);
    const timer = setInterval(refreshUnreadCount, 60000);
    return () => {
      window.removeEventListener('focus', onFocus);
      clearInterval(timer);
    };
  });
</script>

<svelte:window onclick={onWindowClick} />

<div class="notif-root" bind:this={rootRef}>
  <button class="notif-bell" onclick={toggle} aria-label="Notifications" aria-expanded={open}>
    <Bell size={16} />
    {#if $unreadCount > 0}<span class="notif-badge">{$unreadCount > 99 ? '99+' : $unreadCount}</span>{/if}
  </button>

  {#if open}
    <div class="notif-panel" role="dialog" aria-label="Notifications">
      <div class="notif-head">
        <span>Notifications</span>
        <button class="notif-markall" onclick={markAll} disabled={$unreadCount === 0}>Mark all read</button>
      </div>
      {#if loading}
        <p class="notif-empty">Loading…</p>
      {:else if items.length === 0}
        <p class="notif-empty">Nothing here yet.</p>
      {:else}
        <ul class="notif-list">
          {#each items as n (n.id)}
            <li class="notif-item" class:unread={n.readAt === null}>
              {#if n.ticketDisplayId}
                <a
                  class="notif-link"
                  href="/task-monitor/tickets/{n.ticketDisplayId}"
                  onclick={() => onItemClick(n)}
                >
                  <span class="notif-title">{n.title}</span>
                  {#if n.body}<span class="notif-body">{n.body}</span>{/if}
                </a>
              {:else}
                <button class="notif-link" onclick={() => onItemClick(n)}>
                  <span class="notif-title">{n.title}</span>
                  {#if n.body}<span class="notif-body">{n.body}</span>{/if}
                </button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
      <a class="notif-viewall" href="/notifications" onclick={() => (open = false)}>
        View all notifications
      </a>
    </div>
  {/if}
</div>

<style lang="scss" src="./NotificationBell.scss"></style>
