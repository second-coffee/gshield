export type WrapperConfig = {
  server: {
    port: number;
    bind: string;
    maxPayloadBytes: number;
    rateLimitPerMinute: number;
  };
  auth: {
    apiKey: string;
    tokenSigningKey: string;
    previousTokenSigningKey?: string;
    tokenTtlSeconds: number;
  };
  gmail: { account: string };
  calendar: { ids: string[] };
  policy: {
    email: {
      maxRecentDays: number;
      authHandlingMode: 'block' | 'warn';
      threadContextMode: 'full_thread' | 'latest_only';
    };
    calendar: {
      defaultThisWeek: boolean;
      maxPastDays: number;
      maxFutureDays: number;
    };
    outbound: {
      replyOnlyDefault: boolean;
      recipientAllowlist: string[];
      domainAllowlist: string[];
      maxSendsPerHour: number;
      maxSendsPerDay: number;
    };
  };
};

export type EmailItem = {
  id: string;
  threadId: string;
  from?: string;
  to?: string;
  subject?: string;
  snippet?: string;
  body?: string;
  internalDate?: string;
};

export type CalendarEvent = {
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
};
