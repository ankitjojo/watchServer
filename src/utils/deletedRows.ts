/** One row of the "Deleted records" modal (partials/deletedRecords.ejs). The first cell links when `href` is set. */
export interface DeletedRowView {
  href?: string;
  cells: string[];
}
