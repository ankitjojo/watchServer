/** Host part of a MongoDB URI for logging. Credentials and path are never returned. */
export function uriHost(uri: string): string {
  const match = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/.exec(uri);
  return match?.[1] ?? 'unknown';
}
