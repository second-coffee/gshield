import { execFile } from 'node:child_process';
import type { EmailItem } from './types.ts';

function execFileAsync(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${err.message}: ${stderr || ''}`));
      resolve(stdout);
    });
  });
}

export interface Provider {
  getUnreadEmails(days: number): Promise<EmailItem[]>;
  getCalendarEvents(timeMin: string, timeMax: string): Promise<any[]>;
  sendReply(input: { threadId: string; to: string; subject: string; body: string }): Promise<{ id: string }>;
  sendNew(input: { to: string; subject: string; body: string }): Promise<{ id: string }>;
}

export class GogProvider implements Provider {
  constructor(private account: string, private calendarId: string) {}

  async getUnreadEmails(days: number): Promise<EmailItem[]> {
    const stdout = await execFileAsync('gog', ['gmail', 'search', `in:inbox is:unread newer_than:${days}d`, '--account', this.account]);
    try {
      const parsed = JSON.parse(stdout);
      return Array.isArray(parsed) ? parsed : (parsed.messages || []);
    } catch {
      return stdout.split('\n').filter(Boolean).map((line, i) => ({ id: `line-${i}`, threadId: `line-${i}`, subject: line, snippet: line }));
    }
  }

  async getCalendarEvents(timeMin: string, timeMax: string): Promise<any[]> {
    const stdout = await execFileAsync('gog', ['calendar', 'list-events', '--account', this.account, '--calendar', this.calendarId, '--timeMin', timeMin, '--timeMax', timeMax]);
    try {
      const parsed = JSON.parse(stdout);
      return Array.isArray(parsed) ? parsed : (parsed.items || []);
    } catch {
      return [];
    }
  }

  async sendReply(input: { threadId: string; to: string; subject: string; body: string }): Promise<{ id: string }> {
    const stdout = await execFileAsync('gog', ['gmail', 'reply', '--thread', input.threadId, '--to', input.to, '--subject', input.subject, '--body', input.body, '--account', this.account]);
    return { id: stdout.trim() || `reply-${Date.now()}` };
  }

  async sendNew(input: { to: string; subject: string; body: string }): Promise<{ id: string }> {
    const stdout = await execFileAsync('gog', ['gmail', 'send', '--to', input.to, '--subject', input.subject, '--body', input.body, '--account', this.account]);
    return { id: stdout.trim() || `send-${Date.now()}` };
  }
}

export class MockProvider implements Provider {
  constructor(private seed: { emails?: EmailItem[]; events?: any[] } = {}) {}
  async getUnreadEmails(): Promise<EmailItem[]> { return this.seed.emails || []; }
  async getCalendarEvents(): Promise<any[]> { return this.seed.events || []; }
  async sendReply(): Promise<{ id: string }> { return { id: 'reply-mock' }; }
  async sendNew(): Promise<{ id: string }> { return { id: 'send-mock' }; }
}
