export const sanitizeHttpUrl = (value: string): string => {
  const url = new URL(value.trim());
  url.hostname = url.hostname.replace(/\.+$/, "");
  return url.toString();
};

export const redactSensitiveUrl = (value: string): string =>
  value
    .replace(/\/bot[^/]+/i, "/bot[redacted]")
    .replace(/([?&](?:token|api_key|apikey|key)=)[^&]+/gi, "$1[redacted]");
