export const CRM_PEOPLE_PAGE_SIZE = 100;

export interface CrmPeoplePage<T> {
  readonly items: readonly T[];
  readonly pageNumber: number;
  readonly pageCount: number;
  readonly firstItemNumber: number;
  readonly lastItemNumber: number;
  readonly totalItems: number;
}

export function paginateCrmPeople<T>(items: readonly T[], requestedPage: number): CrmPeoplePage<T> {
  const pageCount = Math.max(1, Math.ceil(items.length / CRM_PEOPLE_PAGE_SIZE));
  const normalizedPage = Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 1;
  const pageNumber = Math.min(pageCount, Math.max(1, normalizedPage));
  const start = (pageNumber - 1) * CRM_PEOPLE_PAGE_SIZE;
  const pageItems = items.slice(start, start + CRM_PEOPLE_PAGE_SIZE);
  return {
    items: pageItems,
    pageNumber,
    pageCount,
    firstItemNumber: pageItems.length === 0 ? 0 : start + 1,
    lastItemNumber: start + pageItems.length,
    totalItems: items.length,
  };
}
