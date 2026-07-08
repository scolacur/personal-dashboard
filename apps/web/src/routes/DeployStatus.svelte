<script lang="ts">
  import { formatRelativeTime } from './deploy-status-utils';

  interface DeployInfo {
    sha: string | null;
    startedAt: number;
    commitMessage: string | null;
    commitDate: string | null;
    workflowRunUrl: string | null;
  }

  let info = $state<DeployInfo | null>(null);
  let loaded = $state(false);
  let now = $state(Date.now());

  $effect(() => {
    fetch('/api/deploy-info')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: DeployInfo | null) => {
        info = data;
      })
      .catch(() => {})
      .finally(() => {
        loaded = true;
      });

    const timer = setInterval(() => {
      now = Date.now();
    }, 60_000);

    return () => clearInterval(timer);
  });

  function deployLink(deployInfo: DeployInfo): string {
    if (deployInfo.workflowRunUrl) return deployInfo.workflowRunUrl;
    return `https://github.com/scolacur/personal-dashboard/commit/${deployInfo.sha}`;
  }
</script>

{#if loaded && info === null}
  <p class="deploy-empty">No recent deployment info.</p>
{:else if info}
  <div class="deploy-status">
    <span class="item">
      <span class="label">Deployed</span>
      <span class="value">{formatRelativeTime(info.startedAt, now)}</span>
    </span>
    {#if info.sha}
      <span class="sep">·</span>
      <span class="item">
        <span class="label">Commit</span>
        <a class="value sha" href={deployLink(info)} target="_blank" rel="noopener noreferrer">
          {info.sha}
        </a>
        {#if info.commitMessage}
          <span class="commit-msg">{info.commitMessage}</span>
        {/if}
      </span>
    {/if}
  </div>
{/if}

<style lang="scss" src="./DeployStatus.scss"></style>
