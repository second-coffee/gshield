import { execFile } from 'node:child_process';
import type { CalendarEvent, EmailItem } from './types.ts';

function execFileAsync(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${err.message}: ${stderr || ''}`));
      resolve(stdout);
    });
  });
}

function looksLikeEmailItem(v: any): v is EmailItem {
  return !!v && typeof v === 'object' && typeof v.id === 'string' && typeof v.threadId === 'string';
}

export function parseEmailOutput(stdout: string): EmailItem[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    const arr = Array.isArray(parsed) ? parsed : (parsed.messages || parsed.items || []);
    return Array.isArray(arr) ? arr.filter(looksLikeEmailItem) : [];
  } catch {
    // Safe fallback: only accept JSONL-like lines, never plain text lines as synthetic emails.
    return trimmed
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(looksLikeEmailItem);
  }
}

function looksLikeCalendarEvent(v: any): v is CalendarEvent {
  return !!v && typeof v === 'object' && typeof v.id === 'string';
}

function parseCalendarOutput(stdout: string): CalendarEvent[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    const arr = Array.isArray(parsed) ? parsed : (parsed.items || []);
    return Array.isArray(arr) ? arr.filter(looksLikeCalendarEvent) : [];
  } catch {
    return [];
  }
}

export interface Provider {
  getUnreadEmails(days: number): Promise<EmailItem[]>;
  getCalendarEvents(timeMin: string, timeMax: string, calendarIds?: string[]): Promise<CalendarEvent[]>;
  sendReply(input: { threadId: string; to: string; subject: string; body: string }): Promise<{ id: string }>;
  sendNew(input: { to: string; subject: string; body: string }): Promise<{ id: string }>;
  createEvent(input: {
    calendarId: string; summary: string;
    start: string; end: string;
    attendees?: string[]; location?: string;
    sendUpdates?: string;
  }): Promise<{ id: string }>;
  updateEvent(input: {
    calendarId: string; eventId: string;
    summary?: string; start?: string; end?: string;
    addAttendees?: string[]; location?: string;
    sendUpdates?: string;
  }): Promise<{ id: string }>;
}

export class GogProvider implements Provider {
  constructor(private account: string, private calendarIds: string[]) {}

  async getUnreadEmails(days: number): Promise<EmailItem[]> {
    const stdout = await execFileAsync('gog', ['gmail', 'search', `in:inbox is:unread newer_than:${days}d`, '--account', this.account]);
    return parseEmailOutput(stdout);
  }

  async getCalendarEvents(timeMin: string, timeMax: string, calendarIds?: string[]): Promise<CalendarEvent[]> {
    const ids = (calendarIds && calendarIds.length > 0 ? calendarIds : this.calendarIds).filter(Boolean);
    const uniqueIds = [...new Set(ids)];
    const all = await Promise.all(uniqueIds.map(async (calendarId) => {
      const stdout = await execFileAsync('gog', ['calendar', 'list-events', '--account', this.account, '--calendar', calendarId, '--timeMin', timeMin, '--timeMax', timeMax]);
      return parseCalendarOutput(stdout);
    }));
    return all.flat();
  }

  async sendReply(input: { threadId: string; to: string; subject: string; body: string }): Promise<{ id: string }> {
    const stdout = await execFileAsync('gog', ['gmail', 'reply', '--thread', input.threadId, '--to', input.to, '--subject', input.subject, '--body', input.body, '--account', this.account]);
    return { id: stdout.trim() || `reply-${Date.now()}` };
  }

  async sendNew(input: { to: string; subject: string; body: string }): Promise<{ id: string }> {
    const stdout = await execFileAsync('gog', ['gmail', 'send', '--to', input.to, '--subject', input.subject, '--body', input.body, '--account', this.account]);
    return { id: stdout.trim() || `send-${Date.now()}` };
  }

  async createEvent(input: {
    calendarId: string; summary: string;
    start: string; end: string;
    attendees?: string[]; location?: string;
    sendUpdates?: string;
  }): Promise<{ id: string }> {
    const args = ['calendar', 'create', input.calendarId, '--summary', input.summary, '--from', input.start, '--to', input.end, '--account', this.account];
    if (input.attendees?.length) args.push('--attendees', input.attendees.join(','));
    if (input.location) args.push('--location', input.location);
    if (input.sendUpdates) args.push('--send-updates', input.sendUpdates);
    const stdout = await execFileAsync('gog', args);
    return { id: stdout.trim() || `event-${Date.now()}` };
  }

  async updateEvent(input: {
    calendarId: string; eventId: string;
    summary?: string; start?: string; end?: string;
    addAttendees?: string[]; location?: string;
    sendUpdates?: string;
  }): Promise<{ id: string }> {
    const args = ['calendar', 'update', input.calendarId, input.eventId, '--account', this.account];
    if (input.summary) args.push('--summary', input.summary);
    if (input.start) args.push('--from', input.start);
    if (input.end) args.push('--to', input.end);
    if (input.addAttendees?.length) {
      for (const a of input.addAttendees) args.push('--add-attendee', a);
    }
    if (input.location) args.push('--location', input.location);
    if (input.sendUpdates) args.push('--send-updates', input.sendUpdates);
    const stdout = await execFileAsync('gog', args);
    return { id: stdout.trim() || input.eventId };
  }
}

export class MockProvider implements Provider {
  constructor(private seed: { emails?: EmailItem[]; events?: CalendarEvent[] } = {}) {}
  async getUnreadEmails(_days: number): Promise<EmailItem[]> { return this.seed.emails || []; }
  async getCalendarEvents(_timeMin: string, _timeMax: string, _calendarIds?: string[]): Promise<CalendarEvent[]> { return this.seed.events || []; }
  async sendReply(_input: { threadId: string; to: string; subject: string; body: string }): Promise<{ id: string }> { return { id: 'reply-mock' }; }
  async sendNew(_input: { to: string; subject: string; body: string }): Promise<{ id: string }> { return { id: 'send-mock' }; }
  async createEvent(_input: { calendarId: string; summary: string; start: string; end: string; attendees?: string[]; location?: string; sendUpdates?: string }): Promise<{ id: string }> { return { id: 'event-mock' }; }
  async updateEvent(_input: { calendarId: string; eventId: string; summary?: string; start?: string; end?: string; addAttendees?: string[]; location?: string; sendUpdates?: string }): Promise<{ id: string }> { return { id: _input.eventId || 'update-mock' }; }
}
