import type { AgentProject, AgentTicket } from '@dashboard/shared';

export function buildCopyText(ticket: AgentTicket, project?: AgentProject): string {
  const label = ticket.displayId ?? project?.key ?? '';
  const header = label ? `**[${label}] ${ticket.title}**` : `**${ticket.title}**`;
  return ticket.body ? `${header}\n\n${ticket.body}` : header;
}

// navigator.clipboard requires a secure context (HTTPS / localhost).
// Fall back to the legacy execCommand approach for plain-HTTP LAN access.
export async function copyToClipboard(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const el = document.createElement('textarea');
  el.value = text;
  el.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(el);
  el.focus();
  el.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(el);
  if (!ok) throw new Error('copy failed');
}
