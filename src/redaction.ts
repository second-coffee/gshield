const AUTH_PATTERNS = [
  /\b(one[ -]?time\s*(passcode|password|code)|otp|verification\s*code|security\s*code|login\s*code|2fa|mfa|two[ -]?factor|authentication\s*code)\b/i,
  /\b(password\s*reset|reset\s*your\s*password|sign[- ]?in\s*attempt|confirm\s*it['’]?s\s*you|approve\s+sign[- ]?in)\b/i,
  /\b(magic\s*link|verify\s*(your\s*)?email|passkey|device\s*verification|account\s*verification)\b/i
];

export function classifyAuthSensitive(text = ''): boolean {
  return AUTH_PATTERNS.some((p) => p.test(text));
}

export function redactSecrets(text = ''): string {
  return text
    .replace(/\b\d{4,8}\b/g, '[REDACTED_CODE]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .replace(/https?:\/\/\S+/gi, '[REDACTED_URL]');
}
