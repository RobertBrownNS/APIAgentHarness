import type { Mailbox, MailMessage } from "./types";

export class MailboxImpl implements Mailbox {
  private boxes = new Map<string, MailMessage[]>();
  private listeners = new Set<(m: MailMessage) => void>();

  send(m: MailMessage): void {
    const box = this.boxes.get(m.to) ?? [];
    box.push({ ...m });
    this.boxes.set(m.to, box);
    for (const l of [...this.listeners]) {
      try {
        l(m);
      } catch {
        /* a listener must not break delivery */
      }
    }
  }

  drain(agent: string): MailMessage[] {
    const box = this.boxes.get(agent) ?? [];
    this.boxes.delete(agent);
    return box;
  }

  /** Drop waiting messages for this agent that match. */
  removeWhere(agent: string, pred: (m: MailMessage) => boolean): void {
    const box = this.boxes.get(agent);
    if (box) this.boxes.set(agent, box.filter((m) => !pred(m)));
  }

  pending(agent: string): number {
    return this.boxes.get(agent)?.length ?? 0;
  }

  onDeliver(listener: (m: MailMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.boxes.clear();
  }
}
