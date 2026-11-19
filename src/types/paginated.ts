export interface Paginated<T> {
  items: T[];
  /** Opaque keyset cursor; absent on the last page. */
  nextCursor?: string;
}
