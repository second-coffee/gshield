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
  calendar: { id: string };
  policy: {
    email: {
      maxRecentDays: number;
      returnSensitiveAuth: boolean;
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
