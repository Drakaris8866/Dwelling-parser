export const normalizeSourceImageUrl = (value: string): string => {
  const url = new URL(value, "https://rms.kufar.by/");
  if (url.hostname === "rms.kufar.by" && /^\/adim\d+\//.test(url.pathname)) url.pathname = `/v1/list_thumbs_2x${url.pathname}`;
  return url.toString();
};
