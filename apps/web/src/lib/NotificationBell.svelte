<script lang="ts">
  import { onMount } from 'svelte';
  import { Bell } from 'lucide-svelte';
  import type { AgentNotification } from '@dashboard/shared';
  import {
    fetchNotifications,
    fetchUnreadCount,
    markNotificationRead,
    markAllNotificationsRead,
  } from './notifications-api';

  let unread = $state(0);
  let open = $state(false);
  let items = $state<AgentNotification[]>([]);
  let loading = $state(false);
  let rootRef = $state<HTMLElement | null>(null);

  // The dropdown shows only the most recent few; the full history lives at /notifications.
  const DROPDOWN_LIMIT = 10;

  async function refreshCount() {
    try {
      unread = await fetchUnreadCount();
    } catch {
      // transient — leave the last known count
    }
  }

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
    if (n.readAt !== null) return;
    try {
      await markNotificationRead(n.id);
      items = items.map((x) => (x.id === n.id ? { ...x, readAt: Date.now() } : x));
      unread = Math.max(0, unread - 1);
    } catch {
      // ignore — navigation still proceeds
    }
  }

  async function markAll() {
    try {
      await markAllNotificationsRead();
      const now = Date.now();
      items = items.map((n) => ({ ...n, readAt: n.readAt ?? now }));
      unread = 0;
    } catch {
      // ignore
    }
  }

  function onWindowClick(e: MouseEvent) {
    if (open && rootRef && !rootRef.contains(e.target as Node)) open = false;
  }

  onMount(() => {
    refreshCount();
    const timer = setInterval(refreshCount, 60000);
    return () => clearInterval(timer);
  });
</script>

<svelte:window onclick={onWindowClick} />

<div class="notif-root" bind:this={rootRef}>
  <button class="notif-bell" onclick={toggle} aria-label="Notifications" aria-expanded={open}>
    <Bell size={16} />
    {#if unread > 0}<span class="notif-badge">{unread > 99 ? '99+' : unread}</span>{/if}
  </button>

  {#if open}
    <div class="notif-panel" role="dialog" aria-label="Notifications">
      <div class="notif-head">
        <span>Notifications</span>
        <button class="notif-markall" onclick={markAll} disabled={unread === 0}>Mark all read</button>
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
